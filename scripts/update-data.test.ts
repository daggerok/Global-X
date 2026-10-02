/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  CONTROL_NAMES,
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
