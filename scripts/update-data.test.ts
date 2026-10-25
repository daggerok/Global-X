/// <reference types="bun" />
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTROL_NAMES,
  NO_RETURNS_BASIS,
  OFFICIAL_RETURNS_BASIS,
  extractNextFlightText,
  fetchWithRetry,
  formatGlobalXDate,
  globalxEdgarFilingsUrl,
  globalxFundPageUrl,
  globalxHoldingsCsvUrl,
  holdingsGuard,
  horizonValue,
  installSystemCa,
  isGlobalXFundInLiquidation,
  isCertError,
  keepPublishedAmountPrecision,
  main,
  parseGlobalXDistributionHistory,
  parseGlobalXDistributionInfo,
  parseGlobalXDocuments,
  parseGlobalXFundDetails,
  parseGlobalXHoldingsCsv,
  parseGlobalXLineup,
  parseGlobalXPerformanceSection,
  parseNportXml,
  parseYahooChart,
  passesDataFilters,
  paymentsPerYear,
  positiveYieldOrNull,
  readConfig,
  resolveControls,
  runtimeControls,
  sameSeries,
  sanitizeTicker,
  setFetchTuningForTests,
  withMetricsContract,
  writeIfChanged,
  yahooChartUrl,
} from "./update-data.ts";

// Shared hygiene: pinned zone, no inherited control variables, restored globals
const savedFetch = globalThis.fetch;
const savedError = console.error;
const savedLog = console.log;
const savedTz = process.env.TZ;
const savedEnv = { ...process.env };
const configFile = () => JSON.parse(readFileSync(new URL("./update-data.config.json", import.meta.url), "utf8"));
const dirs: string[] = [];
const fresh = () => { const d = mkdtempSync(join(tmpdir(), "globalx-")); dirs.push(d); return d; };

beforeEach(() => {
  process.env.TZ = "UTC";
  for (const name of [...CONTROL_NAMES, "GITHUB_STEP_SUMMARY", "HISTORICAL_PAGE_SIZE"]) delete process.env[name];
  for (const name of Object.keys(process.env)) if (name.startsWith("GLOBALX_")) delete process.env[name];
});
afterEach(() => {
  globalThis.fetch = savedFetch;
  console.error = savedError;
  console.log = savedLog;
  process.exitCode = 0;
  setFetchTuningForTests(45_000, 1500);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const name of Object.keys(process.env)) if (!(name in savedEnv)) delete process.env[name];
  Object.assign(process.env, savedEnv);
  if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz;
});

function flightHtml(chunks: string[]): string {
  return `<script>self.__next_f.push([1,${JSON.stringify(chunks.join("\n"))}])</script>`;
}
// One panel row of the 2026-10 fund page: a label span, then a data-card-value span
const li = (label: string, value: string) => `["$","li",${JSON.stringify(label)},{"children":[["$","span",null,{"className":"text-xs font-semibold text-muted-foreground","children":${JSON.stringify(label)}}],["$","span","data-card-value-0",{"className":"v","children":${JSON.stringify(value)}}]]}]`;
const metricCard = (label: string, value: string) => `["$","div","distribution-history-metric-card-${label}-undefined-0",{"children":[["$","p",null,{"children":[${JSON.stringify(label)},false]}],["$","p",null,{"className":"font-bold","children":${JSON.stringify(value)}}]]}]`;
const lineupRows = (rows: object[]) => flightHtml([`5:["$","$L5b",null,{"rows":${JSON.stringify(rows)}}]`]);

