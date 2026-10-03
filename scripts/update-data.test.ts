/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTROL_NAMES,
  fetchWithRetry,
  main,
  passesDataFilters,
  sameSeries,
  setApiRootForTests,
  setFetchTuningForTests,
  writeIfChanged,
  installSystemCa,
  isCertError,
  GLOBALX_ETF_TRUST_CIK,
  GLOBALX_ETF_TRUST_FILE_NUMBER,
  extractNextFlightText,
  globalxEdgarFilingsUrl,
  globalxFundPageUrl,
  globalxHoldingsCsvUrl,
  parseGlobalXDistributionHistory,
  parseGlobalXDistributionInfo,
  parseGlobalXFundDetails,
  parseGlobalXHoldingsCsv,
  parseGlobalXLineup,
  parseGlobalXPerformanceSection,
  parseYahooChart,
  yahooChartUrl,
  paymentsPerYear,
  formatGlobalXDate,
  horizonValue,
  positiveYieldOrNull,
  readConfig,
  resolveControls,
  runtimeControls,
  sanitizeTicker,
  withMetricsContract,
  NO_RETURNS_BASIS,
  OFFICIAL_RETURNS_BASIS,
} from "./update-data.ts";

function flightHtml(chunks: string[]): string {
  const flight = chunks.join("\n");
  return `<script>self.__next_f.push([1,${JSON.stringify(flight)}])</script>`;
}

describe("Global X live payload shape", () => {
  const lineup = flightHtml([
    '8e:{"etf_name":"U.S. Infrastructure Development ETF","inception_date":"$D2017-03-06T00:00:00.000Z","nav":53.46,"net_assets":13532865123.34}',
    '8d:{"AS_OF_DATE":"$D2026-09-25T00:00:00.000Z","ETF_TICKER":"PAVE","FUND_DATA":"$8e","THEME":"Equity","SUB_THEME":"Thematic","GROSS_EXP":0.47,"NET_EXP":"$undefined"}',
  ]);

  test("decodes Next.js Flight chunks and resolves catalog references", () => {
    expect(extractNextFlightText(lineup)).toContain('"ETF_TICKER":"PAVE"');
    const funds = parseGlobalXLineup(lineup);
    expect(funds).toHaveLength(1);
    expect(funds[0]).toMatchObject({
      ticker: "PAVE",
      name: "U.S. Infrastructure Development ETF",
      category: "Equity / Thematic",
      managementFee: 0.47,
      netAssets: 13532865123.34,
      inceptionDate: "2017-03-06",
    });
  });

  test("parses the current fund-page details, distribution info, history and returns", () => {
    const html = flightHtml([
      'p:{"ETF_DETAILS":{"ASSETS":13532865123.34,"AS_OF_DATE":"$D2026-09-25T00:00:00.000Z","BLOOMBERG_TICKER":"IPAVE","CUSIP":"37954Y673","DIST_YIELD":0.56,"DIV_YIELD":0.8,"EXCHANGE":"Cboe BZX","INCEPTION_DATE":"$D2017-03-06T00:00:00.000Z","ISIN":"US37954Y6730","NET_ASSET_VALUE":"53.46","SHARES_OUTSTANDING":253120000,"THIRTY_DAY_MEDIAN_BID_ASK":0.000187,"YIELD_SEC_30":0.5},"PERFORMANCE_HISTORY":{"avg_annualized":{"month_end":{"fund_nav":{"FIVE_YEAR":0.1579,"ONE_YEAR":0.1864,"SINCE_INCEPTION":0.1534,"THREE_YEAR":0.2008}},"quarter_end":{"fund_nav":{"FIVE_YEAR":0.1885,"ONE_YEAR":0.3629,"SINCE_INCEPTION":0.1656,"THREE_YEAR":0.2416}}},"cumulative":{"month_end":{"fund_nav":{"ONE_MONTH":-0.028,"SINCE_INCEPTION":2.878,"THREE_MONTH":-0.026,"YTD":0.146}},"quarter_end":{"fund_nav":{"ONE_MONTH":0.047,"SINCE_INCEPTION":3.176,"THREE_MONTH":0.160,"YTD":0.234}}},"month_end_date":"$D2026-08-31T00:00:00.000Z","quarter_end_date":"$D2026-06-30T00:00:00.000Z"},"DISTRIBUTION_HISTORY":[{"amount":0.1027,"ex_date":"2026-06-29","record_date":"2026-06-29","payable_date":"2026-07-02"}]}',
      'q:{"children":"Distribution Frequency"}',
      'r:{"children":"Semi-Annually"}',
    ]);
    const withPrices = `${html}<table><tr><td>NAV</td><td>$53.46</td><td>Daily Change</td><td>$0.40</td><td>0.75%</td></tr><tr><td>Market Price</td><td>$53.47</td><td>Daily Change</td><td>$0.40</td><td>0.75%</td></tr></table>`;
    expect(parseGlobalXFundDetails(withPrices)).toMatchObject({
      cusip: "37954Y673",
      isin: "US37954Y6730",
      netAssetValue: 53.46,
      marketPrice: 53.47,
      navDailyChangePercent: 0.75,
      bidAskSpread: 0.02,
    });
    expect(parseGlobalXDistributionInfo(html)).toMatchObject({ frequency: "Semi-Annually", secYield: 0.5 });
    expect(parseGlobalXDistributionHistory(html)[0]).toMatchObject({ "Ex-Div Date": "2026-06-29", "Amount ($)": "$0.102700" });
    expect(parseGlobalXPerformanceSection(html, "monthly-performance")?.nav).toMatchObject({ yr1: 18.64, ytd: 14.6 });
    expect(parseGlobalXPerformanceSection(html, "quarterly-performance")?.asOfDate).toBe("2026-06-30");
  });
});

