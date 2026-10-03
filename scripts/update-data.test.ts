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
  horizonValue,
  installSystemCa,
  isCertError,
  main,
  parseGlobalXDistributionHistory,
  parseGlobalXDistributionInfo,
  parseGlobalXFundDetails,
  parseGlobalXHoldingsCsv,
  parseGlobalXLineup,
  parseGlobalXPerformanceSection,
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
  const lineup = flightHtml([
    '8e:{"etf_name":"U.S. Infrastructure Development ETF","inception_date":"$D2017-03-06T00:00:00.000Z","nav":53.46,"net_assets":13532865123.34}',
    '8d:{"AS_OF_DATE":"$D2026-09-25T00:00:00.000Z","ETF_TICKER":"PAVE","FUND_DATA":"$8e","THEME":"Equity","SUB_THEME":"Thematic","GROSS_EXP":0.47,"NET_EXP":"$undefined"}',
  ]);

  test("catalog: Flight chunks decode and references resolve", () => {
    expect(extractNextFlightText(lineup)).toContain('"ETF_TICKER":"PAVE"');
    const funds = parseGlobalXLineup(lineup);
    expect(funds).toHaveLength(1);
    expect(funds[0]).toMatchObject({ ticker: "PAVE", name: "U.S. Infrastructure Development ETF", category: "Equity / Thematic", managementFee: 0.47, netAssets: 13532865123.34, inceptionDate: "2017-03-06" });
  });

  test("fund page: details, distribution info, history and returns", () => {
    const html = flightHtml([
      'p:{"ETF_DETAILS":{"ASSETS":13532865123.34,"AS_OF_DATE":"$D2026-09-25T00:00:00.000Z","BLOOMBERG_TICKER":"IPAVE","CUSIP":"37954Y673","DIST_YIELD":0.56,"DIV_YIELD":0.8,"EXCHANGE":"Cboe BZX","INCEPTION_DATE":"$D2017-03-06T00:00:00.000Z","ISIN":"US37954Y6730","NET_ASSET_VALUE":"53.46","SHARES_OUTSTANDING":253120000,"THIRTY_DAY_MEDIAN_BID_ASK":0.000187,"YIELD_SEC_30":0.5},"PERFORMANCE_HISTORY":{"avg_annualized":{"month_end":{"fund_nav":{"FIVE_YEAR":0.1579,"ONE_YEAR":0.1864,"SINCE_INCEPTION":0.1534,"THREE_YEAR":0.2008,"TEN_YEAR":0.0836}},"quarter_end":{"fund_nav":{"ONE_YEAR":0.3629}}},"cumulative":{"month_end":{"fund_nav":{"YTD":0.146}},"quarter_end":{"fund_nav":{"YTD":0.234}}},"month_end_date":"$D2026-08-31T00:00:00.000Z","quarter_end_date":"$D2026-06-30T00:00:00.000Z"},"DISTRIBUTION_HISTORY":[{"amount":0.1027,"ex_date":"2026-06-29","record_date":"2026-06-29","payable_date":"2026-07-02"}]}',
      'q:{"children":"Distribution Frequency"}',
      'r:{"children":"Semi-Annually"}',
    ]);
    const withPrices = `${html}<table><tr><td>NAV</td><td>$53.46</td><td>Daily Change</td><td>$0.40</td><td>0.75%</td></tr><tr><td>Market Price</td><td>$53.47</td><td>Daily Change</td><td>$0.40</td><td>0.75%</td></tr></table>`;
    expect(parseGlobalXFundDetails(withPrices)).toMatchObject({ cusip: "37954Y673", isin: "US37954Y6730", netAssetValue: 53.46, marketPrice: 53.47, navDailyChangePercent: 0.75, bidAskSpread: 0.02 });
    expect(parseGlobalXDistributionInfo(html)).toMatchObject({ frequency: "Semi-Annually", secYield: 0.5 });
    expect(parseGlobalXDistributionHistory(html)[0]).toMatchObject({ "Ex-Div Date": "2026-06-29", "Amount ($)": "$0.102700" });
    const monthly = parseGlobalXPerformanceSection(html, "monthly-performance");
    expect(monthly?.nav).toMatchObject({ yr1: 18.64, yr10: 8.36, ytd: 14.6 });
    expect(monthly?.asOfDate).toBe("2026-08-31");
    expect(parseGlobalXPerformanceSection(html, "quarterly-performance")?.asOfDate).toBe("2026-06-30");
  });

  test("distributions: unscheduled rows are skipped, a published 0 rate is null, cadence maps to payments", () => {
    const html = flightHtml(['p:{"DISTRIBUTION_HISTORY":[{"amount":null,"ex_date":"2026-12-30","record_date":"2026-12-30","payable_date":"2027-01-05"},{"amount":0.1079,"ex_date":"2026-06-29","record_date":"2026-06-29","payable_date":"2026-07-07"}]}']);
    expect(parseGlobalXDistributionHistory(html, new Date("2026-10-02T00:00:00Z")).map((row) => row["Ex-Div Date"])).toEqual(["2026-06-29"]);
    expect(parseGlobalXDistributionHistory(html, new Date("2027-02-01T00:00:00Z"))).toHaveLength(2);
    const info = (rate: number) => parseGlobalXDistributionInfo(flightHtml([`p:{"ETF_DETAILS":{"AS_OF_DATE":"$D2026-09-25T00:00:00.000Z","DIV_YIELD":${rate},"YIELD_SEC_30":4.6}}`, 'q:{"children":"Distribution Frequency"}', 'r:{"children":"Monthly"}']));
    expect(info(0)?.distributionRate).toBeNull();
    expect(info(0)?.secYield).toBe(4.6);
    expect(info(3.1)?.distributionRate).toBe(3.1);
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
  });

  test("performanceAsOf is the performance table date, never the NAV date, with a fixed key set", () => {
    const row = withMetricsContract({ nav: { asOfDate: "Sep 25 2026" }, returns: { monthEnd: { asOfDate: "Aug 31 2026" } }, metrics: { ytd: 6.6, returnsBasis: "-", dividendYieldText: "0.89%" } });
    expect(row.metrics.performanceAsOf).toBe("2026-08-31");
    expect(row.metrics.returnsBasis).toBe(OFFICIAL_RETURNS_BASIS);
    expect(Object.keys(row.metrics)).toEqual(["ytd", "dividendYieldText", "tr1y", "tr3y", "tr5y", "tr10y", "cagr3y", "cagr5y", "cagr10y", "siAnn", "dividendYield", "secYield", "returnsBasis", "performanceAsOf"]);
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
type MockFund = { ticker: string; name: string; net?: number | null; gross?: number | null; divYield?: number; pageOk?: boolean; yahooOk?: boolean; ten?: number };

function lineupPage(funds: MockFund[]): string {
  const chunks: string[] = [];
  funds.forEach((fund, i) => {
    chunks.push(`${i}a:{"etf_name":${JSON.stringify(fund.name)},"inception_date":"$D2015-03-06T00:00:00.000Z","nav":10,"net_assets":1000000000}`);
    chunks.push(`${i}b:{"AS_OF_DATE":"$D2026-09-25T00:00:00.000Z","ETF_TICKER":"${fund.ticker}","FUND_DATA":"$${i}a","THEME":"Equity","SUB_THEME":"Thematic","GROSS_EXP":${fund.gross ?? 0.6},"NET_EXP":${fund.net === null ? '"$undefined"' : (fund.net ?? 0.5)}}`);
  });
  return flightHtml(chunks);
}

function fundPage(fund: MockFund): string {
  const ten = fund.ten === undefined ? '' : `,"TEN_YEAR":${fund.ten}`;
  return flightHtml([
    `p:{"ETF_DETAILS":{"ASSETS":1000000000,"AS_OF_DATE":"$D2026-09-25T00:00:00.000Z","CUSIP":"37954Y673","DIV_YIELD":${fund.divYield ?? 2.5},"EXCHANGE":"Cboe BZX","INCEPTION_DATE":"$D2015-03-06T00:00:00.000Z","ISIN":"US37954Y6730","NET_ASSET_VALUE":"10.50","SHARES_OUTSTANDING":1000000,"YIELD_SEC_30":1.5},"PERFORMANCE_HISTORY":{"avg_annualized":{"month_end":{"fund_nav":{"FIVE_YEAR":0.1,"ONE_YEAR":0.2,"SINCE_INCEPTION":0.08,"THREE_YEAR":0.15${ten}}}},"cumulative":{"month_end":{"fund_nav":{"YTD":0.1}}},"month_end_date":"$D2026-08-31T00:00:00.000Z","quarter_end_date":"$D2026-06-30T00:00:00.000Z"},"DISTRIBUTION_HISTORY":[{"amount":null,"ex_date":"2999-12-30","record_date":"2999-12-30","payable_date":"2999-12-31"},{"amount":0.25,"ex_date":"2026-06-29","record_date":"2026-06-29","payable_date":"2026-07-07"}]}`,
    'q:{"children":"Distribution Frequency"}',
    'r:{"children":"Semi-Annually"}',
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
      if (url.includes('assets.globalxetfs.com')) return new Response(HOLDINGS_CSV);
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

  test("a second identical run writes nothing, even generatedAt", async () => {
    const dir = fresh(); installMock(() => THREE); quiet();
    await run(dir);
    const first = snapshot(dir);
    await new Promise((resolve) => setTimeout(resolve, 1100)); // generatedAt has second resolution
    await run(dir);
    expect(snapshot(dir)).toEqual(first);
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