describe("controls", () => {
  test("precedence is file < advanced < nonblank input < env, blank input inherits", () => {
    const c = resolveControls({ CONCURRENCY: 2, TICKERS: "PAVE" }, { CONCURRENCY: 3, TICKERS: "AIQ" }, { CONCURRENCY: "4", TICKERS: "" }, { CONCURRENCY: "5" });
    expect([c.CONCURRENCY, c.TICKERS]).toEqual(["5", "AIQ"]);
    expect(resolveControls({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }, { CONCURRENCY: "4" }).CONCURRENCY).toBe("4");
    expect(resolveControls({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }).CONCURRENCY).toBe("3");
    expect(resolveControls({ CONCURRENCY: 2 }, {}, { CONCURRENCY: "" }).CONCURRENCY).toBe("2");
    expect(resolveControls({ TICKERS: "PAVE" }, { TICKERS: "" }, { TICKERS: "" }).TICKERS).toBe("");
    expect(resolveControls({ SKIP_YAHOO: true }, {}, {}, { SKIP_YAHOO: "false" }).SKIP_YAHOO).toBe("false");
  });

  test("scheduled path equals the config defaults, keys match CONTROL_NAMES, return filters default to ':'", () => {
    const defaults = configFile();
    expect(resolveControls(defaults, {}, {}, {})).toEqual(Object.fromEntries(Object.entries(defaults).map(([k, v]) => [k, String(v)])));
    expect(Object.keys(defaults).sort()).toEqual([...CONTROL_NAMES].sort());
    for (const [key, value] of Object.entries(defaults)) if (/^(PERFORMANCE|TOTAL_RETURN)_/.test(key)) expect(value).toBe(":");
    expect(defaults.SEC_UA).toBe("daggerok ETF feed daggerok@gmail.com");
  });

  test("config defaults parse into the documented runtime values", async () => {
    const config = readConfig(resolveControls(configFile()));
    expect(config).toMatchObject({ tickers: [], maxFetches: 0, requestSleep: 2, concurrency: 2, holdingsPageSize: 250, historyPageSize: 1000, maxRetries: 3, historyRange: "max", storeRawDownloads: false, edgarFallback: false, skipYahoo: false, skipGlobalX: false });
    expect(config.aumRange).toBeUndefined();
    expect((await runtimeControls({})).REQUEST_SLEEP).toBe(String(configFile().REQUEST_SLEEP));
    expect((await runtimeControls({ REQUEST_SLEEP: "0", TICKERS: "PAVE" })).TICKERS).toBe("PAVE");
  });

  test.each([
    ["unknown key", { UNKNOWN: 1 }], ["LF injection", { SEC_UA: "x\nEVIL=yes" }], ["CR injection", { SEC_UA: "x\rfoo" }],
    ["CONCURRENCY 0", { CONCURRENCY: 0 }], ["MAX_RETRIES 0", { MAX_RETRIES: 0 }], ["MAX_RETRIES -1", { MAX_RETRIES: -1 }],
    ["fractional MAX_FETCHES", { MAX_FETCHES: 1.5 }], ["negative REQUEST_SLEEP", { REQUEST_SLEEP: "-1" }], ["bad boolean", { VERBOSE: "maybe" }],
    ["bad range", { AUM: "1:2:3" }], ["reversed range", { TER: "2:1" }], ["array TICKERS", { TICKERS: ["PAVE"] }], ["object TICKERS", { TICKERS: { a: 1 } }],
    ["bad USE_SYSTEM_CA", { USE_SYSTEM_CA: "maybe" }], ["bad HISTORY_RANGE", { HISTORY_RANGE: "6mo" }],
  ])("strict validation rejects %s", (_name, advanced) => {
    expect(() => resolveControls({}, advanced as any)).toThrow();
  });

  test("strict validation rejects non-object input, NUL in env, bad tickers and bad HISTORY_RANGE", () => {
    for (const value of [null, []]) expect(() => resolveControls(value as any)).toThrow();
    expect(() => resolveControls({}, [] as any)).toThrow();
    expect(() => resolveControls({}, {}, {}, { SEC_UA: "x\0bad" })).toThrow();
    expect(() => readConfig({ TICKERS: "PAVE, ???" })).toThrow();
    expect(readConfig({ TICKERS: "pave;aiq" }).tickers).toEqual(["PAVE", "AIQ"]);
    const now = Date.parse("2026-10-02T00:00:00Z");
    for (const bad of ["6mo", "ytd", "0y", "-1y", "abc", "5"]) {
      expect(() => resolveControls(configFile(), {}, {}, { HISTORY_RANGE: bad })).toThrow();
      expect(() => yahooChartUrl("SIL", bad, now)).toThrow();
    }
    expect(readConfig(resolveControls(configFile(), {}, {}, { HISTORY_RANGE: "10Y" })).historyRange).toBe("10y");
  });

  test("USE_SYSTEM_CA is case-insensitive and brand and legacy env aliases work", () => {
    for (const mode of ["auto", "true", "false"]) expect(resolveControls(configFile(), {}, {}, { USE_SYSTEM_CA: mode.toUpperCase() }).USE_SYSTEM_CA).toBe(mode);
    expect(resolveControls(configFile()).USE_SYSTEM_CA).toBe("auto");
    expect(resolveControls(configFile(), {}, {}, { GLOBALX_CONCURRENCY: "7" }).CONCURRENCY).toBe("7");
    expect(resolveControls(configFile(), {}, {}, { GLOBALX_CONCURRENCY: "7", CONCURRENCY: "3" }).CONCURRENCY).toBe("7");
    expect(resolveControls(configFile(), {}, {}, { GLOBALX_TICKERS: "" }).TICKERS).toBe("");
    expect(() => resolveControls(configFile(), {}, {}, { GLOBALX_CONCURRENCY: "0" })).toThrow();
    expect(resolveControls({}, {}, {}, { HISTORICAL_PAGE_SIZE: "500" }).HISTORY_PAGE_SIZE).toBe("500");
    expect(resolveControls({}, {}, {}, { HISTORICAL_PAGE_SIZE: "500", HISTORY_PAGE_SIZE: "600" }).HISTORY_PAGE_SIZE).toBe("600");
  });

  test("system CA handling: cert errors are detected and auto mode re-executes once", async () => {
    expect(isCertError({ code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" })).toBe(true);
    expect(isCertError(new Error("fetch failed", { cause: new Error("unable to get local issuer certificate") }))).toBe(true);
    expect(isCertError({ code: "ECONNRESET", message: "socket hang up" })).toBe(false);
    console.error = () => {};
    let calls = 0;
    const reexec = (): never => { calls += 1; return undefined as never; };
    globalThis.fetch = (async () => new Response("ok")) as unknown as typeof fetch;
    const plain = globalThis.fetch;
    installSystemCa("false", reexec, false);
    installSystemCa("auto", reexec, true);
    expect(globalThis.fetch).toBe(plain);
    installSystemCa("true", reexec, false);
    expect(calls).toBe(1);
    const errors = [Object.assign(new Error("fetch failed"), { code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" }), new Error("ECONNRESET"), null];
    let i = 0;
    globalThis.fetch = (async () => { const e = errors[i++]; if (e) throw e; return new Response("ok"); }) as unknown as typeof fetch;
    installSystemCa("auto", reexec, false);
    await globalThis.fetch("https://example.invalid/");
    expect(calls).toBe(2);
    await expect(globalThis.fetch("https://example.invalid/")).rejects.toThrow("ECONNRESET");
    expect(await (await globalThis.fetch("https://example.invalid/")).text()).toBe("ok");
    expect(calls).toBe(2);
  });
});

describe("parsing", () => {
  test("N-PORT fallback: positions, report date and series are read (element text and value attributes)", () => {
    const xml = `<edgarSubmission><repPdDate>2026-06-30</repPdDate><seriesName>Global X &amp; Co Test ETF</seriesName>
      <invstOrSec><name>Acme Corp</name><cusip>000111222</cusip><balance>1500</balance><valUSD>3000.50</valUSD><pctVal>1.25</pctVal><assetCat>EC</assetCat>
      <identifiers><ticker value="ACME"/></identifiers></invstOrSec>
      <invstOrSec><name>No Numbers</name><cusip>N/A</cusip><assetCat>DBT</assetCat></invstOrSec></edgarSubmission>`;
    const parsed = parseNportXml(xml);
    expect(parsed).toMatchObject({ repPdDate: "2026-06-30", seriesName: "Global X & Co Test ETF" });
    expect(parsed.positions).toHaveLength(2);
    expect(parsed.positions[0]).toEqual({ name: "Acme Corp", ticker: "ACME", cusip: "000111222", balance: 1500, valueUsd: 3000.5, percent: 1.25, assetCategory: "EC" });
    expect(parsed.positions[1]).toMatchObject({ balance: null, valueUsd: null, percent: null });
  });

  test("catalog: the 2026-10 client table rows are read, missing values become null", () => {
    const rows = lineupRows([
      { ticker: "SMRZ", name: "Small Modular Reactor ETF", netAssetsValue: 876142.74, grossExpensesValue: 0.75, netExpensesValue: 0.75, distributionRateValue: null, inceptionDate: "Oct 14, 2026", inceptionDateValue: 1791936000000, hierarchyNames: ["Equity", "Thematic", "Disruptive Technology"], distributionFrequency: "Semi-Annually" },
      { ticker: "QYLD", name: "Nasdaq 100 Covered Call ETF", netAssetsValue: null, grossExpensesValue: 0.61, netExpensesValue: 0.6, distributionRateValue: 12.1, inceptionDateValue: null, inceptionDate: "Dec 11, 2013", hierarchyNames: ["Income"], distributionFrequency: "Monthly" },
    ]);
    expect(extractNextFlightText(rows)).toContain('"ticker":"SMRZ"');
    const funds = parseGlobalXLineup(rows);
    expect(funds.map((f) => f.ticker)).toEqual(["SMRZ", "QYLD"]);
    expect(funds[0]).toMatchObject({ category: "Equity / Thematic", managementFee: 0.75, grossExpense: 0.75, netAssets: 876142.74, inceptionDate: "2026-10-14", distributionRate: null, frequency: "Semi-Annually" });
    expect(funds[1]).toMatchObject({ category: "Income", managementFee: 0.6, grossExpense: 0.61, netAssets: null, inceptionDate: "2013-12-11", distributionRate: 12.1 });
  });

  test("fund page (2026-10): panels, prices, returns, distribution cards and history, documents, holdings date", () => {
    const html = flightHtml([
      '1:["$","div",null,{"children":[["$","h3",null,{"children":"Fund Details"}],["$","p",null,{"className":"text-xs","children":"As of Oct 16, 2026"}]]}]',
      `2:[${[li("Ticker", "PAVE"), li("Inception Date", "03/06/17"), li("Net Assets", "$$13.57 billion"), li("Shares Outstanding", "257,030,000"), li("Primary Exchange", "Cboe BZX"), li("CUSIP", "37954Y673"), li("ISIN", "US37954Y6730"), li("30-Day Median Bid-Ask Spread", "-"), li("Distribution Frequency", "Semi-Annually"), li("NAV", "$$52.80"), li("Daily Change", "-$0.40 / -0.75%")].join(",")}]`,
      '3:["$","$Lce",null,{"data":{"asOf":"Oct 16, 2026","latest":{"nav":52.8,"marketPrice":52.81,"premiumDiscountPct":0.0189}}}]',
      '4:["$","$L9e",null,{"data":{"avgAnnualized":[{"cadence":"month-end","asOf":"Sep 30, 2026","columns":[{"key":"ONE_YEAR"},{"key":"TEN_YEAR"}],"rows":[{"label":"Fund NAV","values":["+18.64%","-"]},{"label":"Market Price","values":["+18.60%","-"]},{"label":"Index","values":["+19.00%","-"]}]}],"cumulative":[{"cadence":"month-end","asOf":"Sep 30, 2026","columns":[{"key":"YTD"}],"rows":[{"label":"Fund NAV","values":["+14.60%"]}]},{"cadence":"quarter-end","asOf":"Jun 30, 2026","columns":[{"key":"YTD"}],"rows":[{"label":"Fund NAV","values":["+23.40%"]}]}]}}]',
      `5:${metricCard("30-Day SEC Yield", "0.50%")}`,
      '6:["$","div","distribution-history-metric-card-Distribution Rate-2-1",{"children":["$L7","$L8"]}]',
      '7:["$","p",null,{"children":["Distribution Rate",false]}]',
      '8:["$","p",null,{"className":"font-bold","children":"0.00%"}]',
      '9:["$","$Le9",null,{"distributions":[{"exDate":"Dec 30, 2026","recordDate":"Dec 30, 2026","payableDate":"Jan 5, 2027","amount":"-"},{"exDate":"Jun 29, 2026","recordDate":"Jun 29, 2026","payableDate":"Jul 2, 2026","amount":"$$0.10"}]}]',
      // a text row (T + hex byte length) is followed by the next row on the same line
      'a:T5,hellob:["$","$L81",null,{"documents":[{"name":"Summary Prospectus","fileType":"PDF","file":{"url":"//assets.ctfassets.net/x/Summary-Prospectus.pdf"}},{"name":"Proxy Voting","fileType":"","url":"https://www.sec.gov/x"}]}]',
      'c:["$","$Lcd",null,{"ticker":"PAVE","fileName":"PAVE-holdings-Oct-16-2026.csv"}]',
    ]);
    expect(parseGlobalXFundDetails(html)).toMatchObject({ cusip: "37954Y673", isin: "US37954Y6730", inceptionDate: "2017-03-06", netAssets: 13570000000, sharesOutstanding: 257030000, primaryExchange: "Cboe BZX", netAssetValue: 52.8, marketPrice: 52.81, navDailyChangeValue: -0.4, navDailyChangePercent: -0.75, premiumDiscount: 0.0189, bidAskSpread: null, asOfDate: "2026-10-16" });
    expect(parseGlobalXDistributionInfo(html)).toMatchObject({ frequency: "Semi-Annually", secYield: 0.5, distributionRate: null, trailingRate12M: null });
    expect(parseGlobalXDistributionHistory(html, new Date("2026-10-02T00:00:00Z"))).toEqual([{ "Declaration Date": "", "Ex-Div Date": "2026-06-29", "Record Date": "2026-06-29", "Payable Date": "2026-07-02", "Amount ($)": "$0.10" }]);
    expect(parseGlobalXDistributionHistory(html, new Date("2027-02-01T00:00:00Z"))[0]["Amount ($)"]).toBe("");
    const monthly = parseGlobalXPerformanceSection(html, "monthly-performance");
    expect(monthly).toMatchObject({ asOfDate: "2026-09-30", nav: { yr1: 18.64, yr10: null, ytd: 14.6, mo6: null }, market: { ONE_YEAR: 18.6, TEN_YEAR: null }, benchmarkName: "Index" });
    expect(parseGlobalXPerformanceSection(html, "quarterly-performance")).toMatchObject({ asOfDate: "2026-06-30", nav: { ytd: 23.4, yr1: null } });
    expect(parseGlobalXDocuments(html)).toMatchObject({ summaryProspectus: "https://assets.ctfassets.net/x/Summary-Prospectus.pdf", prospectus: null });
    expect(globalxHoldingsCsvUrl("PAVE", html)).toBe("https://assets.globalxetfs.com/funds/holdings/pave_full-holdings_20261016.csv");
  });

  test("distributions: a published 0 rate is null, exact published amounts survive the page's rounding, cadence maps to payments", () => {
    const info = parseGlobalXDistributionInfo(flightHtml([`1:[${metricCard("Distribution Rate", "11.34%")},${metricCard("Trailing 12-Month Distribution (%)", "12.26%")},${metricCard("30-Day SEC Yield", "0.00%")},${metricCard("Distribution Frequency", "Monthly")}]`]));
    expect(info).toMatchObject({ distributionRate: 11.34, trailingRate12M: 12.26, secYield: 0, frequency: "Monthly" });
    expect(parseGlobalXDistributionInfo(flightHtml(['1:{"children":"nothing"}']))).toBeNull();
    const row = (exDate: string, amount: string) => ({ "Declaration Date": "", "Ex-Div Date": exDate, "Record Date": exDate, "Payable Date": exDate, "Amount ($)": amount });
    const kept = keepPublishedAmountPrecision([row("2026-06-29", "$0.16"), row("2026-07-20", "$0.18"), row("2026-08-24", "$0.18")], [row("2026-06-29", "$0.155500"), row("2026-07-20", "$0.170000")]);
    expect(kept.map((r) => r["Amount ($)"])).toEqual(["$0.155500", "$0.18", "$0.18"]);
    expect(keepPublishedAmountPrecision([row("2026-06-29", "$0.16")], null)[0]["Amount ($)"]).toBe("$0.16");
    expect([positiveYieldOrNull(0), positiveYieldOrNull("0"), positiveYieldOrNull(4.2)]).toEqual([null, null, 4.2]);
    expect([paymentsPerYear("Semi-Annually"), paymentsPerYear("semi-annual"), paymentsPerYear("Quarterly"), paymentsPerYear("Monthly")]).toEqual([2, 2, 4, 12]);
  });

  test("holdings CSV: dated seven-column download", () => {
    const csv = `Global X U.S. Infrastructure Development ETF\nFund Holdings Data as of 09/25/2026\n% of Net Assets,Ticker,Name,SEDOL,Market Price ($),Shares Held,Market Value ($)\n0.02,,CASH,,1.00,"413,416.71","413,416.71"\n3.65,DE,DEERE & CO,2261203,690.46,"714,766.00","493,517,332.36"`;
    const parsed = parseGlobalXHoldingsCsv(csv);
    expect(parsed.asOfDate).toBe("2026-09-25");
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toMatchObject({ Name: "CASH", "Asset Category": "Cash", Weight: "0.02%" });
    expect(parsed.rows[1]).toMatchObject({ Ticker: "DE", Identifier: "2261203", "Market Value": "493,517,332.36" });
  });

  test('holdings guard: header-only, renamed weight column, broken weights, a bad weight sum and a halved sheet are rejected', () => {
    const headers = ['Name', 'Ticker', 'Weight'];
    const rows = [{ Name: 'A', Ticker: 'A', Weight: '60%' }, { Name: 'B', Ticker: 'B', Weight: '40%' }];
    expect(holdingsGuard(headers, rows, 2)).toBeNull();
    expect(holdingsGuard(headers, [['A', 'A', '60'], ['B', 'B', '40']], null)).toBeNull();
    expect(holdingsGuard([], [], 0)).toBeNull(); // nothing published before: an empty sheet is honest
    expect(holdingsGuard(headers, [], 505)).toContain('no holdings rows');
    expect(holdingsGuard(['Name', 'Ticker', 'Wt'], rows, 2)).toContain('no weight column');
    expect(holdingsGuard(headers, rows.map((row) => ({ ...row, Weight: '6\u200B0' })), 2)).toContain('numeric weight');
    const allocation = [{ Name: 'Cash&Collateral', Ticker: '-', Weight: '100' }, { Name: 'Equities', Ticker: '-', Weight: '476' }];
    expect(holdingsGuard(headers, allocation, 2)).toContain('outside 50..150');
    expect(holdingsGuard(headers, allocation, 2, ['sum'])).toBeNull();
    expect(holdingsGuard(headers, rows, 5)).toContain('less than half');
  });

  test("urls, tickers, Yahoo adjusted close, dates and N-PORT series matching", () => {
    expect(globalxEdgarFilingsUrl()).toContain("CIK=0001432353");
    expect(globalxEdgarFilingsUrl()).toContain("type=NPORT-P");
    expect(globalxFundPageUrl("pave")).toBe("https://www.globalxetfs.com/funds/pave/");
    expect(globalxHoldingsCsvUrl("PAVE")).toBe("https://assets.globalxetfs.com/funds/holdings/pave_full-holdings.csv");
    expect(sanitizeTicker(" pave ")).toBe("PAVE");
    const parsed = parseYahooChart({ chart: { result: [{ timestamp: [1790899200], indicators: { quote: [{ close: [53.46999], volume: [100] }], adjclose: [{ adjclose: [53.461999] }] }, events: { dividends: {} } }] } });
    expect(parsed.history[0].adjClose).toBe(53.46);
    expect(formatGlobalXDate("2026-01-06")).toBe("Jan 06 2026");
    expect(sameSeries("Global X Silver Miners ETF", "Silver Miners ETF")).toBe(true);
    expect(sameSeries("Global X Uranium ETF", "Silver Miners ETF")).toBe(false);
    expect(sameSeries(null, "Silver Miners ETF")).toBe(false);
  });
});

describe("metrics", () => {
  test("a row without metrics gets null numbers, a basis and null performanceAsOf, last in key order", () => {
    const row = withMetricsContract({ ticker: "NEW", holdings: 0 });
    expect(row.metrics.ytd).toBeNull();
    expect(row.metrics.tr10y).toBeNull();
    expect(row.metrics.returnsBasis).toBe(NO_RETURNS_BASIS);
    expect(row.metrics.performanceAsOf).toBeNull();
    expect(Object.keys(row.metrics).slice(-2)).toEqual(["returnsBasis", "performanceAsOf"]);
    expect(row.metrics.dividendYieldBasis).toBeNull();
  });

  test("performanceAsOf is the performance table date, never the NAV date, with a fixed key set", () => {
    const row = withMetricsContract({ nav: { asOfDate: "Sep 25 2026" }, returns: { monthEnd: { asOfDate: "Aug 31 2026" } }, metrics: { ytd: 6.6, returnsBasis: "-", dividendYieldText: "0.89%" } });
    expect(row.metrics.performanceAsOf).toBe("2026-08-31");
    expect(row.metrics.returnsBasis).toBe(OFFICIAL_RETURNS_BASIS);
    expect(Object.keys(row.metrics)).toEqual(["ytd", "dividendYieldText", "tr1y", "tr3y", "tr5y", "tr10y", "cagr3y", "cagr5y", "cagr10y", "siAnn", "dividendYield", "secYield", "dividendYieldBasis", "returnsBasis", "performanceAsOf"]);
  });

  test("dividendYieldBasis is the official distribution rate code exactly when dividendYield is a number, same keys on every row", async () => {
    expect(withMetricsContract({ metrics: { dividendYield: 2.5 } }).metrics.dividendYieldBasis).toBe("official-distribution-rate");
    expect(withMetricsContract({ metrics: { dividendYield: null, dividendYieldBasis: "official-distribution-rate" } }).metrics.dividendYieldBasis).toBeNull();
    const dir = fresh(); installMock(() => [{ ticker: "AAA", name: "Alpha Index ETF" }, { ticker: "BBB", name: "Beta Index ETF", divYield: 0 }, { ticker: "LLM", name: "LLM ETF", pageOk: false }]); quiet();
    await run(dir);
    const rows = Object.fromEntries(index(dir).funds.map((f: any) => [f.ticker, f]));
    expect([rows.AAA.metrics.dividendYield, rows.AAA.metrics.dividendYieldBasis]).toEqual([2.5, "official-distribution-rate"]);
    expect([rows.BBB.metrics.dividendYield, rows.BBB.metrics.dividendYieldBasis]).toEqual([null, null]);
    expect(rows.LLM.dataFile).toBeNull();
    expect(rows.LLM.metrics.dividendYieldBasis).toBeNull();
    const meta = JSON.parse(readFileSync(join(dir, "funds", "AAA", "meta.json"), "utf8"));
    expect(meta.metrics.dividendYieldBasis).toBe("official-distribution-rate");
    const keys = Object.keys(rows.AAA.metrics);
    expect(Object.keys(rows.BBB.metrics)).toEqual(keys);
    expect(Object.keys(rows.LLM.metrics).slice(-3)).toEqual(["dividendYieldBasis", "returnsBasis", "performanceAsOf"]);
    // a retained row (failed page) keeps the yield together with its code
    installMock(() => [{ ticker: "AAA", name: "Alpha Index ETF", pageOk: false }, { ticker: "BBB", name: "Beta Index ETF", divYield: 0 }]);
    await run(dir);
    const kept = index(dir).funds.find((f: any) => f.ticker === "AAA");
    expect([kept.metrics.dividendYield, kept.metrics.dividendYieldBasis]).toEqual([2.5, "official-distribution-rate"]);
  });

  test("compliant metrics are kept and the contract is idempotent", () => {
    const once = withMetricsContract({ metrics: { ytd: 1, returnsBasis: "custom", performanceAsOf: "2026-07-31" } });
    expect(once.metrics).toMatchObject({ returnsBasis: "custom", performanceAsOf: "2026-07-31" });
    expect(withMetricsContract(once)).toEqual(once);
  });

  test("returns longer than the fund age are null, siAnn needs one year", () => {
    expect(horizonValue(5, "2026-01-06", "2026-08-31", 1)).toBeNull();
    expect(horizonValue(5, "2025-08-30", "2026-08-31", 1)).toBe(5);
    expect(horizonValue(7, "2022-11-21", "2026-08-31", 5)).toBeNull();
    expect(horizonValue(7, "", "2026-08-31", 5)).toBe(7);
    expect(horizonValue(null, "2010-01-01", "2026-08-31", 5)).toBeNull();
  });
});

// Offline pipeline helpers: main() against a mocked globalxetfs.com and Yahoo
type MockFund = { ticker: string; name: string; net?: number | null; gross?: number | null; divYield?: number; pageOk?: boolean; yahooOk?: boolean; ten?: number; liquidation?: boolean; csvOk?: boolean };

function lineupPage(funds: MockFund[]): string {
  return lineupRows(funds.map((fund) => ({ ticker: fund.ticker, name: fund.name, netAssetsValue: 1000000000, grossExpensesValue: fund.gross ?? 0.6, netExpensesValue: fund.net === null ? null : (fund.net ?? 0.5), distributionRateValue: null, inceptionDateValue: Date.UTC(2015, 2, 6), hierarchyNames: ["Equity", "Thematic"], distributionFrequency: "Semi-Annually" })));
}

function fundPage(fund: MockFund): string {
  const ten = fund.ten === undefined ? "-" : `+${(fund.ten * 100).toFixed(2)}%`;
  return flightHtml([
    '1:["$","div",null,{"children":[["$","h3",null,{"children":"Fund Details"}],["$","p",null,{"className":"text-xs","children":"As of Sep 25, 2026"}]]}]',
    `2:[${[li("CUSIP", "37954Y673"), li("ISIN", "US37954Y6730"), li("Inception Date", "03/06/15"), li("Net Assets", "$$1.00 billion"), li("Shares Outstanding", "1,000,000"), li("Primary Exchange", "Cboe BZX"), li("Distribution Frequency", "Semi-Annually"), li("NAV", "$$10.50")].join(",")}]`,
    `3:["$","$L9e",null,{"data":{"avgAnnualized":[{"cadence":"month-end","asOf":"Aug 31, 2026","columns":[{"key":"ONE_YEAR"},{"key":"THREE_YEAR"},{"key":"FIVE_YEAR"},{"key":"TEN_YEAR"},{"key":"SINCE_INCEPTION"}],"rows":[{"label":"Fund NAV","values":["+20.00%","+15.00%","+10.00%",${JSON.stringify(ten)},"+8.00%"]}]}],"cumulative":[{"cadence":"month-end","asOf":"Aug 31, 2026","columns":[{"key":"YTD"}],"rows":[{"label":"Fund NAV","values":["+10.00%"]}]}]}}]`,
    `4:[${metricCard("30-Day SEC Yield", "1.50%")},${metricCard("Distribution Rate", `${fund.divYield ?? 2.5}%`)}]`,
    '5:["$","$Le9",null,{"distributions":[{"exDate":"Dec 30, 2999","recordDate":"Dec 30, 2999","payableDate":"Dec 31, 2999","amount":"-"},{"exDate":"Jun 29, 2026","recordDate":"Jun 29, 2026","payableDate":"Jul 7, 2026","amount":"$$0.25"}]}]',
    `6:["$","$Lcd",null,{"ticker":"${fund.ticker}","fileName":"${fund.ticker}-holdings-Sep-25-2026.csv"}]`,
    ...(fund.liquidation ? ['s:{"className":"block text-sea text-2xl mb-6","children":["In Liquidation",["$","sup",null,{"children":"^"}]]}'] : []),
  ]);
}

const HOLDINGS_CSV = 'Fund Holdings Data as of 09/25/2026\n% of Net Assets,Ticker,Name,SEDOL,Market Price ($),Shares Held,Market Value ($)\n50.00,AAA,AAA CORP,123,10.00,"100.00","1,000.00"\n50.00,BBB,BBB CORP,456,10.00,"100.00","1,000.00"\n';

function yahooJson(close = 10): unknown {
  return { chart: { result: [{ timestamp: [1790380800, 1790467200], indicators: { quote: [{ close: [close, close + 1], volume: [100, 200] }], adjclose: [{ adjclose: [close, close + 1] }] }, events: { dividends: {} }, meta: { exchangeName: 'PCX' } }] } };
}

function installMock(funds: () => MockFund[], hooks: { delayMs?: number; failYahoo?: Set<string>; calls?: string[] } = {}) {
  const original = globalThis.fetch;
  const state = { inFlight: 0, peak: 0, calls: hooks.calls ?? ([] as string[]) };
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    state.calls.push(url);
    state.inFlight += 1;
    state.peak = Math.max(state.peak, state.inFlight);
    try {
      if (hooks.delayMs) await new Promise((resolve) => setTimeout(resolve, hooks.delayMs));
      if (url === 'https://www.globalxetfs.com/explore') return new Response(lineupPage(funds()));
      const fundMatch = /globalxetfs\.com\/funds\/([a-z]+)\/?$/.exec(url);
      if (fundMatch) {
        const fund = funds().find((f) => f.ticker.toLowerCase() === fundMatch[1]);
        if (!fund || fund.pageOk === false) return new Response('blocked', { status: 500 });
        return new Response(fundPage(fund));
      }
      if (url.includes('assets.globalxetfs.com')) {
        const fund = funds().find((f) => url.includes(`/holdings/${f.ticker.toLowerCase()}_full-holdings`));
        if (fund?.csvOk === false) return new Response('<Error>NoSuchKey</Error>', { status: 404 });
        return new Response(HOLDINGS_CSV);
      }
      if (url.includes('finance.yahoo.com')) {
        const ticker = /chart\/([A-Z]+)\?/.exec(url)![1];
        if (hooks.failYahoo?.has(ticker)) return new Response('no', { status: 404 });
        return new Response(JSON.stringify(yahooJson()));
      }
      return new Response('not mocked', { status: 404 });
    } finally {
      state.inFlight -= 1;
    }
  }) as unknown as typeof fetch;
  return { state, restore: () => { globalThis.fetch = original; } };
}

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full); else out[full.slice(dir.length)] = readFileSync(full, 'utf8');
    }
  };
  walk(dir);
  return out;
}