describe("Global X official holdings CSV", () => {
  test("parses the dated seven-column full-holdings download", () => {
    const csv = `Global X U.S. Infrastructure Development ETF\nFund Holdings Data as of 09/25/2026\n% of Net Assets,Ticker,Name,SEDOL,Market Price ($),Shares Held,Market Value ($)\n0.02,,CASH,,1.00,"413,416.71","413,416.71"\n3.65,DE,DEERE & CO,2261203,690.46,"714,766.00","493,517,332.36"`;
    const parsed = parseGlobalXHoldingsCsv(csv);
    expect(parsed.asOfDate).toBe("2026-09-25");
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toMatchObject({ Name: "CASH", "Asset Category": "Cash", Weight: "0.02%" });
    expect(parsed.rows[1]).toMatchObject({ Ticker: "DE", Identifier: "2261203", "Market Value": "493,517,332.36" });
  });
});

describe("shared updater contracts", () => {
  test("uses the confirmed Global X Funds EDGAR registrant", () => {
    expect(GLOBALX_ETF_TRUST_CIK).toBe("0001432353");
    expect(GLOBALX_ETF_TRUST_FILE_NUMBER).toBe("811-22209");
    expect(globalxEdgarFilingsUrl()).toContain("CIK=0001432353");
    expect(globalxEdgarFilingsUrl()).toContain("type=NPORT-P");
  });

  test("uses stable issuer URLs and no date in the fallback provenance URL", () => {
    expect(globalxFundPageUrl("pave")).toBe("https://www.globalxetfs.com/funds/pave/");
    expect(globalxHoldingsCsvUrl("PAVE")).toBe("https://assets.globalxetfs.com/funds/holdings/pave_full-holdings.csv");
  });

  test("normalizes tickers and keeps Yahoo adjusted close at two decimals", () => {
    expect(sanitizeTicker(" pave ")).toBe("PAVE");
    const parsed = parseYahooChart({ chart: { result: [{ timestamp: [1790899200], indicators: { quote: [{ close: [53.46999], volume: [100] }], adjclose: [{ adjclose: [53.461999] }] }, events: { dividends: {} } }] } });
    expect(parsed.history[0].adjClose).toBe(53.46);
  });

  test("reads the documented defaults and the ticker allowlist", () => {
    expect(readConfig({}).requestSleep).toBe(2);
    expect(readConfig({}).concurrency).toBe(2);
    expect(readConfig({ TICKERS: "pave, AIQ" }).tickers).toEqual(["PAVE", "AIQ"]);
  });
});