const THREE: MockFund[] = [{ ticker: 'AAA', name: 'Alpha Index ETF' }, { ticker: 'BBB', name: 'Beta Index ETF' }, { ticker: 'CCC', name: 'Gamma Index ETF' }];
const ENV = { USE_SYSTEM_CA: 'false', REQUEST_SLEEP: '0', MAX_RETRIES: '1', CONCURRENCY: '2' };

async function run(dir: string, env: Record<string, string> = {}, options: { deadlineMs?: number } = {}) {
  setFetchTuningForTests(2_000, 1);
  await main({ ...ENV, ...env }, { apiRoot: dir, ...options });
}
const index = (dir: string) => JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
const quiet = () => { console.log = () => {}; };

describe("pipeline", () => {
  test("a full run publishes every fund with one metrics key set, TEN_YEAR and net vs gross TER", async () => {
    const dir = fresh(); installMock(() => THREE.map((f) => ({ ...f, ten: 0.0836 }))); quiet();
    await run(dir);
    const idx = index(dir);
    expect(idx.funds.map((f: any) => f.ticker)).toEqual(["AAA", "BBB", "CCC"]);
    for (const f of idx.funds) {
      expect(f.dataFile).toBe(`./funds/${f.ticker}/meta.json`);
      expect(existsSync(join(dir, "funds", f.ticker, "meta.json"))).toBe(true);
      expect([f.terValue, f.terGrossValue]).toEqual([0.5, 0.6]);
      expect(Object.keys(f.metrics)).toEqual(Object.keys(idx.funds[0].metrics));
      expect(f.metrics.returnsBasis.length).toBeGreaterThan(0);
    }
    expect(idx.funds[0].metrics.cagr10y).toBe(8.36);
    const meta = JSON.parse(readFileSync(join(dir, "funds", "AAA", "meta.json"), "utf8"));
    expect(meta.distributions.paymentsPerYear).toBe(2);
    expect(meta.distributions.rows.map((r: any) => r["Ex-Div Date"])).toEqual(["2026-06-29"]);
    expect(readdirSync(dir, { recursive: true } as any).some((name: any) => String(name).includes(".tmp-"))).toBe(false);
  });

  test("console output: config with TICKERS=all, one catalog line, fund lines, two done lines from the reporter", async () => {
    const dir = fresh(); installMock(() => THREE);
    const lines: string[] = [];
    console.log = (line: unknown) => { lines.push(...String(line).split("\n")); };
    await run(dir);
    expect(lines).toContain("              TICKERS=all");
    expect(lines.filter((line) => line.startsWith("[ catalog  ] "))).toEqual(["[ catalog  ] 3 Global X ETFs (globalxetfs.com Explore Our ETFs table)"]);
    expect(lines.some((line) => line === "")).toBe(false);
    expect(lines.filter((line) => /^\[ +\d+\/3 +\] /.test(line))).toHaveLength(3);
    expect(lines.at(-2)).toMatch(/^\[ done {5}\] 3 funds: 3 updated, 0 unchanged, 0 kept, 0 skipped, 0 failed in \d+\.\ds$/);
    expect(lines.at(-1)).toBe("[ done     ] counts: 3 funds / 6 holdings rows / 6 history rows");
    lines.length = 0;
    await run(dir);
    expect(lines.at(-2)).toMatch(/ 3 funds: 0 updated, 3 unchanged, /);
  });

  test("a second identical run writes nothing, even generatedAt", async () => {
    const dir = fresh(); installMock(() => THREE); quiet();
    await run(dir);
    const first = snapshot(dir);
    await new Promise((resolve) => setTimeout(resolve, 1100)); // generatedAt has second resolution
    await run(dir);
    expect(snapshot(dir)).toEqual(first);
  });

  test("two runs on the same source data write zero changes even when Yahoo adjusted closes jitter across a cent boundary", async () => {
    // Yahoo float32 noise seen live: AAM SPDV 2024-11-12 came back as 31.544998 and 31.545001 a minute apart
    const dir = fresh(); installMock(() => THREE);
    const base = globalThis.fetch;
    const jittered = (adjclose: number[]) => {
      globalThis.fetch = (async (input: any, init?: RequestInit) => {
        if (!String(input).includes("finance.yahoo.com")) return base(input, init);
        const payload = yahooJson() as any;
        payload.chart.result[0].indicators.adjclose = [{ adjclose }];
        return new Response(JSON.stringify(payload));
      }) as unknown as typeof fetch;
    };
    const lines: string[] = [];
    console.log = (line: unknown) => { lines.push(String(line)); };
    jittered([9.915001, 10.984999]);
    await run(dir);
    const first = snapshot(dir);
    expect(JSON.parse(first["/funds/AAA/history/001.json"]).rows.map((r: any) => r["Adj Close"])).toEqual(["10.98", "9.92"]);
    jittered([9.914998, 10.985002]);
    lines.length = 0;
    await run(dir);
    expect(snapshot(dir)).toEqual(first);
    expect(lines.some((line) => / 3 funds: 0 updated, 3 unchanged, /.test(line))).toBe(true);
    // a real change beyond the noise is still written
    jittered([9.9, 10.97]);
    await run(dir);
    expect(JSON.parse(readFileSync(join(dir, "funds", "AAA", "history", "001.json"), "utf8")).rows.map((r: any) => r["Adj Close"])).toEqual(["10.97", "9.90"]);
  });

  test("a one-ticker run keeps every row and leaves other funds untouched; unknown ticker is an error", async () => {
    const dir = fresh(); installMock(() => THREE); quiet();
    await run(dir);
    const before = snapshot(dir);
    await run(dir, { TICKERS: "BBB" });
    expect(index(dir).funds).toHaveLength(3);
    const after = snapshot(dir);
    for (const key of Object.keys(before)) if (!key.includes("/BBB/") && !key.endsWith("index.json")) expect(after[key]).toBe(before[key]);
    await expect(run(dir, { TICKERS: "ZZZ" })).rejects.toThrow(/not in the Global X lineup/);
  });

  test("a failed fund page keeps the fund with dataFile null and a full null metrics object", async () => {
    const dir = fresh(); installMock(() => [...THREE, { ticker: "LLM", name: "LLM ETF", pageOk: false }]); quiet();
    writeFileSync(join(dir, "index.json"), JSON.stringify({ generatedAt: "x", source: {}, counts: {}, funds: [{ ticker: "OLD", name: "Old ETF", dataFile: "./funds/OLD/meta.json", holdings: 0, history: 0 }] }));
    await run(dir);
    const rows = Object.fromEntries(index(dir).funds.map((f: any) => [f.ticker, f]));
    expect(rows.LLM.dataFile).toBeNull();
    expect(rows.OLD.dataFile).toBeNull();
    for (const key of ["ytd", "tr1y", "tr10y", "siAnn", "dividendYield", "secYield"]) expect(rows.LLM.metrics[key]).toBeNull();
    expect(rows.LLM.metrics.returnsBasis.length).toBeGreaterThan(0);
    expect(rows.AAA.dataFile).toBe("./funds/AAA/meta.json");
  });

  test("a failed Yahoo source keeps the published history, never an empty one", async () => {
    const dir = fresh(); installMock(() => THREE); quiet();
    await run(dir);
    const history = readFileSync(join(dir, "funds", "AAA", "history", "001.json"), "utf8");
    installMock(() => THREE, { failYahoo: new Set(["AAA"]) });
    await run(dir);
    expect(readFileSync(join(dir, "funds", "AAA", "history", "001.json"), "utf8")).toBe(history);
    expect(index(dir).funds[0].history).toBe(2);
  });

  test("a fund in liquidation without a holdings CSV keeps its published holdings and still updates; any other fund still fails", async () => {
    expect(isGlobalXFundInLiquidation('<span class="block text-sea text-2xl mb-6">In Liquidation<sup>^</sup></span>')).toBe(true);
    expect(isGlobalXFundInLiquidation(fundPage({ ticker: "AAA", name: "Alpha Index ETF", liquidation: true }))).toBe(true);
    expect(isGlobalXFundInLiquidation(fundPage({ ticker: "AAA", name: "Alpha Index ETF" }))).toBe(false);
    expect(isGlobalXFundInLiquidation("<p>the fund is not in liquidation</p>")).toBe(false);
    // every 2026-10 page ships the label dictionary and the notice template; only a rendered notice counts
    expect(isGlobalXFundInLiquidation(flightHtml(['0:{"liquidation.planned":"In Liquidation^","liquidation.designated":"The Fund will liquidate on or about {__date__}"}']))).toBe(false);
    expect(isGlobalXFundInLiquidation(flightHtml(['1:["$","p",null,{"children":"The Fund will liquidate on or about Nov 20, 2026"}]']))).toBe(true);
    const dir = fresh(); installMock(() => THREE); quiet();
    await run(dir);
    const holdings = readFileSync(join(dir, "funds", "AAA", "holdings", "001.json"), "utf8");
    const liquidating = () => [{ ...THREE[0], liquidation: true, csvOk: false }, { ...THREE[1], csvOk: false }, THREE[2]];
    installMock(liquidating);
    await run(dir);
    expect(readFileSync(join(dir, "funds", "AAA", "holdings", "001.json"), "utf8")).toBe(holdings);
    const meta = JSON.parse(readFileSync(join(dir, "funds", "AAA", "meta.json"), "utf8"));
    expect(meta.holdings).toMatchObject({ totalRows: 2, asOf: "2026-09-25", pages: ["./holdings/001.json"] });
    expect(meta.holdings.sourceKind).toMatch(/; kept: fund in liquidation, no current holdings CSV$/);
    expect(index(dir).funds.find((f: any) => f.ticker === "AAA").holdings).toBe(2);
    const once = snapshot(dir);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await run(dir);
    expect(snapshot(dir)).toEqual(once);
    const lines: string[] = [];
    console.log = (line: unknown) => { lines.push(String(line)); };
    await run(dir, { TICKERS: "AAA,BBB" });
    expect(lines.some((line) => /AAA/.test(line) && /unchanged/.test(line))).toBe(true);
    expect(lines.some((line) => /BBB/.test(line) && /failed/.test(line) && /HTTP 404/.test(line))).toBe(true);
  });

  test("fresh holdings that fail the guard keep the fund exactly as published and report it failed", async () => {
    const dir = fresh(); installMock(() => THREE); quiet();
    await run(dir);
    const first = snapshot(dir);
    const good = globalThis.fetch;
    const headerOnly = 'Fund Holdings Data as of 09/26/2026\n% of Net Assets,Ticker,Name,SEDOL,Market Price ($),Shares Held,Market Value ($)\n';
    const badSum = HOLDINGS_CSV.replace(/50\.00,/g, "238.00,"); // 476: an allocation summary, not a holdings sheet
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/holdings/aaa_full-holdings")) return new Response(headerOnly);
      if (url.includes("/holdings/bbb_full-holdings")) return new Response(badSum);
      return good(input, init);
    }) as unknown as typeof fetch;
    const lines: string[] = [];
    console.log = (line: unknown) => { lines.push(String(line)); };
    await run(dir);
    expect(snapshot(dir)).toEqual(first);
    expect(lines.some((line) => /AAA/.test(line) && /failed/.test(line) && /holdings guard: no holdings rows \(2 published\)/.test(line))).toBe(true);
    expect(lines.some((line) => /BBB/.test(line) && /failed/.test(line) && /holdings guard: weights add up to 476\.00/.test(line))).toBe(true);
    expect(lines.some((line) => /CCC/.test(line) && /unchanged/.test(line))).toBe(true);
  });

  test("filters exclude funds without a figure and write nothing for them", async () => {
    const dir = fresh();
    installMock(() => [{ ticker: "AAA", name: "Alpha Index ETF", divYield: 3 }, { ticker: "BBB", name: "Beta Index ETF", divYield: 0 }]); quiet();
    await run(dir, { DIVIDEND_YIELD: "1:" });
    expect(existsSync(join(dir, "funds", "AAA", "meta.json"))).toBe(true);
    expect(existsSync(join(dir, "funds", "BBB"))).toBe(false);
    expect(passesDataFilters({ tr10y: null, cagr10y: null }, {}, readConfig({ TOTAL_RETURN_10Y: "0:" }))).toBe(false);
    expect(passesDataFilters({ tr10y: 12, cagr10y: 2 }, {}, readConfig({ TOTAL_RETURN_10Y: "0:" }))).toBe(true);
  });

  test("MAX_FETCHES walks the set and wraps around; a TICKERS run keeps the cursor", async () => {
    const dir = fresh(); installMock(() => THREE); quiet();
    const done: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const before = snapshot(dir);
      await run(dir, { MAX_FETCHES: "2" });
      const after = snapshot(dir);
      done.push(...["AAA", "BBB", "CCC"].filter((t) => !(`/funds/${t}/meta.json` in before) && `/funds/${t}/meta.json` in after));
    }
    expect([...done].sort()).toEqual(["AAA", "BBB", "CCC"]);
    writeFileSync(join(dir, "update-state.json"), JSON.stringify({ cursor: "CCC" }));
    rmSync(join(dir, "funds", "AAA"), { recursive: true });
    await run(dir, { MAX_FETCHES: "1" });
    expect(existsSync(join(dir, "funds", "AAA", "meta.json"))).toBe(true);
    writeFileSync(join(dir, "update-state.json"), JSON.stringify({ cursor: "BBB" }));
    await run(dir, { TICKERS: "AAA" });
    expect(JSON.parse(readFileSync(join(dir, "update-state.json"), "utf8")).cursor).toBe("BBB");
  });

  test("every selected fund failing is an error; an expired deadline still writes the index", async () => {
    const dir = fresh(); installMock(() => THREE.map((f) => ({ ...f, pageOk: false }))); quiet();
    await expect(run(dir)).rejects.toThrow(/every selected fund failed/);
    const other = fresh(); installMock(() => THREE);
    await run(other, {}, { deadlineMs: -1 });
    expect(index(other).funds).toHaveLength(3);
    expect(index(other).funds.every((f: any) => f.dataFile === null)).toBe(true);
  });

  test("writeIfChanged goes through a temp file and leaves only the target", async () => {
    const dir = fresh();
    expect(await writeIfChanged(join(dir, "a.json"), "{}\n")).toBe("written");
    expect(await writeIfChanged(join(dir, "a.json"), "{}\n")).toBe("unchanged");
    expect(readdirSync(dir).sort()).toEqual(["a.json"]);
  });
});