import { test as frequencyLabelTest, expect as frequencyLabelExpect } from 'bun:test';
frequencyLabelTest('Frequency placeholders display None and existing cadence labels stay unchanged', async () => {
  const text = await Bun.file(new URL('../app.tsx', import.meta.url)).text();
  const start = /^([ \t]*)function (formatDividendFrequency|formatDistributionFrequency)\(/m.exec(text);
  frequencyLabelExpect(start).not.toBeNull();
  const tail = text.slice(start!.index);
  const end = new RegExp('^' + start![1] + '\u007d', 'm').exec(tail);
  frequencyLabelExpect(end).not.toBeNull();
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(tail.slice(0, end!.index + end![0].length));
  const format = new Function(js + '; return ' + start![2] + ';')();
  for (const value of [null, undefined, '', '  ', '-', '‐', '‑', '‒', '–', '—', ' — ']) {
    frequencyLabelExpect(format(value)).toBe('00 - None');
  }
  for (const [input, expected] of [
    ['None', '00 - None'], ['Unknown', '00 - Unknown'], ['Monthly', '01 - Monthly'],
    ['Quarterly', '04 - Quarterly'], ['Semi-annually', '06 - Semi-annually'],
    ['Annually', '12 - Annually'], ['Irregular', '99 - Irregular'],
  ]) frequencyLabelExpect(format(input)).toBe(expected);
});


import { test as queueTest, describe as queueDescribe, expect as queueExpect } from 'bun:test';

async function tickerChainHarness() {
 const app=await Bun.file(new URL('../app.tsx',import.meta.url)).text();
 const source=app.match(/^function withTickerChain<T>\([\s\S]*?^\}/m)?.[0];
 queueExpect(source).toBeDefined();
 const javascript=new Bun.Transpiler({loader:'ts'}).transformSync(source!);
 const chains=new Map<string,Promise<void>>();
 const enqueue=new Function('holdingsChains',`${javascript}; return withTickerChain;`)(chains) as
  <T>(ticker:string,fn:()=>Promise<T>)=>Promise<T>;
 return {chains,enqueue};
}

queueDescribe('per-ticker queue preserves caller results and stores completion-only promises',()=>{
 queueTest('successful generic result reaches caller, not the internal queue',async()=>{
  const {chains,enqueue}=await tickerChainHarness();
  const value={rows:[['AGEM']]};
  queueExpect(await enqueue('AGEM',async()=>value)).toBe(value);
  queueExpect(await chains.get('AGEM')).toBeUndefined();
 });
 queueTest('rejection reaches caller without poisoning the next queued task',async()=>{
  const {chains,enqueue}=await tickerChainHarness();
  const error=new Error('page failed');
  const work=enqueue('AGEM',async()=>{throw error;});
  const observed=work.catch(reason=>reason);
  const settled=chains.get('AGEM');
  const next=enqueue('AGEM',async()=>42);
  queueExpect(await observed).toBe(error);
  queueExpect(await settled).toBeUndefined();
  queueExpect(await next).toBe(42);
  queueExpect(await chains.get('AGEM')).toBeUndefined();
 });
 queueTest('synchronous callback throws also leave the queue usable',async()=>{
  const {chains,enqueue}=await tickerChainHarness();
  const error=new Error('synchronous failure');
  queueExpect(await enqueue('AGEM',()=>{throw error;}).catch(reason=>reason)).toBe(error);
  queueExpect(await chains.get('AGEM')).toBeUndefined();
  queueExpect(await enqueue('AGEM',async()=>'recovered')).toBe('recovered');
 });
 queueTest('same-ticker work stays serial while other tickers run independently',async()=>{
  const {chains,enqueue}=await tickerChainHarness();
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const events:string[]=[];
  const first=enqueue('AGEM',async()=>{events.push('first');await gate;events.push('done');return 1;});
  const second=enqueue('AGEM',async()=>{events.push('second');return 2;});
  try {
   queueExpect(await enqueue('SGOL',async()=>3)).toBe(3);
   queueExpect(events).toEqual(['first']);
  } finally { release(); }
  queueExpect(await Promise.all([first,second])).toEqual([1,2]);
  queueExpect(events).toEqual(['first','done','second']);
  queueExpect(await chains.get('AGEM')).toBeUndefined();
  queueExpect(await chains.get('SGOL')).toBeUndefined();
 });
});


import { test as headerTest, expect as headerExpect } from 'bun:test';
async function headerSummaryHarness() {
  const source = await Bun.file(new URL('../app.tsx', import.meta.url)).text();
  const match = /^([ \t]*)function renderHeaderSummary\(/m.exec(source);
  headerExpect(match).not.toBeNull();
  const tail = source.slice(match!.index);
  const end = new RegExp('^' + match![1] + '}', 'm').exec(tail)!;
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(tail.slice(0, end.index + end[0].length));
  const makeNode = (text = ''): any => {
    const node: any = { textContent: text, childNodes: [], dataset: {}, listeners: {} };
    node.replaceChildren = (...children: any[]) => { node.childNodes = children; };
    node.append = (...children: any[]) => { node.childNodes.push(...children); };
    node.addEventListener = (name: string, listener: any) => { node.listeners[name] = listener; };
    return node;
  };
  const panel = makeNode(), subtitle = makeNode(), details = makeNode('Data: source link and updated timestamp');
  subtitle.append(details);
  const document = { getElementById: () => panel, createTextNode: makeNode, createElement: () => makeNode() };
  const render = new Function('document', js + '; return renderHeaderSummary;')(document);
  const text = () => subtitle.childNodes.map((n: any) => n.textContent).join('');
  return { render, panel, subtitle, details, makeNode, text };
}
headerTest('header has no visible subtitle without selection; original details nodes are retained', async () => {
  const h = await headerSummaryHarness();
  h.render(h.subtitle, new Set(), null, () => {});
  headerExpect(h.text()).toBe('');
  headerExpect(h.panel.childNodes).toEqual([h.details]);
  headerExpect(h.panel.childNodes[0]).toBe(h.details);
});
headerTest('header shows sorted selected tickers only, preserving click activation and highlight', async () => {
  const h = await headerSummaryHarness(); const activated: string[] = [];
  h.render(h.subtitle, new Set(['ZZZ', 'AAA']), 'AAA', (ticker: string) => activated.push(ticker));
  headerExpect(h.text()).toBe('2 selected: AAA, ZZZ');
  const links = h.subtitle.childNodes.filter((n: any) => n.dataset.headerFund);
  headerExpect(links[0].className).toContain('underline');
  links[1].listeners.click({ preventDefault() {} });
  headerExpect(activated).toEqual(['ZZZ']);
  headerExpect(h.panel.childNodes[0]).toBe(h.details);
});
headerTest('all selected still lists tickers; clear replaces both summary and selection', async () => {
  const h = await headerSummaryHarness();
  h.render(h.subtitle, new Set(['CCC','AAA','BBB']), 'BBB', () => {});
  headerExpect(h.text()).toBe('3 selected: AAA, BBB, CCC');
  const next = h.makeNode('Fresh detail context'); h.subtitle.replaceChildren(next);
  h.render(h.subtitle, new Set(), null, () => {});
  headerExpect(h.text()).toBe(''); headerExpect(h.panel.childNodes).toEqual([next]);
});
headerTest('header markup supplies a focusable counter and hidden rich panel with dismissal', async () => {
  const html = await Bun.file(new URL('../index.html', import.meta.url)).text();
  headerExpect(html).toMatch(/<button[^>]*aria-controls="app-summary"[^>]*id="ticker-count"/);
  headerExpect(html).toContain('id="app-summary" role="region" aria-label="ETF catalog information" hidden');
  headerExpect(html).toContain("event.key !== 'Escape'");
  headerExpect(html).toContain("trigger.addEventListener('focus', show)");
  headerExpect(html).toContain("trigger.addEventListener('pointerenter'");
});

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const file = () => JSON.parse(read('scripts/update-data.config.json'));

test('configuration precedence: file < advanced < nonblank input < environment', () => {
  const c = resolveControls({ CONCURRENCY: 2, TICKERS: 'PAVE' }, { CONCURRENCY: 3, TICKERS: 'AIQ' }, { CONCURRENCY: '4', TICKERS: '' }, { CONCURRENCY: '5' });
  expect(c.CONCURRENCY).toBe('5');
  expect(c.TICKERS).toBe('AIQ');
  expect(resolveControls({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }, { CONCURRENCY: '4' }).CONCURRENCY).toBe('4');
  expect(resolveControls({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }).CONCURRENCY).toBe('3');
});

test('blank input inherits the file value; advanced can deliberately blank a key', () => {
  expect(resolveControls({ CONCURRENCY: 2 }, {}, { CONCURRENCY: '' }).CONCURRENCY).toBe('2');
  expect(resolveControls({ TICKERS: 'PAVE' }, {}, { TICKERS: '' }).TICKERS).toBe('PAVE');
  expect(resolveControls({ TICKERS: 'PAVE' }, { TICKERS: '' }, { TICKERS: '' }).TICKERS).toBe('');
  expect(resolveControls({ SKIP_YAHOO: true }, {}, {}, { SKIP_YAHOO: 'false' }).SKIP_YAHOO).toBe('false');
});

test('scheduled path (empty inputs and advanced) equals the config defaults', () => {
  const defaults = file();
  const scheduled = resolveControls(defaults, JSON.parse('{}'), {}, {});
  expect(scheduled).toEqual(Object.fromEntries(Object.entries(defaults).map(([k, v]) => [k, String(v)])));
});

test('safe resolver rejects unknown keys, non-scalars, bad values and newline injection', () => {
  for (const value of [{ UNKNOWN: 1 }, { SEC_UA: 'x\nEVIL=yes' }, { CONCURRENCY: 0 }, { MAX_RETRIES: 0 }, { MAX_RETRIES: -1 }, { MAX_FETCHES: 1.5 }, { REQUEST_SLEEP: '-1' }, { VERBOSE: 'maybe' }, { AUM: '1:2:3' }, { TER: '2:1' }, { TICKERS: ['PAVE'] }, { TICKERS: { a: 1 } }, null, []]) {
    expect(() => resolveControls(value)).toThrow();
  }
  expect(() => resolveControls({}, { SEC_UA: 'x\rfoo' })).toThrow();
  expect(() => resolveControls({}, {}, {}, { SEC_UA: 'x\0bad' })).toThrow();
  expect(() => resolveControls({}, [])).toThrow();
  expect(() => JSON.parse('{not json')).toThrow();
});

test('existing HISTORICAL_PAGE_SIZE alias keeps working and the canonical name wins', () => {
  expect(resolveControls({}, {}, {}, { HISTORICAL_PAGE_SIZE: '500' }).HISTORY_PAGE_SIZE).toBe('500');
  expect(resolveControls({}, {}, {}, { HISTORICAL_PAGE_SIZE: '500', HISTORY_PAGE_SIZE: '600' }).HISTORY_PAGE_SIZE).toBe('600');
});

test('Global X defaults come from the tracked config file', () => {
  const config = readConfig(resolveControls(file()));
  expect(config.tickers).toEqual([]);
  expect(config.maxFetches).toBe(0);
  expect(config.requestSleep).toBe(2);
  expect(config.concurrency).toBe(2);
  expect(config.holdingsPageSize).toBe(250);
  expect(config.historyPageSize).toBe(1000);
  expect(config.maxRetries).toBe(3);
  expect(config.secUa).toBe('daggerok ETF feed daggerok@gmail.com');
  expect(config.historyRange).toBe('max');
  expect(config.storeRawDownloads).toBe(false);
  expect(config.edgarFallback).toBe(false);
  expect(config.skipYahoo).toBe(false);
  expect(config.skipGlobalX).toBe(false);
  expect(config.aumRange).toBeUndefined();
  expect(config.terRange).toBeUndefined();
  expect(readConfig(resolveControls(file(), { AUM: 'micro', TICKERS: 'pave, aiq', PERFORMANCE_1Y: '5:' })).tickers).toEqual(['PAVE', 'AIQ']);
});

test('runtimeControls applies the config file and explicit env overrides', async () => {
  expect((await runtimeControls({})).REQUEST_SLEEP).toBe(String(file().REQUEST_SLEEP));
  expect((await runtimeControls({ REQUEST_SLEEP: '0', TICKERS: 'PAVE' })).TICKERS).toBe('PAVE');
});

test('config keys, CONTROL_NAMES, --help and README controls stay in sync', () => {
  expect(Object.keys(file()).sort()).toEqual([...CONTROL_NAMES].sort());
  expect(new Set(CONTROL_NAMES).size).toBe(CONTROL_NAMES.length);
  const doc = read('README.md');
  const controls = doc.slice(doc.indexOf('### Update controls'), doc.indexOf('### Examples'));
  const help = Bun.spawnSync(['bun', new URL('./update-data.ts', import.meta.url).pathname, '--help']).stdout.toString();
  for (const name of CONTROL_NAMES) {
    const tenor = name.match(/^(PERFORMANCE|TOTAL_RETURN)_(1Y|3Y|5Y|10Y)$/);
    // The README groups the five tenors of each return filter on one row; --help uses `PREFIX_YTD|1Y|...`.
    expect(controls).toContain(tenor ? '`' + tenor[1] + '_YTD`' : '`' + name + '`');
    expect(help).toContain(tenor ? tenor[1] + '_YTD|1Y|3Y|5Y|10Y' : name);
  }
  expect(doc).toContain('scripts/update-data.config.json');
});

test('workflow exposes at most 25 inputs, mapped to controls, with a fixed api/globalx output', () => {
  const wf = read('.github/workflows/update-data.yml');
  const names = [...wf.slice(wf.indexOf('    inputs:'), wf.indexOf('\npermissions:')).matchAll(/^      (\w+):$/gm)].map((m) => m[1]);
  expect(names.length).toBeLessThanOrEqual(25);
  expect(names).toContain('advanced');
  expect(wf).toMatch(/advanced:\n(?:.*\n)*?\s+default: '\{\}'/);
  for (const name of names.filter((n) => n !== 'advanced')) expect(CONTROL_NAMES).toContain(name.toUpperCase() as (typeof CONTROL_NAMES)[number]);
  expect(wf).toContain("cron: '0 0 * * 0'");
  expect(wf).not.toMatch(/^  push:/m);
  expect(wf).toContain('toJSON(inputs)');
  expect(wf).not.toMatch(/\$\{\{\s*inputs\./);
  expect(wf).not.toContain('OUTPUT_DIR');
  expect(wf).toContain('git add api/globalx\n');
  expect(wf.match(/git add /g)?.length).toBe(1);
});

test('USE_SYSTEM_CA accepts auto/true/false case-insensitively, rejects others, defaults to auto', () => {
  expect(resolveControls(file()).USE_SYSTEM_CA).toBe('auto');
  expect(file().USE_SYSTEM_CA).toBe('auto');
  for (const mode of ['auto', 'true', 'false']) expect(resolveControls(file(), {}, {}, { USE_SYSTEM_CA: mode.toUpperCase() }).USE_SYSTEM_CA).toBe(mode);
  expect(() => resolveControls(file(), {}, {}, { USE_SYSTEM_CA: 'maybe' })).toThrow();
  expect(() => resolveControls(file(), { USE_SYSTEM_CA: 'maybe' })).toThrow();
});

test('isCertError detects untrusted-certificate errors, also through cause', () => {
  expect(isCertError({ code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' })).toBe(true);
  expect(isCertError(new Error('unable to get local issuer certificate'))).toBe(true);
  expect(isCertError(new Error('fetch failed', { cause: new Error('unable to get local issuer certificate') }))).toBe(true);
  expect(isCertError({ code: 'ECONNRESET', message: 'socket hang up' })).toBe(false);
  expect(isCertError(new Error('HTTP 403 Forbidden'))).toBe(false);
});

describe('installSystemCa', () => {
  const original = globalThis.fetch;
  const reexecSpy = () => {
    const calls: number[] = [];
    return { calls, reexec: ((): never => { calls.push(1); return undefined as never; }) };
  };
  const stub = (impl: () => Promise<Response>) => { globalThis.fetch = impl as unknown as typeof fetch; };
  const restore = () => { globalThis.fetch = original; };

  test('false and an already active system CA leave fetch unchanged', () => {
    try {
      const { calls, reexec } = reexecSpy();
      stub(async () => new Response('ok'));
      const before = globalThis.fetch;
      installSystemCa('false', reexec, false);
      expect(globalThis.fetch).toBe(before);
      installSystemCa('auto', reexec, true);
      installSystemCa('true', reexec, true);
      expect(globalThis.fetch).toBe(before);
      expect(calls.length).toBe(0);
    } finally { restore(); }
  });

  test('true re-executes immediately', () => {
    try {
      const { calls, reexec } = reexecSpy();
      installSystemCa('true', reexec, false);
      expect(calls.length).toBe(1);
    } finally { restore(); }
  });

  test('auto wraps fetch: cert error re-executes once, other errors rethrow, success passes through', async () => {
    try {
      const { calls, reexec } = reexecSpy();
      const errors = [Object.assign(new Error('fetch failed'), { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' }), new Error('ECONNRESET'), null];
      let i = 0;
      stub(async () => { const e = errors[i++]; if (e) throw e; return new Response('ok'); });
      const before = globalThis.fetch;
      installSystemCa('auto', reexec, false);
      expect(globalThis.fetch).not.toBe(before);
      await globalThis.fetch('https://example.invalid/');
      expect(calls.length).toBe(1);
      await expect(globalThis.fetch('https://example.invalid/')).rejects.toThrow('ECONNRESET');
      expect(calls.length).toBe(1);
      expect(await (await globalThis.fetch('https://example.invalid/')).text()).toBe('ok');
      expect(calls.length).toBe(1);
    } finally { restore(); }
  });
});

describe('metrics contract (returnsBasis, performanceAsOf)', () => {
  test('a row without metrics gets null numbers, a non-empty basis and null performanceAsOf', () => {
    const row = withMetricsContract({ ticker: 'NEW', holdings: 0 });
    expect(row.metrics.ytd).toBeNull();
    expect(row.metrics.tr10y).toBeNull();
    expect(row.metrics.returnsBasis).toBe(NO_RETURNS_BASIS);
    expect(row.metrics.performanceAsOf).toBeNull();
    expect(Object.keys(row.metrics).slice(-2)).toEqual(['returnsBasis', 'performanceAsOf']);
  });

  test('performanceAsOf is the performance table date (ISO), never the NAV date, and sits last', () => {
    const row = withMetricsContract({
      nav: { asOfDate: 'Sep 25 2026' },
      returns: { monthEnd: { asOfDate: 'Aug 31 2026' } },
      metrics: { ytd: 6.6, returnsBasis: '-', dividendYieldText: '0.89%' },
    });
    expect(row.metrics.performanceAsOf).toBe('2026-08-31');
    expect(row.metrics.returnsBasis).toBe(OFFICIAL_RETURNS_BASIS);
    expect(Object.keys(row.metrics)).toEqual([
      'ytd', 'dividendYieldText', 'tr1y', 'tr3y', 'tr5y', 'tr10y', 'cagr3y', 'cagr5y', 'cagr10y', 'siAnn',
      'dividendYield', 'secYield', 'returnsBasis', 'performanceAsOf',
    ]);
  });

  test('already compliant metrics are kept and the function is idempotent', () => {
    const once = withMetricsContract({ metrics: { ytd: 1, returnsBasis: 'custom', performanceAsOf: '2026-07-31' } });
    expect(once.metrics.returnsBasis).toBe('custom');
    expect(once.metrics.performanceAsOf).toBe('2026-07-31');
    expect(withMetricsContract(once)).toEqual(once);
  });

  test('the performance parser exposes an ISO table date', () => {
    const html = flightHtml([
      '1:{"PERFORMANCE_HISTORY":{"month_end_date":"$D2026-08-31T00:00:00.000Z","avg_annualized":{"month_end":{"fund_nav":{"ONE_YEAR":0.1}}},"cumulative":{"month_end":{"fund_nav":{}}}}}',
    ]);
    expect(parseGlobalXPerformanceSection(html, 'monthly-performance')?.asOfDate).toBe('2026-08-31');
  });
});

describe('data contract: tenors, cadence, placeholders, zero yields', () => {
  test('the NAV series TEN_YEAR value becomes yr10 (annualized, percent)', () => {
    const html = flightHtml([
      '1:{"PERFORMANCE_HISTORY":{"month_end_date":"$D2026-08-31T00:00:00.000Z","avg_annualized":{"month_end":{"fund_nav":{"ONE_YEAR":0.22,"TEN_YEAR":0.0836}}},"cumulative":{"month_end":{"fund_nav":{}}}}}',
    ]);
    expect(parseGlobalXPerformanceSection(html, 'monthly-performance')?.nav.yr10).toBe(8.36);
  });

  test('semi-annual pays twice a year', () => {
    expect(paymentsPerYear('Semi-Annually')).toBe(2);
    expect(paymentsPerYear('semi-annual')).toBe(2);
    expect(paymentsPerYear('Quarterly')).toBe(4);
    expect(paymentsPerYear('Monthly')).toBe(12);
  });

  test('future scheduled rows without an amount are not distribution history', () => {
    const html = flightHtml([
      'p:{"DISTRIBUTION_HISTORY":[{"amount":null,"ex_date":"2026-12-30","record_date":"2026-12-30","payable_date":"2027-01-05"},{"amount":0.1079,"ex_date":"2026-06-29","record_date":"2026-06-29","payable_date":"2026-07-07"}]}',
    ]);
    const rows = parseGlobalXDistributionHistory(html, new Date('2026-10-02T00:00:00Z'));
    expect(rows.map((row) => row['Ex-Div Date'])).toEqual(['2026-06-29']);
    expect(parseGlobalXDistributionHistory(html, new Date('2027-02-01T00:00:00Z'))).toHaveLength(2);
  });

  test('a published 0 distribution rate is unavailable (null), a positive one is kept', () => {
    expect(positiveYieldOrNull(0)).toBeNull();
    expect(positiveYieldOrNull('0')).toBeNull();
    expect(positiveYieldOrNull(4.2)).toBe(4.2);
    const html = (rate: number) => flightHtml([`p:{"ETF_DETAILS":{"AS_OF_DATE":"$D2026-09-25T00:00:00.000Z","DIV_YIELD":${rate},"YIELD_SEC_30":4.6}}`, 'q:{"children":"Distribution Frequency"}', 'r:{"children":"Monthly"}']);
    expect(parseGlobalXDistributionInfo(html(0))?.distributionRate).toBeNull();
    expect(parseGlobalXDistributionInfo(html(0))?.secYield).toBe(4.6);
    expect(parseGlobalXDistributionInfo(html(3.1))?.distributionRate).toBe(3.1);
  });

  test('returns longer than the fund age are null, siAnn needs one year', () => {
    expect(horizonValue(5, '2026-01-06', '2026-08-31', 1)).toBeNull();
    expect(horizonValue(5, '2025-08-30', '2026-08-31', 1)).toBe(5);
    expect(horizonValue(7, '2022-11-21', '2026-08-31', 5)).toBeNull();
    expect(horizonValue(7, '', '2026-08-31', 5)).toBe(7);
    expect(horizonValue(null, '2010-01-01', '2026-08-31', 5)).toBeNull();
  });

  test('display dates are zero padded', () => {
    expect(formatGlobalXDate('2026-01-06')).toBe('Jan 06 2026');
    expect(formatGlobalXDate('2026-12-30')).toBe('Dec 30 2026');
  });
});

describe('controls: HISTORY_RANGE window, strict values, brand aliases', () => {
  const NOW = Date.parse('2026-10-02T00:00:00Z');
  test('max asks for everything, Ny sends an explicit period1/period2 window', () => {
    const all = new URL(yahooChartUrl('SIL', 'max', NOW));
    expect(all.searchParams.get('period1')).toBe('0');
    expect(all.searchParams.get('period2')).toBe(String(NOW / 1000));
    const five = new URL(yahooChartUrl('SIL', '5y', NOW));
    const p1 = Number(five.searchParams.get('period1'));
    expect(p1).toBeGreaterThan(0);
    expect(five.searchParams.has('range')).toBe(false);
    expect(Math.round((NOW / 1000 - p1) / 86_400 / 365.25)).toBe(5);
    expect(five.searchParams.get('interval')).toBe('1d');
  });

  test('HISTORY_RANGE other than max or Ny is an error, not a silent full history', () => {
    for (const bad of ['6mo', 'ytd', '0y', '-1y', 'abc', '5']) {
      expect(() => resolveControls(file(), {}, {}, { HISTORY_RANGE: bad })).toThrow();
      expect(() => yahooChartUrl('SIL', bad, NOW)).toThrow();
    }
    expect(readConfig(resolveControls(file(), {}, {}, { HISTORY_RANGE: '10Y' })).historyRange).toBe('10y');
    expect(readConfig(resolveControls(file())).historyRange).toBe('max');
  });

  test('a token that is not a ticker is an error', () => {
    expect(() => readConfig({ TICKERS: 'PAVE, ???' })).toThrow();
    expect(readConfig({ TICKERS: 'pave;aiq' }).tickers).toEqual(['PAVE', 'AIQ']);
  });

  test('GLOBALX_<NAME> works through resolveControls and beats the plain name', () => {
    expect(resolveControls(file(), {}, {}, { GLOBALX_CONCURRENCY: '7' }).CONCURRENCY).toBe('7');
    expect(resolveControls(file(), {}, {}, { GLOBALX_CONCURRENCY: '7', CONCURRENCY: '3' }).CONCURRENCY).toBe('7');
    expect(resolveControls(file(), {}, {}, { GLOBALX_TICKERS: '' }).TICKERS).toBe('');
    expect(() => resolveControls(file(), {}, {}, { GLOBALX_CONCURRENCY: '0' })).toThrow();
  });

  test('every return filter default is ":" like the sibling repos', () => {
    for (const [key, value] of Object.entries(file())) {
      if (/^(PERFORMANCE|TOTAL_RETURN)_/.test(key)) expect(value).toBe(':');
    }
  });
});

// ---------------------------------------------------------------------------
// Offline pipeline: main() against a mocked globalxetfs.com / Yahoo
// ---------------------------------------------------------------------------

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

describe('pipeline: whole-fund publishing, reruns, filters, cursor', () => {
  const dirs: string[] = [];
  const fresh = () => { const d = mkdtempSync(join(tmpdir(), 'globalx-')); dirs.push(d); return d; };
  const index = (dir: string) => JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
  const quiet = () => { const log = console.log; console.log = () => {}; return () => { console.log = log; }; };
  const afterAll_ = () => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); };

  test('a full run publishes every fund with a meta file, TEN_YEAR, 2 payments for semi-annual, no placeholder rows, net vs gross TER', async () => {
    const dir = fresh(); const mock = installMock(() => THREE.map((f) => ({ ...f, ten: 0.0836 }))); const unquiet = quiet();
    try {
      await run(dir);
      const idx = index(dir);
      expect(idx.funds.map((f: any) => f.ticker)).toEqual(['AAA', 'BBB', 'CCC']);
      for (const f of idx.funds) {
        expect(f.dataFile).toBe(`./funds/${f.ticker}/meta.json`);
        expect(existsSync(join(dir, 'funds', f.ticker, 'meta.json'))).toBe(true);
        expect(f.terValue).toBe(0.5);
        expect(f.terGrossValue).toBe(0.6);
      }
      expect(idx.funds[0].metrics.cagr10y).toBe(8.36);
      const meta = JSON.parse(readFileSync(join(dir, 'funds', 'AAA', 'meta.json'), 'utf8'));
      expect(meta.distributions.paymentsPerYear).toBe(2);
      expect(meta.distributions.rows.map((r: any) => r['Ex-Div Date'])).toEqual(['2026-06-29']);
      expect(readdirSync(dir, { recursive: true } as any).some((name: any) => String(name).includes('.tmp-'))).toBe(false);
    } finally { unquiet(); mock.restore(); afterAll_(); }
  });

  test('an identical rerun writes nothing (generatedAt included)', async () => {
    const dir = fresh(); const mock = installMock(() => THREE); const unquiet = quiet();
    try {
      await run(dir);
      const first = snapshot(dir);
      await new Promise((resolve) => setTimeout(resolve, 1100));
      await run(dir);
      expect(snapshot(dir)).toEqual(first);
    } finally { unquiet(); mock.restore(); afterAll_(); }
  });

  test('a one-ticker run keeps every row and every other fund untouched', async () => {
    const dir = fresh(); const mock = installMock(() => THREE); const unquiet = quiet();
    try {
      await run(dir);
      const before = snapshot(dir);
      await run(dir, { TICKERS: 'BBB' });
      const idx = index(dir);
      expect(idx.funds).toHaveLength(3);
      const after = snapshot(dir);
      for (const key of Object.keys(before)) if (!key.includes('/BBB/') && !key.endsWith('index.json')) expect(after[key]).toBe(before[key]);
      await expect(run(dir, { TICKERS: 'ZZZ' })).rejects.toThrow(/not in the Global X lineup/);
    } finally { unquiet(); mock.restore(); afterAll_(); }
  });

  test('CONCURRENCY=1 keeps one request in flight, CONCURRENCY=3 overlaps them', async () => {
    const one = fresh(); let mock = installMock(() => THREE, { delayMs: 15 }); const unquiet = quiet();
    try {
      await run(one, { CONCURRENCY: '1' });
      expect(mock.state.peak).toBe(1);
      mock.restore();
      mock = installMock(() => THREE, { delayMs: 15 });
      await run(fresh(), { CONCURRENCY: '3' });
      expect(mock.state.peak).toBeGreaterThanOrEqual(2);
    } finally { unquiet(); mock.restore(); afterAll_(); }
  });

  test('MAX_FETCHES walks the filtered set, wraps around and never sticks at the end', async () => {
    const dir = fresh(); const mock = installMock(() => THREE); const unquiet = quiet();
    try {
      const done: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        const before = snapshot(dir);
        await run(dir, { MAX_FETCHES: '2' });
        const after = snapshot(dir);
        done.push(...['AAA', 'BBB', 'CCC'].filter((t) => !(`/funds/${t}/meta.json` in before) && `/funds/${t}/meta.json` in after));
      }
      expect(done.sort()).toEqual(['AAA', 'BBB', 'CCC']);
      // a cursor sitting on the last ticker restarts from the top (the old code processed nothing)
      writeFileSync(join(dir, 'update-state.json'), JSON.stringify({ cursor: 'CCC' }));
      rmSync(join(dir, 'funds', 'AAA'), { recursive: true });
      await run(dir, { MAX_FETCHES: '1' });
      expect(existsSync(join(dir, 'funds', 'AAA', 'meta.json'))).toBe(true);
      // a TICKERS run never touches the cursor file
      writeFileSync(join(dir, 'update-state.json'), JSON.stringify({ cursor: 'BBB' }));
      await run(dir, { TICKERS: 'AAA' });
      expect(JSON.parse(readFileSync(join(dir, 'update-state.json'), 'utf8')).cursor).toBe('BBB');
    } finally { unquiet(); mock.restore(); afterAll_(); }
  });

  test('a row without published data has dataFile null and a full null metrics object (LLMA case)', async () => {
    const dir = fresh();
    const funds = [...THREE, { ticker: 'LLM', name: 'LLM ETF', pageOk: false }];
    const mock = installMock(() => funds); const unquiet = quiet();
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'index.json'), JSON.stringify({ generatedAt: 'x', source: {}, counts: {}, funds: [{ ticker: 'OLD', name: 'Old ETF', dataFile: './funds/OLD/meta.json', holdings: 0, history: 0 }] }));
      await run(dir);
      const rows = Object.fromEntries(index(dir).funds.map((f: any) => [f.ticker, f]));
      expect(rows.LLM.dataFile).toBeNull();
      expect(rows.OLD.dataFile).toBeNull();
      for (const key of ['ytd', 'tr1y', 'tr10y', 'siAnn', 'dividendYield', 'secYield']) expect(rows.LLM.metrics[key]).toBeNull();
      expect(rows.LLM.metrics.returnsBasis.length).toBeGreaterThan(0);
      expect(rows.AAA.dataFile).toBe('./funds/AAA/meta.json');
    } finally { unquiet(); mock.restore(); afterAll_(); }
  });

  test('a Yahoo failure keeps the published history, it never publishes an empty one', async () => {
    const dir = fresh(); let mock = installMock(() => THREE); const unquiet = quiet();
    try {
      await run(dir);
      const history = readFileSync(join(dir, 'funds', 'AAA', 'history', '001.json'), 'utf8');
      mock.restore();
      mock = installMock(() => THREE, { failYahoo: new Set(['AAA']) });
      await run(dir);
      expect(readFileSync(join(dir, 'funds', 'AAA', 'history', '001.json'), 'utf8')).toBe(history);
      expect(index(dir).funds[0].history).toBe(2);
    } finally { unquiet(); mock.restore(); afterAll_(); }
  });

  test('new lineup funds are announced and added to the step summary', async () => {
    const dir = fresh(); const summary = join(dir, 'summary.md'); const mock = installMock(() => THREE);
    const lines: string[] = []; const log = console.log; console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
    const savedSummary = process.env.GITHUB_STEP_SUMMARY;
    try {
      await run(dir);
      mock.restore();
      const more = installMock(() => [...THREE, { ticker: 'DDD', name: 'Delta Index ETF' }]);
      process.env.GITHUB_STEP_SUMMARY = summary;
      await run(dir, { TICKERS: 'DDD' });
      more.restore();
      expect(lines).toContain('NEW FUNDS: DDD');
      expect(readFileSync(summary, 'utf8')).toContain('NEW FUNDS: DDD');
    } finally {
      console.log = log; if (savedSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY; else process.env.GITHUB_STEP_SUMMARY = savedSummary;
      mock.restore(); afterAll_();
    }
  });

  test('yield and return filters exclude funds without a figure and write nothing for them', async () => {
    const dir = fresh();
    const funds: MockFund[] = [{ ticker: 'AAA', name: 'Alpha Index ETF', divYield: 3 }, { ticker: 'BBB', name: 'Beta Index ETF', divYield: 0 }];
    const mock = installMock(() => funds); const unquiet = quiet();
    try {
      await run(dir, { DIVIDEND_YIELD: '1:' });
      expect(existsSync(join(dir, 'funds', 'AAA', 'meta.json'))).toBe(true);
      expect(existsSync(join(dir, 'funds', 'BBB'))).toBe(false);
      expect(passesDataFilters({ tr10y: null, cagr10y: null }, {}, readConfig({ TOTAL_RETURN_10Y: '0:' }))).toBe(false);
      expect(passesDataFilters({ tr10y: 12, cagr10y: 2 }, {}, readConfig({ TOTAL_RETURN_10Y: '0:' }))).toBe(true);
    } finally { unquiet(); mock.restore(); afterAll_(); }
  });

  test('when every selected fund fails the run ends with an error', async () => {
    const dir = fresh(); const mock = installMock(() => THREE.map((f) => ({ ...f, pageOk: false }))); const unquiet = quiet();
    try {
      await expect(run(dir)).rejects.toThrow(/every selected fund failed/);
    } finally { unquiet(); mock.restore(); afterAll_(); }
  });

  test('the soft deadline stops taking funds but still writes the index', async () => {
    const dir = fresh(); const mock = installMock(() => THREE); const unquiet = quiet();
    try {
      await run(dir, {}, { deadlineMs: -1 });
      expect(index(dir).funds).toHaveLength(3);
      expect(index(dir).funds.every((f: any) => f.dataFile === null)).toBe(true);
    } finally { unquiet(); mock.restore(); afterAll_(); }
  });
});

describe('network: bounded attempts, no retry of final errors, atomic writes', () => {
  const original = globalThis.fetch;
  const cfg = () => readConfig({ MAX_RETRIES: '2', REQUEST_SLEEP: '0' });
  test('a request that never answers is aborted and retried, covering the body too', async () => {
    setFetchTuningForTests(40, 1);
    try {
      let calls = 0;
      globalThis.fetch = ((_url: any, init: any) => { calls += 1; return new Promise((_ok, fail) => init.signal.addEventListener('abort', () => fail(init.signal.reason))); }) as unknown as typeof fetch;
      await expect(fetchWithRetry('https://x.test/', {}, cfg(), 'hang')).rejects.toThrow();
      expect(calls).toBe(3);
      calls = 0;
      globalThis.fetch = ((_url: any, init: any) => { calls += 1; return Promise.resolve({ ok: true, text: () => new Promise((_ok, fail) => init.signal.addEventListener('abort', () => fail(init.signal.reason))) }); }) as unknown as typeof fetch;
      await expect(fetchWithRetry('https://x.test/', {}, cfg(), 'body', (r) => r.text())).rejects.toThrow();
      expect(calls).toBe(3);
    } finally { globalThis.fetch = original; setFetchTuningForTests(45_000, 1500); }
  });

  test('a 404 is final, a 503 is retried', async () => {
    setFetchTuningForTests(1000, 1);
    try {
      let calls = 0;
      globalThis.fetch = (async () => { calls += 1; return new Response('x', { status: 404 }); }) as unknown as typeof fetch;
      await expect(fetchWithRetry('https://x.test/', {}, cfg(), 'nf')).rejects.toThrow('HTTP 404');
      expect(calls).toBe(1);
      calls = 0;
      globalThis.fetch = (async () => { calls += 1; return new Response('x', { status: 503 }); }) as unknown as typeof fetch;
      await expect(fetchWithRetry('https://x.test/', {}, cfg(), 'busy')).rejects.toThrow('HTTP 503');
      expect(calls).toBe(3);
    } finally { globalThis.fetch = original; setFetchTuningForTests(45_000, 1500); }
  });

  test('writeIfChanged goes through a temp file and leaves only the target', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'globalx-w-'));
    try {
      expect(await writeIfChanged(join(dir, 'a.json'), '{}\n')).toBe('written');
      expect(await writeIfChanged(join(dir, 'a.json'), '{}\n')).toBe('unchanged');
      expect(readdirSync(dir)).toEqual(['a.json']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('an N-PORT series is matched by name, so another fund\'s filing is never used', () => {
    expect(sameSeries('Global X Silver Miners ETF', 'Silver Miners ETF')).toBe(true);
    expect(sameSeries('Global X Uranium ETF', 'Silver Miners ETF')).toBe(false);
    expect(sameSeries(null, 'Silver Miners ETF')).toBe(false);
  });
});