describe("network", () => {
  const cfg = () => readConfig({ MAX_RETRIES: "2", REQUEST_SLEEP: "0" });
  // answers only through the abort signal; without a signal it would "succeed" late, so a missing timeout fails the test
  const never = (init: any) => new Promise((ok, fail) => {
    if (!init?.signal) setTimeout(() => ok(new Response("late")), 300);
    else init.signal.addEventListener("abort", () => fail(init.signal.reason));
  });

  test("a request that never answers is aborted and retried, covering the body too", async () => {
    setFetchTuningForTests(40, 1);
    let calls = 0;
    globalThis.fetch = ((_url: any, init: any) => { calls += 1; return never(init) as Promise<Response>; }) as unknown as typeof fetch;
    await expect(fetchWithRetry("https://x.test/", {}, cfg(), "hang")).rejects.toThrow();
    expect(calls).toBe(3);
    calls = 0;
    globalThis.fetch = ((_url: any, init: any) => { calls += 1; return Promise.resolve({ ok: true, text: () => never(init) }); }) as unknown as typeof fetch;
    await expect(fetchWithRetry("https://x.test/", {}, cfg(), "body", (r) => r.text())).rejects.toThrow();
    expect(calls).toBe(3);
  });

  test("a 404 is final, a 503 is retried a bounded number of times", async () => {
    setFetchTuningForTests(1000, 1);
    for (const [status, message, expected] of [[404, "HTTP 404", 1], [503, "HTTP 503", 3]] as const) {
      let calls = 0;
      globalThis.fetch = (async () => { calls += 1; return new Response("x", { status }); }) as unknown as typeof fetch;
      await expect(fetchWithRetry("https://x.test/", {}, cfg(), "t")).rejects.toThrow(message);
      expect(calls).toBe(expected);
    }
  });

  test("in-flight peak is 1 at CONCURRENCY=1 and above 1 at CONCURRENCY=3", async () => {
    quiet();
    const one = installMock(() => THREE, { delayMs: 15 });
    await run(fresh(), { CONCURRENCY: "1" });
    expect(one.state.peak).toBe(1);
    const three = installMock(() => THREE, { delayMs: 15 });
    await run(fresh(), { CONCURRENCY: "3" });
    expect(three.state.peak).toBeGreaterThanOrEqual(2);
  });

  test("HISTORY_RANGE sends explicit period1/period2: max from 0, Ny a real window without range", () => {
    const now = Date.parse("2026-10-02T00:00:00Z");
    const all = new URL(yahooChartUrl("SIL", "max", now));
    expect([all.searchParams.get("period1"), all.searchParams.get("period2")]).toEqual(["0", String(now / 1000)]);
    const five = new URL(yahooChartUrl("SIL", "5y", now));
    const p1 = Number(five.searchParams.get("period1"));
    expect(p1).toBeGreaterThan(0);
    expect(five.searchParams.has("range")).toBe(false);
    expect(five.searchParams.get("period2")).toBe(String(now / 1000));
    expect(Math.round((now / 1000 - p1) / 86_400 / 365.25)).toBe(5);
  });
});
