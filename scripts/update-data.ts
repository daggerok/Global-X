#!/usr/bin/env bun
/// <reference types="bun" />
import { readFile as outputReadFile, readdir as outputReadDir } from 'node:fs/promises';
import { createHash as outputCreateHash } from 'node:crypto';
import { join as outputJoin } from 'node:path';
import { fileURLToPath as outputFileURLToPath } from 'node:url';

// Console presentation; no changes to provider requests or persisted data.
/** Presentation only: no requests, writes, filtering, or changes to updater state. */

const outputClean = (value: unknown): string => String(value ?? 'null').replace(/[\r\n\t]+/g, ' ');
/** Presentation only: per-fund retry and fallback notices are printed when VERBOSE is enabled. */
const outputVerbose = (): boolean => /^(1|true|yes|on)$/i.test((globalThis as any).process?.env?.VERBOSE ?? '');
function outputNote(message: string): void { if (outputVerbose()) console.warn(message); }
/** Names are the canonical environment knobs, not internal parser properties. */
function outputConfigEntries(config: Record<string, any>): [string, string][] {
  const values = new Map<string, string>();
  const aliases: Record<string, string> = {
    requestSleepSeconds: 'REQUEST_SLEEP', categories: 'CATEGORY',
    aumRange: 'AUM', terRange: 'TER', dividendYieldRange: 'DIVIDEND_YIELD', secYieldRange: 'SEC_YIELD',
    performanceRanges: 'PERFORMANCE', totalReturnRanges: 'TOTAL_RETURN',
    skipVanEck: 'SKIP_VANECK', skipProShares: 'SKIP_PROSHARES',
    skipWisdomTree: 'SKIP_WISDOMTREE', skipGoldmanSachs: 'SKIP_GOLDMANSACHS',
    skipGlobalX: 'SKIP_GLOBALX', skipNorthernTrust: 'SKIP_NORTHERNTRUST',
  };
  const range = (v: any): string => typeof v === 'string' ? v : v?.source ?? `${Number.isFinite(v?.min) ? v.min : ''}:${Number.isFinite(v?.max) ? v.max : ''}`;
  for (const [key, value] of Object.entries(config)) {
    if (['proxyGapMs', 'fetchTimeoutMs', 'retryDelayMs'].includes(key)) continue;
    const name = aliases[key] ?? (/^[A-Z0-9_]+$/.test(key) ? key : key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase());
    if (name === 'PERFORMANCE' || name === 'TOTAL_RETURN') {
      for (const period of ['YTD', '1Y', '3Y', '5Y', '10Y']) values.set(`${name}_${period}`, range(value?.[period]));
    } else if (['AUM', 'TER', 'DIVIDEND_YIELD', 'SEC_YIELD'].includes(name)) {
      values.set(name, range(value));
    } else {
      values.set(name, value instanceof Set ? [...value].join(',') || 'all' : Array.isArray(value) ? value.join(',') || 'all' : outputClean(value));
    }
  }
  const first = ['MAX_FETCHES', 'REQUEST_SLEEP', 'CONCURRENCY'];
  return [...values].sort(([a], [b]) => {
    const ai = first.indexOf(a), bi = first.indexOf(b);
    return (ai < 0 ? first.length : ai) - (bi < 0 ? first.length : bi) || a.localeCompare(b);
  });
}
function outputConfigValue(key: string, value: string): string {
  if (/TOKEN|PASSWORD|SECRET|COOKIE|SEC_UA/i.test(key)) return '<redacted>';
  if (key === 'TICKERS' && ['', 'null', 'undefined'].includes(value)) return 'all';
  return outputClean(value);
}
function outputPrintConfig(brand: string, config: Record<string, any>): void {
  const entries: [string, string][] = [...outputConfigEntries(config), ['VERBOSE', String(outputVerbose())]];
  console.log(`[ config   ] ${brand} updater:\n${entries.map(([key, value]) => `              ${key}=${outputConfigValue(key, value)}`).join('\n')}`);
}
function outputHasOutputFilters(config: Record<string, any>): boolean {
  return outputConfigEntries(config).some(([name, value]) =>
    /^(CATEGORY|AUM|TER|DIVIDEND_YIELD|SEC_YIELD|PERFORMANCE_|TOTAL_RETURN_)/.test(name) &&
    !['', ':', 'null', 'all'].includes(value));
}
function outputPrintFilter(selected: number, total: number, deferred = false): void {
  console.log(`[ filter   ] ${selected} of ${total} funds ${deferred ? 'selected for evaluation (data-dependent filters applied per fund)' : 'pass filters'}`);
}
function outputStable(value: any): any {
  if (Array.isArray(value)) return value.map(outputStable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => !['generatedAt', 'catalogReadAt'].includes(key)).map(key => [key, outputStable(value[key])]));
  return value;
}
function outputContentKey(value: unknown): string { return JSON.stringify(outputStable(value)) ?? 'null'; }
async function outputInspectFund(root: URL | string, ticker: string): Promise<{ digest: string; meta: any }> {
  const dir = outputJoin(root instanceof URL ? outputFileURLToPath(root) : root, 'funds', ticker);
  const hash = outputCreateHash('sha256');
  async function visit(path: string): Promise<void> {
    const entries = await outputReadDir(path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) await visit(outputJoin(path, entry.name));
      else if (entry.name.endsWith('.json')) {
        const text = await outputReadFile(outputJoin(path, entry.name), 'utf8').catch(() => '');
        hash.update(outputJoin(path.slice(dir.length), entry.name));
        try { hash.update(outputContentKey(JSON.parse(text))); } catch { hash.update(text); }
      }
    }
  }
  await visit(dir);
  const meta = await outputReadFile(outputJoin(dir, 'meta.json'), 'utf8').then(JSON.parse).catch(() => ({}));
  return { digest: hash.digest('hex'), meta };
}
const outputCount = (value: any): unknown => typeof value === 'number' ? value : Array.isArray(value) ? value.length : value?.totalRows ?? value?.rows?.length ?? null;
const outputScalar = (value: any): any => value && typeof value === 'object' ? value.display ?? value.value ?? null : value;
const outputUnits: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12, THOUSAND: 1e3, MILLION: 1e6, BILLION: 1e9, TRILLION: 1e12 };
function outputMoney(value: any): string {
  const raw = value && typeof value === 'object' && typeof value.value === 'number' && Number.isFinite(value.value) ? value.value : outputScalar(value);
  if (raw === null || raw === undefined || raw === '—' || raw === '--') return 'null';
  const text = String(raw).replace(/[$,\s]/g, '');
  const match = text.match(/^([+-]?[\d.]+)(K|M|B|T|Thousand|Million|Billion|Trillion)?$/i);
  if (!match) return outputClean(raw);
  const number = Number(match[1]) * (outputUnits[match[2]?.toUpperCase() ?? ''] ?? 1);
  if (!Number.isFinite(number)) return 'null';
  for (const [unit, scale] of [['T', 1e12], ['B', 1e9], ['M', 1e6], ['K', 1e3]] as const) {
    if (Math.abs(number) >= scale) return `$${(number / scale).toFixed(1)}${unit}`;
  }
  return `$${number.toFixed(2)}`;
}
/** Yields: rounded to 2 decimals without trailing zeros; placeholders are omitted like null. */
function outputPercent(value: any): unknown {
  const raw = outputScalar(value);
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? Number(raw.toFixed(2)) : null;
  const text = String(raw).trim().replace(/%$/, '').trim();
  if (['', '-', '—', '--', 'n/a'].includes(text.toLowerCase())) return null;
  const number = Number(text.replace(/,/g, ''));
  return Number.isFinite(number) ? Number(number.toFixed(2)) : outputClean(raw);
}
function outputFundLine(index: number, total: number, ticker: string, status: string, data: any = {}, reason?: unknown): string {
  const width = Math.max(2, String(total).length);
  const metrics = data.metrics ?? {};
  // Presentation only. Keep valid zero/false values; omit unavailable fields.
  // outputMoney returns the string 'null' for an unavailable monetary value.
  const field = (key: string, value: unknown): string =>
    value === null || value === undefined || value === 'null' ? '' : `${key}=${outputClean(value)}`;
  const sources = [
    field('official', data.officialHistoryCount),
    field('yahoo', data.yahooHistoryCount),
  ].filter(part => part !== '').join(' ');
  const detail = [
    field('port', data.portId ?? data.portfolioId),
    field('history', outputCount(data.history ?? data.historyCount)),
    sources ? `(${sources})` : '',
    field('holdings', outputCount(data.holdings ?? data.holdingsCount)),
    field('divs', outputCount(data.worksheets?.Distributions ?? data.distributions)),
    field('netAssets', outputMoney(data.netAssets ?? data.aum)),
    field('total', outputMoney(data.totalFundNetAssets ?? data.totalNetAssets)),
    field('div', outputPercent(data.trailingYield ?? data.yields?.effectiveYield ?? data.yields?.dividendYield ?? data.dividendYield ?? metrics.dividendYield)),
    field('sec', outputPercent(data.secYield ?? data.yields?.secYield ?? metrics.secYield)),
    field('wp', data.workplaceRaw),
  ].filter(part => part !== '').join(' ');
  return `[ ${String(index).padStart(width)}/${String(total).padEnd(width)}  ] ${outputClean(ticker).padEnd(5)} ${status.padEnd(9)}${detail ? ` ${detail}` : ''}${reason ? ` reason=${outputClean(reason)}` : ''}`;
}
function outputCreateReporter(root: URL | string, total: number) {
  let completed = 0;
  const tally = new Map<string, number>();
  return {
    before: (ticker: string) => outputInspectFund(root, ticker),
    async result(ticker: string, before: { digest: string }, status?: string, reason?: unknown, extra: any = {}) {
      const after = await outputInspectFund(root, ticker);
      const final = status ?? (before.digest === after.digest ? 'unchanged' : 'updated');
      tally.set(final, (tally.get(final) ?? 0) + 1);
      console.log(outputFundLine(++completed, total, ticker, final, { ...after.meta, ...extra }, reason));
    },
    /** First [ done ] line: the statuses of every fund line this reporter printed. */
    summary(startedAt: number): string {
      const order = ['updated', 'unchanged', 'kept', 'skipped', 'failed'];
      const statuses = [...order, ...[...tally.keys()].filter(status => !order.includes(status))];
      return `[ done     ] ${completed} fund${completed === 1 ? '' : 's'}: ${statuses.map(status => `${tally.get(status) ?? 0} ${status}`).join(', ')} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
    },
  };
}
/** Second [ done ] line: published totals. */
function outputCounts(funds: number, holdings: number, history: number): string {
  return `[ done     ] counts: ${funds.toLocaleString('en-US')} funds / ${holdings.toLocaleString('en-US')} holdings rows / ${history.toLocaleString('en-US')} history rows`;
}

/**
 * @file Global X static feed updater.
 *
 * Zero runtime dependencies: `node:fs/promises` + global `fetch` only, run with
 * Bun. Writes the deterministic `api/globalx/**` tree the browser app reads.
 *
 * Source ladder:
 *   (a) official globalxetfs.com ETF lineup table ..... fund universe, name,
 *       (`/explore`, Flight `rows`)                     category grouping,
 *                                                     declared frequency,
 *                                                     distribution rate,
 *                                                     gross/net expenses,
 *                                                     net assets, inception
 *   (b) official per-fund page ...................... Fund Details and ETF
 *       (`https://www.globalxetfs.com/funds/<ticker>/`)      Prices panels (CUSIP,
 *                                                      ISIN, NAV, market price,
 *                                                      daily change, exchange,
 *                                                      shares outstanding), the
 *                                                      latest premium/discount,
 *                                                      the distribution metric
 *                                                      cards and history, the
 *                                                      month/quarter-end Returns
 *                                                      tables and the document
 *                                                      links
 *   (c) official daily full-holdings CSV ............ every position, market
 *       (assets.globalxetfs.com/funds/holdings/)       value, weight, net assets
 *   (d) SEC EDGAR Form N-PORT-P ..................... holdings fallback only
 *       (Global X Funds CIK 0001432353)                (EDGAR_FALLBACK=1)
 *   (e) Yahoo Finance chart API ..................... daily Close / Adj Close /
 *                                                      Volume, and the dividend
 *                                                      history as a fallback
 *   (f) browser N-PORT dropzone ..................... user-supplied override
 *
 * The globalxetfs.com endpoints are the issuer's own public pages and downloads:
 * the ETF lineup and fund pages carry the headline figures, and each fund page's
 * holdings download names the as-of day of the dated assets.globalxetfs.com file.
 * Nothing is scraped from a client-rendered widget and no value is invented:
 * a metric Global X does not publish stays `null` and the app renders `—`.
 */
import { mkdir, readFile, readdir, writeFile, rm, rename, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// --- TLS trust store (identical in every ETF repo) ---
const SYSTEM_CA_MARKER = 'ETF_UPDATER_SYSTEM_CA';
const CERT_ERROR = /UNABLE_TO_GET_ISSUER_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT|CERT_HAS_EXPIRED|unable to get (?:local )?issuer certificate|self[- ]signed certificate|certificate has expired/i;

export function isCertError(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown; cause?: unknown } | null;
  return CERT_ERROR.test(`${String(e?.code ?? '')} ${String(e?.message ?? '')}`) || (e?.cause ? isCertError(e.cause) : false);
}

export function systemCaActive(env: Record<string, string | undefined> = process.env, execArgv: string[] = process.execArgv): boolean {
  return execArgv.includes('--use-system-ca') || env.NODE_USE_SYSTEM_CA === '1' || env[SYSTEM_CA_MARKER] === '1';
}

export function reexecWithSystemCa(): never {
  const child = Bun.spawnSync([process.execPath, '--use-system-ca', ...process.argv.slice(1)], {
    env: { ...process.env, [SYSTEM_CA_MARKER]: '1' },
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  process.exit(child.exitCode ?? 1);
}

/** mode: auto (restart once on an untrusted-certificate error), true (restart now), false (never). */
export function installSystemCa(mode: string, reexec: () => never = reexecWithSystemCa, active: boolean = systemCaActive()): void {
  if (mode === 'false' || active) return;
  if (mode === 'true') reexec();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    try { return await realFetch(...args); }
    catch (error) {
      if (!isCertError(error)) throw error;
      console.error('[ notice   ] TLS certificate not trusted; restarting once with --use-system-ca');
      return reexec();
    }
  }) as typeof fetch;
}

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let API_ROOT = path.join(REPO_ROOT, 'api', 'globalx');
/** Test hook: the output directory is fixed for real runs (never a control). */
export function setApiRootForTests(dir: string): void { API_ROOT = dir; }

export const GLOBALX_SITE = 'https://www.globalxetfs.com';
export const GLOBALX_LINEUP_URL = 'https://www.globalxetfs.com/explore';
/** Global X Funds — the registrant that files Form N-PORT-P for the ETFs (Investment Company Act file 811-22209). */
export const GLOBALX_ETF_TRUST_CIK = '0001432353';
export const GLOBALX_ETF_TRUST_FILE_NUMBER = '811-22209';

/** Canonical slug for a fund page. Every Global X fund page is the lowercase ticker. */
export function globalxFundPageUrl(ticker: string): string {
    return `https://www.globalxetfs.com/funds/${ticker.toLowerCase()}/`;
  }

/**
 * The official daily holdings download of a Global X fund, a dated asset such as
 * `https://assets.globalxetfs.com/funds/holdings/pave_full-holdings_20260925.csv`.
 * The page linked it until 2026-10; the redesigned page links no CSV, but its
 * holdings modal names the as-of day (`PAVE-holdings-Sep-25-2026.csv`), which
 * is the date of that official file.
 */
export function globalxHoldingsCsvUrl(ticker: string, html?: string): string {
  if (html) {
    const match = html.match(/https:\/\/assets\.globalxetfs\.com\/funds\/holdings\/[^"'\\ ]+_full-holdings_\d{8}\.csv/i);
    if (match) return match[0];
    const named = new RegExp(String.raw`\\?"fileName\\?":\\?"${sanitizeTicker(ticker)}-holdings-([A-Za-z]{3})-(\d{1,2})-(\d{4})\.csv`, 'i').exec(html);
    const day = named ? toIsoDate(`${named[1]} ${named[2]}, ${named[3]}`) : '';
    if (day) return `https://assets.globalxetfs.com/funds/holdings/${sanitizeTicker(ticker).toLowerCase()}_full-holdings_${day.replace(/-/g, '')}.csv`;
  }
  // The date is supplied by the live fund page. This fallback is only for a
  // page response that omits the link; it is never written as provenance.
  return `https://assets.globalxetfs.com/funds/holdings/${sanitizeTicker(ticker).toLowerCase()}_full-holdings.csv`;
}

export function globalxProvenanceHoldingsUrl(ticker: string, html?: string): string {
  return globalxHoldingsCsvUrl(ticker, html);
}

export const YAHOO_CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';

/** `max` or `<N>y`; anything else is rejected instead of silently falling back to the full history. */
export function parseHistoryRange(raw: string): { years: number | null } {
  const text = cleanText(raw).toLowerCase() || 'max';
  if (text === 'max') return { years: null };
  const match = /^(\d+)y$/.exec(text);
  if (!match || Number(match[1]) < 1) throw new Error(`HISTORY_RANGE: expected "max" or "<N>y" (N >= 1), received "${raw}"`);
  return { years: Number(match[1]) };
}

/**
 * Daily bars for the requested window. Yahoo ignores `range` when `period1=0`,
 * so a bounded range is an explicit period1/period2 pair.
 */
export function yahooChartUrl(ticker: string, range: string = 'max', nowMs: number = Date.now()): string {
  const clean = sanitizeTicker(ticker);
  const period2 = Math.floor(nowMs / 1000);
  const { years } = parseHistoryRange(range);
  const period1 = years === null ? 0 : Math.floor(period2 - years * 365.25 * 86_400);
  return `${YAHOO_CHART_URL}/${encodeURIComponent(clean)}?period1=${period1}&period2=${period2}` +
    '&interval=1d&events=div%7Csplit&includeAdjustedClose=true';
}

export function yahooChartProvenanceUrl(ticker: string): string {
  return `${YAHOO_CHART_URL}/${encodeURIComponent(sanitizeTicker(ticker))}`;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function pad3(value: number): string {
  return String(value).padStart(3, '0');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sanitizeTicker(raw: unknown): string {
  return String(raw ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

export function cleanText(raw: unknown): string {
  return String(raw ?? '')
    .replace(/[\u00ae\u2122]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A cell that reads as missing. KEYS on the normalized text, so `N/A` and `--` behave. */
const MISSING_CELL = new Set(['', '-', '--', '---', '—', '–', 'n/a', 'na', 'none', 'null', 'nan']);

export function isMissingCell(raw: unknown): boolean {
  const text = cleanText(raw).toLowerCase();
  return MISSING_CELL.has(text);
}

/**
 * Expand the scientific notation some providers emit and undo the `$`, `%`,
 * thousands separators and parentheses negatives before parsing.
 * `"2.97E8"` -> `"297057744"`, `"$-201,630.00"` -> `"-201630.00"`.
 */
export function normalizeNumberText(raw: unknown): string {
  let text = cleanText(raw);
  if (!text) return '';
  if (isMissingCell(text)) return '';
  const negativeParentheses = /^\((.*)\)$/.exec(text);
  if (negativeParentheses) text = `-${negativeParentheses[1]}`;
  text = text.replace(/[$,%\s*\u2020\u2021\u2022]/g, '');
  text = text.replace(/([eE])([+-]?\d+)$/, (_m, e: string, exp: string) => `E${exp}`);
  if (/^-?\d*\.?\d+[eE][+-]?\d+$/.test(text)) {
    const parsed = Number(text);
    if (Number.isFinite(parsed)) return String(parsed);
  }
  return text;
}

export function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = normalizeNumberText(value);
  if (!text || text === '-' || text === '+') return null;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return null;
  // Some providers emit a denormal sentinel instead of null.
  if (Math.abs(parsed) < 1e-290 && parsed !== 0) return null;
  return parsed;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function formatAumDisplay(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e12) return `$${(value / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(value / 1e3).toFixed(2)}K`;
  return `$${value.toFixed(2)}`;
}

export function formatMoneyText(value: number | null): string {
  return value === null ? '—' : `$${value.toFixed(2)}`;
}

export function formatPercentText(value: number | null, digits = 2): string {
  return value === null ? '—' : `${value.toFixed(digits)}%`;
}

/** `08/29/2022` -> `Aug 29 2022`; ISO and `August 29, 2022` also accepted. */
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function toIsoDate(raw: unknown): string {
  const text = cleanText(raw);
  const flightDate = /^\$D(\d{4}-\d{2}-\d{2})/.exec(text);
  if (flightDate) return flightDate[1];
  // ISO, U.S. and month-name dates: pure calendar text, the same day in every time zone (shared calendar-dates block)
  return calendarIso(text) ?? '';
}

/** `08/29/2022` -> `Aug 29 2022`. Returns the cleaned input when unparseable. */
export function formatGlobalXDate(raw: unknown): string {
  const iso = toIsoDate(raw);
  if (!iso) return cleanText(raw);
  const [year, month, day] = iso.split('-');
  return `${MONTH_SHORT[Number(month) - 1]} ${day.padStart(2, '0')} ${year}`;
}

/** Chronological comparator for the display dates this feed publishes (`Aug 29 2022`). */
export function compareDisplayDates(a: string, b: string): number {
  const left = toIsoDate(a);
  const right = toIsoDate(b);
  if (left && right) return left < right ? -1 : left > right ? 1 : 0;
  return String(a).localeCompare(String(b));
}

export function todayStamp(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type Range = { min: number; max: number };
export type ReturnPeriod = 'YTD' | '1Y' | '3Y' | '5Y' | '10Y';
const RETURN_PERIODS: readonly ReturnPeriod[] = ['YTD', '1Y', '3Y', '5Y', '10Y'];
type RangeMap = Partial<Record<ReturnPeriod, Range>>;

type UpdaterConfig = {
  concurrency: number;
  requestSleep: number;
  maxFetches: number;
  holdingsPageSize: number;
  historyPageSize: number;
  storeRawDownloads: boolean;
  maxRetries: number;
  tickers: string[];
  historyRange: string;
  category: string;
  secUa: string;
  skipYahoo: boolean;
  skipGlobalX: boolean;
  edgarFallback: boolean;
  aumRange?: Range & { source?: string };
  terRange?: Range;
  dividendYieldRange?: Range;
  secYieldRange?: Range;
  performanceRanges: RangeMap;
  totalReturnRanges: RangeMap;
};

const AUM_PRESET_BOUNDS = {
  nano: { min: 0, max: 10_000_000 },
  micro: { min: 10_000_000, max: 300_000_000 },
  small: { min: 300_000_000, max: 2_000_000_000 },
  mid: { min: 2_000_000_000, max: 10_000_000_000 },
  large: { min: 10_000_000_000, max: undefined },
} as const;
type AumPreset = keyof typeof AUM_PRESET_BOUNDS;

const AMOUNT_SUFFIXES: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };

function envValue(env: Record<string, string | undefined>, name: string, aliases: string[] = []): string {
  for (const key of [name, ...aliases]) {
    const value = env[key];
    if (value !== undefined && value !== '') return String(value).trim();
  }
  return '';
}

function parsePositiveInt(raw: string, fallback: number): number {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(raw: string, fallback: number): number {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseNonNegativeFloat(raw: string, fallback: number): number {
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseBoolean(raw: string, fallback = false): boolean {
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(raw.toLowerCase());
}

/**
 * Strict `min:max` range. `""` and `":"` mean "no restriction"; percent and `$`
 * signs are optional; exactly one colon is required; a configured min must not
 * exceed max.
 */
export function parseRange(raw: string, label: string): Range | undefined {
  const text = cleanText(raw);
  if (!text || text === ':') return undefined;
  const parts = text.split(':');
  if (parts.length !== 2) {
    throw new Error(`${label}: expected "min:max" with exactly one colon, received "${raw}"`);
  }
  const parseBound = (value: string, side: 'min' | 'max'): number => {
    const cleaned = value.replace(/[$,%\s]/g, '');
    if (!cleaned) return side === 'min' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
    const parsed = Number(cleaned);
    if (!Number.isFinite(parsed)) throw new Error(`${label}: "${value}" is not a number`);
    return parsed;
  };
  const range = { min: parseBound(parts[0], 'min'), max: parseBound(parts[1], 'max') };
  if (range.min > range.max) throw new Error(`${label}: min ${range.min} is greater than max ${range.max}`);
  return range;
}

function parseAumBound(bound: string): number | undefined {
  const cleaned = bound.replace(/[$,\s]/g, '');
  if (!cleaned) return undefined;
  const preset = AUM_PRESET_BOUNDS[cleaned.toLowerCase() as AumPreset];
  if (preset) return preset.min;
  const match = /^(-?\d+(?:\.\d+)?)([KMBT])?$/i.exec(cleaned);
  if (!match) throw new Error(`AUM: "${bound}" is not an amount, a K/M/B/T suffix or a preset`);
  const base = Number(match[1]);
  const suffix = match[2] ? AMOUNT_SUFFIXES[match[2].toUpperCase()] : 1;
  return base * suffix;
}

export function parseAumRange(raw: string): (Range & { source?: string }) | undefined {
  const text = cleanText(raw);
  if (!text || text === ':') return undefined;
  const presetOnly = AUM_PRESET_BOUNDS[text.toLowerCase() as AumPreset];
  // A bare preset (`AUM=micro`) is the whole range, exactly as in the siblings.
  if (presetOnly) return { min: presetOnly.min, max: presetOnly.max ?? Number.POSITIVE_INFINITY, source: raw };
  const parts = text.split(':');
  if (parts.length !== 2) throw new Error(`AUM: expected "min:max" with exactly one colon, received "${raw}"`);

  const leftPreset = AUM_PRESET_BOUNDS[parts[0].replace(/[$,\s]/g, '').toLowerCase() as AumPreset];
  const rightPreset = AUM_PRESET_BOUNDS[parts[1].replace(/[$,\s]/g, '').toLowerCase() as AumPreset];

  let min = parseAumBound(parts[0]);
  let max: number | undefined;
  if (rightPreset && !/\d/.test(parts[1])) {
    // A preset on the right contributes its exclusive upper bound; `large` has none.
    max = rightPreset.max;
  } else {
    max = parseAumBound(parts[1]);
  }
  if (leftPreset && !/\d/.test(parts[0])) min = leftPreset.min;
  const range = {
    min: min ?? Number.NEGATIVE_INFINITY,
    max: max ?? Number.POSITIVE_INFINITY,
    source: raw,
  };
  if (range.min > range.max) throw new Error(`AUM: min ${range.min} is greater than max ${range.max}`);
  return range;
}

function parseRanges(env: Record<string, string | undefined>, prefix: 'PERFORMANCE' | 'TOTAL_RETURN'): RangeMap {
  const ranges: RangeMap = {};
  for (const period of RETURN_PERIODS) {
    const raw = envValue(env, `${prefix}_${period}`);
    if (!raw) continue;
    const range = parseRange(raw, `${prefix}_${period}`);
    if (range) ranges[period] = range;
  }
  return ranges;
}

const SEC_UA_DEFAULT = 'daggerok ETF feed daggerok@gmail.com';

export function readConfig(env: Record<string, string | undefined> = process.env): UpdaterConfig {
  return {
    concurrency: parsePositiveInt(envValue(env, 'CONCURRENCY'), 2),
    requestSleep: parseNonNegativeFloat(envValue(env, 'REQUEST_SLEEP'), 2),
    maxFetches: parseNonNegativeInt(envValue(env, 'MAX_FETCHES'), 0),
    holdingsPageSize: parsePositiveInt(envValue(env, 'HOLDINGS_PAGE_SIZE'), 250),
    historyPageSize: parsePositiveInt(envValue(env, 'HISTORY_PAGE_SIZE', ['HISTORICAL_PAGE_SIZE']), 1000),
    storeRawDownloads: parseBoolean(envValue(env, 'STORE_RAW_DOWNLOADS')),
    maxRetries: parsePositiveInt(envValue(env, 'MAX_RETRIES'), 3),
    tickers: envValue(env, 'TICKERS')
      .split(/[\s,;]+/)
      .filter(Boolean)
      .map((token) => {
        const ticker = sanitizeTicker(token);
        if (!/^[A-Z]{1,6}$/.test(ticker)) throw new Error(`TICKERS: "${token}" is not a ticker`);
        return ticker;
      }),
    historyRange: (parseHistoryRange(envValue(env, 'HISTORY_RANGE')), (envValue(env, 'HISTORY_RANGE') || 'max').toLowerCase()),
    category: cleanText(envValue(env, 'CATEGORY')),
    secUa: envValue(env, 'SEC_UA') || SEC_UA_DEFAULT,
    skipYahoo: parseBoolean(envValue(env, 'SKIP_YAHOO')),
    skipGlobalX: parseBoolean(envValue(env, 'SKIP_GLOBALX')),
    edgarFallback: parseBoolean(envValue(env, 'EDGAR_FALLBACK')),
    aumRange: parseAumRange(envValue(env, 'AUM')),
    terRange: parseRange(envValue(env, 'TER'), 'TER'),
    dividendYieldRange: parseRange(envValue(env, 'DIVIDEND_YIELD'), 'DIVIDEND_YIELD'),
    secYieldRange: parseRange(envValue(env, 'SEC_YIELD'), 'SEC_YIELD'),
    performanceRanges: parseRanges(env, 'PERFORMANCE'),
    totalReturnRanges: parseRanges(env, 'TOTAL_RETURN'),
  };
}

// File defaults and explicit overrides, same mechanism as the sibling ETF
// updaters: allowlisted scalar controls only, so GitHub Actions can resolve them
// without interpolating user input into bash. Precedence: config file <
// advanced JSON < nonblank inputs < environment.
export const CONTROL_NAMES = [
  'MAX_FETCHES', 'REQUEST_SLEEP', 'CONCURRENCY', 'MAX_RETRIES', 'TICKERS', 'CATEGORY',
  'AUM', 'TER', 'DIVIDEND_YIELD', 'SEC_YIELD',
  'HOLDINGS_PAGE_SIZE', 'HISTORY_PAGE_SIZE', 'HISTORY_RANGE', 'STORE_RAW_DOWNLOADS',
  'EDGAR_FALLBACK', 'SKIP_YAHOO', 'SKIP_GLOBALX', 'SEC_UA', 'VERBOSE', 'USE_SYSTEM_CA',
  ...['PERFORMANCE', 'TOTAL_RETURN'].flatMap((prefix) => RETURN_PERIODS.map((period) => `${prefix}_${period}`)),
] as const;
export type ControlName = (typeof CONTROL_NAMES)[number];
export const CONFIG_FILE_URL = new URL('./update-data.config.json', import.meta.url);
// Existing environment aliases that keep working.
const CONTROL_ALIASES: Partial<Record<ControlName, string>> = { HISTORY_PAGE_SIZE: 'HISTORICAL_PAGE_SIZE' };

export function resolveControls(
  file: unknown = {},
  advanced: unknown = {},
  inputs: unknown = {},
  env: Record<string, string | undefined> = {},
): Record<string, string> {
  const result: Record<string, string> = {};
  const known = new Set<string>(CONTROL_NAMES);
  const apply = (value: unknown, skipEmpty = false): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Configuration must be a JSON object');
    for (const [key, raw] of Object.entries(value)) {
      if (!known.has(key)) throw new Error(`Unknown updater control: ${key}`);
      if (skipEmpty && (raw === '' || raw === undefined || raw === null)) continue;
      if (!['string', 'number', 'boolean'].includes(typeof raw)) throw new Error(`${key}: expected string, number or boolean`);
      const text = String(raw);
      if (/[\r\n\0]/.test(text)) throw new Error(`${key}: multiline/control characters are not allowed`);
      result[key] = text;
    }
  };
  apply(file);
  apply(advanced);
  apply(inputs, true);
  for (const key of CONTROL_NAMES) {
    const alias = CONTROL_ALIASES[key];
    // GLOBALX_<NAME> beats <NAME>, which beats the legacy alias; an explicitly empty value wins like any other.
    const value = env[`GLOBALX_${key}`] ?? env[key] ?? (alias ? env[alias] : undefined);
    if (value !== undefined) apply({ [key]: value });
  }
  for (const key of ['MAX_FETCHES', 'CONCURRENCY', 'HOLDINGS_PAGE_SIZE', 'HISTORY_PAGE_SIZE', 'MAX_RETRIES']) {
    const v = result[key]?.trim();
    if (v === undefined || v === '') continue;
    const min = key === 'MAX_FETCHES' ? 0 : 1;
    if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v)) || Number(v) < min) throw new Error(`${key}: expected integer >= ${min}`);
  }
  if (result.USE_SYSTEM_CA !== undefined) {
    const mode = result.USE_SYSTEM_CA.trim().toLowerCase();
    if (!['auto', 'true', 'false'].includes(mode)) throw new Error('USE_SYSTEM_CA: expected auto, true or false');
    result.USE_SYSTEM_CA = mode;
  }
  if (result.REQUEST_SLEEP?.trim() && (!Number.isFinite(Number(result.REQUEST_SLEEP)) || Number(result.REQUEST_SLEEP) < 0)) throw new Error('REQUEST_SLEEP: expected nonnegative seconds');
  for (const key of ['STORE_RAW_DOWNLOADS', 'EDGAR_FALLBACK', 'SKIP_YAHOO', 'SKIP_GLOBALX', 'VERBOSE']) {
    if (result[key]?.trim() && !/^(0|1|true|false|yes|no|y|n|on|off)$/i.test(result[key].trim())) throw new Error(`${key}: expected boolean`);
  }
  parseHistoryRange(result.HISTORY_RANGE ?? 'max');
  readConfig(result); // validate every min:max filter before any request or write
  return result;
}

export async function runtimeControls(env: Record<string, string | undefined> = process.env): Promise<Record<string, string>> {
  let file: unknown = {};
  try { file = JSON.parse(await readFile(CONFIG_FILE_URL, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return resolveControls(file, {}, {}, env);
}

const USAGE = `
Global X ETF static feed updater (zero dependencies, run with Bun).

  bun ./scripts/update-data.ts [-h|--help]

Defaults live in scripts/update-data.config.json. Precedence: config file <
advanced JSON (workflow) < nonblank workflow inputs < environment variables.

Controls (all optional):

  MAX_FETCHES          0     Funds to process. 0 = full pass. A positive value
                             resumes after the committed cursor in
                             api/globalx/update-state.json.
  REQUEST_SLEEP        2     Minimum seconds between request starts.
                             globalxetfs.com throttles bursts with an SSL reset,
                             so keep this at 2s or more.
  CONCURRENCY          2     Parallel fund workers; every worker has its own paced request lane
                             (REQUEST_SLEEP apart), so CONCURRENCY multiplies throughput.
  MAX_RETRIES          3     Retries (integer >= 1) for network errors and 408/425/429/5xx.
  TICKERS              ""    Space/comma separated tickers. ANDed with the other
                             filters, never overriding them.
  AUM                  ""    "min:max" dollars, K/M/B/T suffixes, or a preset:
                             nano <$10M | micro $10M-$300M | small $300M-$2B |
                             mid $2B-$10B | large >=$10B
  TER                  ""    "min:max" expense ratio percent.
  DIVIDEND_YIELD       ""    "min:max" distribution-rate percent.
  SEC_YIELD            ""    "min:max" 30-day SEC yield percent.
  PERFORMANCE_YTD|1Y|3Y|5Y|10Y   "min:max" official fund-page NAV return percent.
  TOTAL_RETURN_YTD|1Y|3Y|5Y|10Y  "min:max" derived cumulative total return percent.
  HOLDINGS_PAGE_SIZE   250   Rows per holdings page file.
  HISTORY_PAGE_SIZE    1000  Rows per history page file (alias
                             HISTORICAL_PAGE_SIZE).
  HISTORY_RANGE        max   Yahoo daily history window: "max" or "<N>y" (N years,
                             sent as an explicit period1/period2). Anything else
                             is an error.
  CATEGORY             ""    Keep only this Global X THEME / SUB_THEME category.
  STORE_RAW_DOWNLOADS  0     1|true|yes|y|on writes api/globalx/raw/**.
  SEC_UA               "daggerok ETF feed daggerok@gmail.com"
                             Declared User-Agent for SEC EDGAR requests; the
                             protected Actions variable SEC_UA wins in the workflow.
  EDGAR_FALLBACK       0     Use Form N-PORT-P when a fund has no holdings CSV.
  SKIP_YAHOO           0     Skip Yahoo Finance (daily history, dividend fallback).
  SKIP_GLOBALX         0     Skip globalxetfs.com entirely (keeps committed data).
  VERBOSE              0     1|true|yes|y|on prints per-fund retry and fallback notices.
  USE_SYSTEM_CA        auto  auto|true|false. auto restarts the updater once with
                             Bun's --use-system-ca when a request fails with an
                             untrusted-certificate error; true always uses the
                             system CA store; false never restarts.

Range syntax is strict "min:max" with exactly one colon; "" and ":" mean no
restriction; a configured min must not exceed max.

Examples:

  TICKERS="SPYI QQQI CSHI" bun ./scripts/update-data.ts
  MAX_FETCHES=5 bun ./scripts/update-data.ts
  AUM="1B:" TER=":0.70" bun ./scripts/update-data.ts
  CATEGORY="Fixed Income" bun ./scripts/update-data.ts
`;

// ---------------------------------------------------------------------------
// Politeness & fetching
// ---------------------------------------------------------------------------

// One pacing lane per concurrent worker (sized from config.concurrency
// where the worker pool is started). A single shared chain serialized every
// request through one FIFO regardless of concurrency; CONCURRENCY workers
// now each get their own paced lane, so concurrency actually multiplies
// throughput as documented instead of only overlapping wait time.
let lastRequestAtLanes: number[] = [0];

async function paceRequests(config: UpdaterConfig): Promise<void> {
  const now = Date.now();
  let lane = 0;
  for (let i = 1; i < lastRequestAtLanes.length; i += 1) if (lastRequestAtLanes[i] < lastRequestAtLanes[lane]) lane = i;
  const wait = Math.max(0, lastRequestAtLanes[lane] - now);
  lastRequestAtLanes[lane] = Math.max(now, lastRequestAtLanes[lane]) + Math.max(0, config.requestSleep * 1000);
  if (wait) await sleep(wait);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
/** One attempt (headers AND body) may take this long before it is aborted and retried. */
let REQUEST_TIMEOUT_MS = 45_000;
let RETRY_BASE_MS = 1500;
export function setFetchTuningForTests(timeoutMs: number, retryBaseMs: number): void { REQUEST_TIMEOUT_MS = timeoutMs; RETRY_BASE_MS = retryBaseMs; }

class NonRetryableError extends Error {}

/**
 * Every attempt is bounded by AbortSignal.timeout, which also covers reading
 * the body (`read` runs inside the attempt), and is retried per MAX_RETRIES.
 * 403 is retried (the WAF answers it while throttling); other 4xx are final.
 */
export async function fetchWithRetry<T = Response>(
  url: string,
  headers: Record<string, string>,
  config: UpdaterConfig,
  label: string = url,
  read: (response: Response) => Promise<T> = async (response) => response as unknown as T,
): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
    await paceRequests(config);
    try {
      const response = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (response.ok) return await read(response);
      // globalxetfs.com answers 403 from its WAF while throttling, and the CSV
      // endpoint answers 200 with an HTML error page when the ticker is unknown.
      if (!RETRY_STATUS.has(response.status) && response.status !== 403) {
        throw new NonRetryableError(`${label}: HTTP ${response.status}`);
      }
      lastError = new Error(`${label}: HTTP ${response.status}`);
    } catch (error) {
      if (error instanceof NonRetryableError) throw error;
      lastError = error;
    }
    if (attempt < config.maxRetries) await sleep(RETRY_BASE_MS * (attempt + 1));
  }
  throw new Error(`${label}: ${errorMessage(lastError)}`);
}

function browserHeaders(): Record<string, string> {
  return {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };
}

function yahooHeaders(): Record<string, string> {
  return {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'application/json,text/plain,*/*',
  };
}

function secHeaders(config: UpdaterConfig): Record<string, string> {
  return { 'User-Agent': config.secUa, Accept: 'application/json,application/xml,text/html,*/*' };
}

async function fetchText(url: string, headers: Record<string, string>, config: UpdaterConfig, label = url): Promise<string> {
  return fetchWithRetry(url, headers, config, label, (response) => response.text());
}

async function fetchBytes(url: string, headers: Record<string, string>, config: UpdaterConfig, label = url): Promise<Uint8Array> {
  return fetchWithRetry(url, headers, config, label, async (response) => new Uint8Array(await response.arrayBuffer()));
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

export function decodeHtmlEntities(text: string): string {
  return String(text ?? '')
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&ndash;/gi, '–')
    .replace(/&mdash;/gi, '—')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&rsquo;/gi, '’')
    .replace(/&lsquo;/gi, '‘')
    .replace(/&reg;/gi, '')
    .replace(/&trade;/gi, '')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

// ---------------------------------------------------------------------------
// Next.js Flight payload helpers
// ---------------------------------------------------------------------------

/**
 * globalxetfs.com is a Next.js application. The initial HTML contains a
 * skeleton, while the real catalog and fund data are serialized in
 * `self.__next_f.push([1, "..."])` Flight chunks. Decode those chunks first.
 */
export function extractNextFlightText(html: string): string {
  const chunks: string[] = [];
  const pattern = /self\.__next_f\.push\(\[1,("(?:\\.|[^"\\])*")\]\)/g;
  for (const match of html.matchAll(pattern)) {
    try { chunks.push(JSON.parse(match[1])); } catch { /* ignore malformed chunks */ }
  }
  return chunks.join('');
}

/**
 * Split the Flight text into its `<id>:<json>` rows. A text row `<id>:T<hex>,`
 * carries that many UTF-8 bytes and no line break, so the next row follows it
 * on the same line (the redesigned fund page puts its Documents list there).
 */
function parseNextFlightRecords(flight: string): Map<string, unknown> {
  const records = new Map<string, unknown>();
  const data = new TextEncoder().encode(flight);
  const decoder = new TextDecoder();
  let position = 0;
  while (position < data.length) {
    const colon = data.indexOf(0x3a, position);
    let lineEnd = data.indexOf(0x0a, position);
    if (lineEnd < 0) lineEnd = data.length;
    const id = colon < 0 || colon > lineEnd ? '' : decoder.decode(data.subarray(position, colon));
    if (!/^[0-9a-z]+$/.test(id)) { position = lineEnd + 1; continue; }
    if (data[colon + 1] === 0x54) {
      const comma = data.indexOf(0x2c, colon);
      const length = Number.parseInt(decoder.decode(data.subarray(colon + 2, comma)), 16);
      if (comma > 0 && Number.isFinite(length)) {
        records.set(id, decoder.decode(data.subarray(comma + 1, comma + 1 + length)));
        position = comma + 1 + length;
        continue;
      }
    }
    const body = decoder.decode(data.subarray(colon + 1, lineEnd));
    if (/^[[{]/.test(body)) {
      try { records.set(id, JSON.parse(body)); } catch { /* not a JSON row */ }
    }
    position = lineEnd + 1;
  }
  return records;
}

/** Every object anywhere in a Flight value that `match` accepts (a match is not searched further). */
function collectFlightObjects(value: unknown, match: (object: Record<string, unknown>) => boolean, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const item of value) collectFlightObjects(item, match, out);
  } else if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    if (match(object)) out.push(object);
    else for (const item of Object.values(object)) collectFlightObjects(item, match, out);
  }
  return out;
}

/** A Flight string value: React escapes a leading `$` as `$$` (`"$$37.44"` is `$37.44`). */
function flightString(raw: unknown): string {
  const text = cleanText(raw);
  return text.startsWith('$$') ? text.slice(1) : text;
}

// ---------------------------------------------------------------------------
// globalxetfs.com — ETF lineup (`/explore`)
// ---------------------------------------------------------------------------

export type LineupFund = {
  ticker: string;
  name: string;
  category: string;
  categoryClass: string;
  frequency: string;
  distributionRate: number | null;
  distributionRateText: string;
  secYield: number | null;
  secYieldText: string;
  managementFee: number | null;
  /** Gross expense ratio when the lineup prints one next to the net figure. */
  grossExpense?: number | null;
  managementFeeText: string;
  netAssets: number | null;
  netAssetsText: string;
  inceptionDate: string;
  fundPage: string;
};

/**
 * The five Global X asset-class groups, in the order the website prints them. The
 * tab labels come straight from the provider, so they are listed verbatim.
 */
export const GLOBALX_CATEGORIES = [
  'Equity High Income',
  'Boosted High Income',
  'High Income Alternatives',
  'Hedged Equity Income',
  'Enhanced Fixed Income',
] as const;

/** Ticker CSS class on the lineup table -> the asset-class heading Global X prints above the cards. */
const CATEGORY_CLASS_LABELS: Record<string, string> = {
  'ticker-equity-high-income': 'Equity High Income',
  'ticker-enhanced-fixed-income': 'Boosted High Income',
  'ticker-high-income-alternatives': 'High Income Alternatives',
  'ticker-hedged-equity-income': 'Hedged Equity Income',
  'ticker-enhanced-income-treasuries': 'Enhanced Fixed Income',
};


/**
 * Read the "Explore" lineup. Since the 2026-10 redesign it is a client table fed
 * with camelCase `rows` (`ticker`, `netAssetsValue`, `grossExpensesValue`,
 * `netExpensesValue`, `distributionRateValue`, `inceptionDateValue` in epoch ms,
 * `hierarchyNames`, `distributionFrequency`) nested in a Flight element.
 */
export function parseGlobalXLineup(html: string): LineupFund[] {
  const records = parseNextFlightRecords(extractNextFlightText(html));
  const funds: LineupFund[] = [];
  const seen = new Set<string>();
  const rows = collectFlightObjects([...records.values()], (row) => typeof row.ticker === 'string' && 'netExpensesValue' in row && 'hierarchyNames' in row);
  for (const row of rows) {
    const ticker = sanitizeTicker(row.ticker);
    if (!/^[A-Z]{2,6}$/.test(ticker) || seen.has(ticker)) continue;
    const hierarchy = Array.isArray(row.hierarchyNames) ? row.hierarchyNames.map(cleanText).filter(Boolean) : [];
    const gross = numberOrNull(row.grossExpensesValue);
    const net = numberOrNull(row.netExpensesValue);
    const fee = net !== null ? net : gross;
    const netAssets = numberOrNull(row.netAssetsValue);
    const inception = numberOrNull(row.inceptionDateValue);
    const distributionRate = numberOrNull(row.distributionRateValue);
    funds.push({
      ticker,
      name: cleanText(row.name || ticker),
      category: hierarchy.slice(0, 2).join(' / ') || 'Other',
      categoryClass: hierarchy[1] || '',
      frequency: cleanText(row.distributionFrequency),
      distributionRate,
      distributionRateText: distributionRate === null ? '' : formatPercentText(distributionRate),
      secYield: null,
      secYieldText: '',
      managementFee: fee,
      grossExpense: gross,
      managementFeeText: fee === null ? '' : formatPercentText(fee),
      netAssets,
      netAssetsText: netAssets === null ? '' : formatAumDisplay(netAssets),
      inceptionDate: inception === null ? toIsoDate(row.inceptionDate) : new Date(inception).toISOString().slice(0, 10),
      fundPage: globalxFundPageUrl(ticker),
    });
    seen.add(ticker);
  }
  return funds;
}

/**
 * Ticker -> asset-class heading, harvested from the "Explore Our ETFs" cards.
 * The lineup table's own CSS class is a styling hook (XSPI's Boosted fund wears
 * `ticker-enhanced-fixed-income`), so the printed heading is the authority.
 */
export function parseGlobalXCategoryCards(_html: string): Map<string, string> {
  return new Map();
}

// ---------------------------------------------------------------------------
// globalxetfs.com — per-fund page
// ---------------------------------------------------------------------------

export type GlobalXFundDetails = {
  inceptionDate: string;
  ticker: string;
  cusip: string | null;
  isin: string | null;
  managementFeeText: string | null;
  totalOperatingExpensesText: string | null;
  netAssets: number | null;
  netAssetsText: string | null;
  sharesOutstanding: number | null;
  sharesOutstandingText: string | null;
  primaryExchange: string | null;
  underlyingExposure: string | null;
  distributionFrequency: string | null;
  netAssetValue: number | null;
  netAssetValueText: string | null;
  navDailyChangeValue: number | null;
  navDailyChangePercent: number | null;
  marketPrice: number | null;
  marketPriceText: string | null;
  marketPriceDailyChangeValue: number | null;
  marketPriceDailyChangePercent: number | null;
  /** The fund page's own latest premium/discount in percent (published, not derived). */
  premiumDiscount: number | null;
  premiumDiscountText: string | null;
  /** `30-Day Median Bid-Ask Spread`, published by the Fund Details panel. */
  bidAskSpread: number | null;
  bidAskSpreadText: string | null;
  /** `Acquired Fund Fees & Expenses` when the panel itemizes it. */
  acquiredFundFeesText: string | null;
  asOfDate: string;
};

const MONEY_SCALES: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, billion: 1e9, t: 1e12, trillion: 1e12 };

/** `$12,151,808,030` -> 12151808030; `$90.97 million` -> 90970000; `1,234` -> 1234. */
export function moneyOrNull(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const text = cleanText(raw).replace(/[$,]/g, '');
  if (!text || isMissingCell(text)) return null;
  const match = /^(-?\d+(?:\.\d+)?)\s*([a-z]*)$/i.exec(text);
  if (!match) return null;
  const scale = match[2] ? MONEY_SCALES[match[2].toLowerCase()] : 1;
  return scale ? round(Number(match[1]) * scale, 2) : null;
}

/** One label/value row of a fund page panel (Fund Details, ETF Prices). */
type FundPageCard = { label: string; values: string[] };

/** Everything the per-fund parsers read, decoded once per call. */
type GlobalXFundPage = { flight: string; recordMap: Map<string, unknown>; records: unknown[]; cards: FundPageCard[] };

/**
 * Since the 2026-10 redesign the fund page is a Flight tree: the Fund Details and
 * ETF Prices panels are `li` rows (a label span, then `data-card-value-*` spans),
 * while returns, distributions, the premium/discount series and the documents
 * are plain data props of client components.
 */
function readFundPage(html: string): GlobalXFundPage {
  const flight = extractNextFlightText(html);
  const cards: FundPageCard[] = [];
  const pattern = /"className":"text-xs font-semibold text-muted-foreground","children":("(?:\\.|[^"\\])*")\}|"data-card-value-(?:\\.|[^"\\])*",\{"className":"[^"]*","children":("(?:\\.|[^"\\])*")\}/g;
  for (const match of flight.matchAll(pattern)) {
    const text = flightString(JSON.parse(match[1] ?? match[2]));
    if (match[1] !== undefined) cards.push({ label: text, values: [] });
    else cards.at(-1)?.values.push(text);
  }
  const recordMap = parseNextFlightRecords(flight);
  return { flight, recordMap, records: [...recordMap.values()], cards };
}

/** The text children of a Flight element tree, with lazy `$L<id>` references resolved. */
function flightChildrenText(node: unknown, records: Map<string, unknown>, depth = 0): string[] {
  if (depth > 60) return [];
  if (typeof node === 'string') {
    const reference = /^\$L?([0-9a-z]+)$/.exec(node);
    if (reference && records.has(reference[1])) return flightChildrenText(records.get(reference[1]), records, depth + 1);
    return node.startsWith('$') && !node.startsWith('$$') ? [] : [flightString(node)];
  }
  if (!Array.isArray(node)) return [];
  if (node[0] === '$' && node.length >= 4) {
    const props = node[3] as Record<string, unknown> | null;
    return props ? flightChildrenText(props.children, records, depth + 1) : [];
  }
  return node.flatMap((item) => flightChildrenText(item, records, depth + 1));
}

/** Every Flight element (`["$", type, key, props]`) whose key starts with `prefix`. */
function collectFlightElements(value: unknown, prefix: string, out: unknown[][] = []): unknown[][] {
  if (Array.isArray(value)) {
    if (value[0] === '$' && typeof value[2] === 'string' && value[2].startsWith(prefix)) out.push(value);
    for (const item of value) collectFlightElements(item, prefix, out);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectFlightElements(item, prefix, out);
  }
  return out;
}

/** First value of the panel row labelled `label`; null when absent or printed as `-`. */
function cardValue(page: GlobalXFundPage, label: string): string | null {
  const value = page.cards.find((card) => card.label.toLowerCase() === label.toLowerCase() && card.values.length)?.values[0];
  return value === undefined || isMissingCell(value) ? null : value;
}

/** The `Daily Change` row printed right after `label` in ETF Prices: `$0.10 / 0.27%`. */
function dailyChangeAfter(page: GlobalXFundPage, label: string): { value: number | null; percent: number | null } {
  const at = page.cards.findIndex((card) => card.label === label && card.values.length);
  const next = at >= 0 ? page.cards[at + 1] : undefined;
  if (!next || next.label !== 'Daily Change' || !next.values.length) return { value: null, percent: null };
  const [value, percent] = next.values[0].split('/');
  return { value: numberOrNull(value), percent: numberOrNull(percent) };
}

/** `05/09/16` (the panel's short US date) -> `2016-05-09`; other formats via toIsoDate. */
function fundPageDate(raw: string | null): string {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/.exec(cleanText(raw));
  if (!match) return toIsoDate(raw);
  const year = Number(match[3]) < 70 ? 2000 + Number(match[3]) : 1900 + Number(match[3]);
  return `${year}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`;
}

/** Appended to the holdings source kind while a fund in liquidation keeps its last published holdings. */
const LIQUIDATION_KEPT_NOTE = '; kept: fund in liquidation, no current holdings CSV';

/**
 * A fund being wound down carries an "In Liquidation" label under its name
 * (BTRN, 2026-10) or, since the redesign, the rendered notice "The Fund will
 * liquidate on or about <date>" (every page also ships the unrendered
 * `{__date__}` template, which does not count). Its page still publishes
 * current fund details, but the dated holdings CSV answers HTTP 404.
 */
export function isGlobalXFundInLiquidation(html: string): boolean {
  return /(?<!liquidation\.planned\\?":\\?)(?:>|\\?")\s*In Liquidation\b/.test(html) || /The Fund will liquidate on or about (?!\{)/.test(html);
}

/** The `Fund Details` and `ETF Prices` panels plus the latest premium/discount card. */
export function parseGlobalXFundDetails(html: string): GlobalXFundDetails {
  const page = readFundPage(html);
  const card = (label: string) => cardValue(page, label);
  const prices = collectFlightObjects(page.records, (object) => !!object.latest && typeof object.latest === 'object' && 'premiumDiscountPct' in (object.latest as object))[0];
  const latest = (prices?.latest ?? {}) as Record<string, unknown>;
  const nav = numberOrNull(latest.nav) ?? numberOrNull(card('NAV'));
  const price = numberOrNull(latest.marketPrice) ?? numberOrNull(card('Market Price'));
  const navDaily = dailyChangeAfter(page, 'NAV');
  const priceDaily = dailyChangeAfter(page, 'Market Price');
  const premium = numberOrNull(latest.premiumDiscountPct);
  const netAssetsText = card('Net Assets');
  const shares = numberOrNull(card('Shares Outstanding'));
  const spreadText = card('30-Day Median Bid-Ask Spread');
  const spread = numberOrNull(spreadText);
  const asOf = /"children":"(?:Fund Details|ETF Prices)"\}\],\["\$","p",null,\{"className":"[^"]*","children":"As of ([^"]+)"\}/.exec(page.flight)?.[1];
  return {
    inceptionDate: fundPageDate(card('Inception Date')),
    ticker: sanitizeTicker(card('Ticker')),
    cusip: card('CUSIP'),
    isin: card('ISIN'),
    managementFeeText: null,
    totalOperatingExpensesText: card('Total Expense Ratio'),
    netAssets: moneyOrNull(netAssetsText),
    netAssetsText,
    sharesOutstanding: shares,
    sharesOutstandingText: shares === null ? null : shares.toLocaleString('en-US'),
    primaryExchange: card('Primary Exchange'),
    underlyingExposure: null,
    distributionFrequency: card('Distribution Frequency'),
    netAssetValue: nav,
    netAssetValueText: nav === null ? null : nav.toFixed(2),
    navDailyChangeValue: navDaily.value,
    navDailyChangePercent: navDaily.percent,
    marketPrice: price,
    marketPriceText: price === null ? null : formatMoneyText(price),
    marketPriceDailyChangeValue: priceDaily.value,
    marketPriceDailyChangePercent: priceDaily.percent,
    premiumDiscount: premium === null ? null : round(premium, 4),
    premiumDiscountText: premium === null ? null : `${premium.toFixed(4)}%`,
    bidAskSpread: spread === null ? null : round(spread, 2),
    bidAskSpreadText: spread === null ? null : `${spread.toFixed(2)}%`,
    acquiredFundFeesText: null,
    asOfDate: toIsoDate(asOf),
  };
}

/**
 * Global X prints a 0 distribution rate for funds that have not paid anything
 * yet (monthly bond funds with a 4-6% SEC yield included), so a zero rate is
 * "no usable rate", not a measured 0.00%: it is published as null.
 */
export function positiveYieldOrNull(value: unknown): number | null {
  const n = numberOrNull(value);
  return n !== null && n > 0 ? n : null;
}

export type GlobalXDistributionInfo = {
  asOfDate: string;
  frequency: string | null;
  managementFeeText: string | null;
  distributionRate: number | null;
  distributionRateText: string | null;
  trailingRate12M: number | null;
  trailingRate12MText: string | null;
  distributionAmount: number | null;
  distributionAmountText: string | null;
  distributionAmountPercent: number | null;
  distributionAmountPercentText: string | null;
  secYield: number | null;
  secYieldText: string | null;
};

/**
 * The metric cards above the Distribution History table (`30-Day SEC Yield`,
 * `Distribution Rate`, `Trailing 12-Month Distribution (%)`, `Distribution
 * Frequency`); a fund prints only the cards it has figures for.
 */
export function parseGlobalXDistributionInfo(html: string): GlobalXDistributionInfo | null {
  const page = readFundPage(html);
  const cards = new Map<string, string>();
  const prefix = 'distribution-history-metric-card-';
  for (const element of collectFlightElements(page.records, prefix)) {
    const label = String(element[2]).slice(prefix.length).replace(/-(?:undefined|\d+)-\d+$/, '');
    const texts = flightChildrenText(element, page.recordMap);
    const value = texts.length > 1 ? texts[texts.length - 1] : '';
    if (!cards.has(label) && !isMissingCell(value)) cards.set(label, value);
  }
  const frequency = cards.get('Distribution Frequency') ?? cardValue(page, 'Distribution Frequency');
  if (!cards.size && !frequency) return null;
  const sec = numberOrNull(cards.get('30-Day SEC Yield'));
  const rate = positiveYieldOrNull(cards.get('Distribution Rate'));
  const trailing = positiveYieldOrNull(cards.get('Trailing 12-Month Distribution (%)'));
  return {
    asOfDate: parseGlobalXFundDetails(html).asOfDate,
    frequency,
    managementFeeText: null,
    distributionRate: rate,
    distributionRateText: rate === null ? null : `${rate.toFixed(2)}%`,
    trailingRate12M: trailing,
    trailingRate12MText: trailing === null ? null : `${trailing.toFixed(2)}%`,
    distributionAmount: null,
    distributionAmountText: null,
    distributionAmountPercent: null,
    distributionAmountPercentText: null,
    secYield: sec,
    secYieldText: sec === null ? null : `${sec.toFixed(2)}%`,
  };
}
export type GlobalXDistributionRow = {
  'Declaration Date': string;
  'Ex-Div Date': string;
  'Record Date': string;
  'Payable Date': string;
  'Amount ($)': string;
};

export const GLOBALX_DISTRIBUTION_HEADERS = [
  'Declaration Date',
  'Ex-Div Date',
  'Record Date',
  'Payable Date',
  'Amount ($)',
] as const;

/**
 * The official Distribution History table (`distributions`: `exDate`,
 * `recordDate`, `payableDate`, `amount` as printed, e.g. `$0.16`), newest first.
 * A declared-but-unpaid past row keeps an empty Amount so the table mirrors the page.
 */
export function parseGlobalXDistributionHistory(html: string, now: Date = new Date()): GlobalXDistributionRow[] {
  const page = readFundPage(html);
  const table = collectFlightObjects(page.records, (object) => Array.isArray(object.distributions)
    && (object.distributions as unknown[]).some((row) => !!row && typeof row === 'object' && 'exDate' in row))[0];
  if (!table) return [];
  const today = now.toISOString().slice(0, 10);
  const rows: GlobalXDistributionRow[] = [];
  for (const item of table.distributions as Array<Record<string, unknown>>) {
    const exDate = toIsoDate(item.exDate);
    const amountText = flightString(item.amount);
    const amount = numberOrNull(amountText);
    // The page lists the forward schedule with an empty amount (a scheduled date,
    // not a paid distribution); those placeholder rows are not history.
    if (!exDate || (amount === null && exDate > today)) continue;
    rows.push({
      'Declaration Date': '',
      'Ex-Div Date': exDate,
      'Record Date': toIsoDate(item.recordDate),
      'Payable Date': toIsoDate(item.payableDate),
      'Amount ($)': amount === null ? '' : `$${normalizeNumberText(amountText)}`,
    });
  }
  return rows.sort((a, b) => b['Ex-Div Date'].localeCompare(a['Ex-Div Date']));
}

/**
 * The redesigned page prints distribution amounts rounded to cents ($0.16) where
 * the earlier page published the exact figure ($0.155500). A row already
 * published with the exact issuer figure keeps it while the page still prints
 * that same figure rounded (same ex-date, equal at the page's precision); any
 * other row is taken from the page as printed.
 */
export function keepPublishedAmountPrecision(rows: GlobalXDistributionRow[], published: unknown): GlobalXDistributionRow[] {
  if (!Array.isArray(published)) return rows;
  const exact = new Map<string, string>();
  for (const row of published as Array<Record<string, unknown>>) {
    if (row && typeof row['Ex-Div Date'] === 'string' && typeof row['Amount ($)'] === 'string') exact.set(row['Ex-Div Date'], row['Amount ($)']);
  }
  return rows.map((row) => {
    const previous = exact.get(row['Ex-Div Date']);
    const printed = numberOrNull(row['Amount ($)']);
    const kept = numberOrNull(previous);
    if (previous === undefined || printed === null || kept === null) return row;
    const decimals = (normalizeNumberText(row['Amount ($)']).split('.')[1] ?? '').length;
    const digitsKept = (normalizeNumberText(previous).split('.')[1] ?? '').length;
    if (digitsKept <= decimals || Math.abs(kept - printed) > 0.5 * 10 ** -decimals + 1e-9) return row;
    return { ...row, 'Amount ($)': previous };
  });
}

export type GlobalXPerformance = {
  asOfDate: string;
  nav: Record<string, number | null>;
  market: Record<string, number | null>;
  benchmarkName: string | null;
  benchmark: Record<string, number | null>;
};

/**
 * The Returns tables (`avgAnnualized` and `cumulative`, one entry per cadence:
 * `month-end`, `quarter-end`). Each has `columns` keys (ONE_YEAR, YTD, ...) and
 * `rows` labelled `Fund NAV`, `Market Price` and the benchmark (`Index`).
 */
export function parseGlobalXPerformanceSection(html: string, sectionId: string): GlobalXPerformance | null {
  const page = readFundPage(html);
  const data = collectFlightObjects(page.records, (object) => Array.isArray(object.avgAnnualized) && Array.isArray(object.cumulative))[0];
  if (!data) return null;
  const cadence = /quarter/i.test(sectionId) ? 'quarter-end' : 'month-end';
  const pick = (list: unknown) => (list as Array<Record<string, unknown>>).find((table) => table?.cadence === cadence) ?? null;
  const annual = pick(data.avgAnnualized);
  const cumulative = pick(data.cumulative);
  if (!annual && !cumulative) return null;
  const byRow = (table: Record<string, unknown> | null): Map<string, Record<string, number | null>> => {
    const keys = Array.isArray(table?.columns) ? (table.columns as Array<Record<string, unknown>>).map((column) => cleanText(column?.key)) : [];
    const out = new Map<string, Record<string, number | null>>();
    for (const row of Array.isArray(table?.rows) ? (table.rows as Array<Record<string, unknown>>) : []) {
      const values = Array.isArray(row?.values) ? row.values : [];
      out.set(cleanText(row?.label), Object.fromEntries(keys.map((key, index) => {
        const n = numberOrNull(flightString(values[index]));
        return [key, n === null ? null : round(n, 2)];
      })));
    }
    return out;
  };
  const annualRows = byRow(annual);
  const cumulativeRows = byRow(cumulative);
  const navAnnual = annualRows.get('Fund NAV') ?? {};
  const navCumulative = cumulativeRows.get('Fund NAV') ?? {};
  const benchmarkName = [...annualRows.keys()].find((label) => label !== 'Fund NAV' && label !== 'Market Price') ?? null;
  return {
    asOfDate: toIsoDate(annual?.asOf ?? cumulative?.asOf),
    nav: {
      yr1: navAnnual.ONE_YEAR ?? null, yr3: navAnnual.THREE_YEAR ?? null, yr5: navAnnual.FIVE_YEAR ?? null, yr10: navAnnual.TEN_YEAR ?? null,
      sinceInception: navAnnual.SINCE_INCEPTION ?? null,
      mo1: navCumulative.ONE_MONTH ?? null, mo3: navCumulative.THREE_MONTH ?? null, mo6: navCumulative.SIX_MONTH ?? null, ytd: navCumulative.YTD ?? null,
      sinceInceptionCumulative: navCumulative.SINCE_INCEPTION ?? null,
    },
    market: annualRows.get('Market Price') ?? {},
    benchmarkName,
    benchmark: benchmarkName ? annualRows.get(benchmarkName) ?? {} : {},
  };
}
export type GlobalXNavIndex = {
  startDate: string;
  endDate: string;
  points: number;
  values: number[];
  benchmarkValues: number[];
};

/** The inline `dates` / `navValues` / `indexValues2` arrays behind the "Growth of $10,000 at NAV Since Inception" chart. */
export function parseGlobalXNavIndex(_html: string): GlobalXNavIndex | null {
  return null;
}
export type GlobalXDocuments = {
  prospectus: string | null;
  summaryProspectus: string | null;
  sai: string | null;
  annualReport: string | null;
  semiAnnualReport: string | null;
  fiscalQ1Holdings: string | null;
  fiscalQ3Holdings: string | null;
  taxInfo: string | null;
  form8937: string | null;
};

/** The `Documents` lists (`documents`: `name` plus `file.url` or `url`), each name matched to its first link. */
export function parseGlobalXDocuments(html: string): GlobalXDocuments {
  const documents: GlobalXDocuments = {
    prospectus: null,
    summaryProspectus: null,
    sai: null,
    annualReport: null,
    semiAnnualReport: null,
    fiscalQ1Holdings: null,
    fiscalQ3Holdings: null,
    taxInfo: null,
    form8937: null,
  };
  const page = readFundPage(html);
  const items = collectFlightObjects(page.records, (object) => typeof object.name === 'string' && 'fileType' in object);
  for (const item of items) {
    const file = item.file as Record<string, unknown> | undefined;
    const raw = cleanText(file?.url ?? item.url);
    if (!raw) continue;
    const url = raw.startsWith('//') ? `https:${raw}` : raw;
    const label = cleanText(item.name);
    const set = (key: keyof GlobalXDocuments) => {
      if (!documents[key]) documents[key] = url;
    };
    if (/^summary prospectus/i.test(label)) set('summaryProspectus');
    else if (/^(?:statutory )?prospectus/i.test(label)) set('prospectus');
    else if (/statement of additional information/i.test(label)) set('sai');
    else if (/^semi[- ]?annual shareholder report/i.test(label)) set('semiAnnualReport');
    else if (/^annual shareholder report/i.test(label)) set('annualReport');
    else if (/^q1 complete holdings/i.test(label)) set('fiscalQ1Holdings');
    else if (/^q3 complete holdings/i.test(label)) set('fiscalQ3Holdings');
    else if (/supplemental tax information/i.test(label)) set('taxInfo');
    else if (/8937/.test(label)) set('form8937');
  }
  return documents;
}

// ---------------------------------------------------------------------------
// Official daily holdings CSV
// ---------------------------------------------------------------------------

export const GLOBALX_HOLDINGS_CSV_HEADERS = [
  'Date',
  'Account',
  'StockTicker',
  'SEDOL',
  'SecurityName',
  'Shares',
  'Price',
  'MarketValue',
  'Weightings',
  'NetAssets',
  'SharesOutstanding',
  'CreationUnits',
  'MoneyMarketFlag',
] as const;

export const HOLDINGS_HEADERS = ['Name', 'Ticker', 'Identifier', 'Weight', 'Market Value', 'Shares Held', 'Asset Category'] as const;
/** Funds whose holdings legitimately fail a holdingsGuard check (geared, futures, look-through, top-N lists): ticker, or '*' for every fund -> relaxed checks. */
export const HOLDINGS_GUARD_RELAX: Record<string, string[]> = {
  // Futures strategy fund: the futures exposure plus the T-bill collateral add up to 160-175. Every other published Global X fund passes today.
  COMD: ['sum'],
};
/** Funds the issuer closed, each confirmed from an SEC filing or the issuer notice (`source`): never fetched or guarded, last published data kept, index row marked closed. */
export const CLOSED_FUNDS: ClosedFund[] = [
  { ticker: 'BTRN', closed: '2026-10-16', source: 'https://www.sec.gov/Archives/edgar/data/1432353/000143235326000712/glx-20260916.htm' },
  { ticker: 'IRVH', closed: '2026-10-16', source: 'https://www.sec.gov/Archives/edgar/data/1432353/000143235326000713/glx-20260916.htm' },
  { ticker: 'QCLR', closed: '2026-10-16', source: 'https://www.sec.gov/Archives/edgar/data/1432353/000143235326000712/glx-20260916.htm' },
  { ticker: 'XCLR', closed: '2026-10-16', source: 'https://www.sec.gov/Archives/edgar/data/1432353/000143235326000712/glx-20260916.htm' },
];
export const HISTORY_HEADERS = ['Date', 'Close', 'Adj Close', 'Volume'] as const;

/** RFC-4180-ish reader that tolerates a UTF-8 BOM, CRLF and quoted fields with commas. */
export function parseCsv(text: string): string[][] {
  const body = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (quoted) {
      if (char === '"') {
        if (body[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
}

/** `"SPXW  261001P07075000"` — an OCC option symbol (root, padded date, C/P, strike). */
const OCC_OPTION = /^[A-Z0-9]{1,6}\s+\d{6}[CP]\d{8}$/;
/** `BTCV6 Curncy`, `COF7 Comdty`, `S F7 Comdty`, `NQZ6 Index` - a Bloomberg futures contract code (root, month letter, year, yellow key). */
const FUTURE_CODE = /^[A-Z0-9]{1,5} ?[FGHJKMNQUVXZ]\d{1,2} (?:Comdty|Curncy|Index)$/i;
/** `PNFP 7.68764 PERP`, `NRUC 5 1/2 05/15/64`, `DTE 4 3/8 12/01/2081` - a Bloomberg preferred or bond description (issuer, coupon, PERP or maturity). */
const DEBT_NAME = /^\S+ (?:FLOAT|FRN|\d+(?:\.\d+)?|\d+ \d+\/\d+|\d+\/\d+) (?:PERP|\d{1,2}\/\d{1,2}\/(?:\d{2}|\d{4}))$/i;

/**
 * The published Ticker of a holdings CSV row (GLOBALX-3). The CSV ticker is a Bloomberg code: bare for a U.S. listing (`ABBV`,
 * `BRK/B`) and qualified with the exchange of a foreign listing (`RO SW`, `2330 TT`), so both stay as published. The CSV also
 * gives a preferred or bond the issuer's equity ticker (PFFD `PNFP 7.68764 PERP` -> `PNFP`) and a future its contract code
 * (`BTCV6 Curncy`): those rows and rows without a code publish `-`, so the Watchlist never merges them with a common share.
 */
export function globalxHoldingTicker(ticker: string, securityName: string): string {
  const code = cleanText(ticker);
  return !code || FUTURE_CODE.test(code) || DEBT_NAME.test(cleanText(securityName)) ? '-' : code;
}

/**
 * A factual position type for the Watchlist. Global X publishes no asset-class
 * column, so this is derived from the row's own identifying fields and is
 * documented as derived in the README; the raw row is otherwise untouched.
 */
export function globalxAssetCategory(stockTicker: string, securityName: string, moneyMarketFlag: string): string {
  const ticker = cleanText(stockTicker);
  const name = cleanText(securityName);
  if (/^y$/i.test(cleanText(moneyMarketFlag)) || /^cash(?:\s*&\s*other|\s+and\s+other)?$/i.test(ticker) || /^cash(?:\s*&\s*other|\s+and\s+other)?$/i.test(name) || /other payable & receivable/i.test(name)) return 'Cash';
  if (OCC_OPTION.test(ticker)) return 'Option';
  if (FUTURE_CODE.test(ticker)) return 'Future';
  if (/treasury|t-bill|t bill/i.test(name)) return 'Treasury';
  if (/\betf\b|exchange[- ]traded|\bfund\b|\btrust\b/i.test(name)) return 'Fund';
  return 'Equity';
}

export type ParsedHoldings = {
  headers: string[];
  rows: Array<Record<string, string>>;
  asOfDate: string;
  netAssets: number | null;
  sharesOutstanding: number | null;
  creationUnits: number | null;
  totalRows: number;
};

/**
 * Header names of the official holdings CSV (lower case, the first one found wins): the seven-column
 * sheet of most funds (`% of Net Assets,Ticker,Name,SEDOL,Market Price ($),Shares Held,Market Value ($)`),
 * the exposure sheet of the futures funds BITS and COMD (`Exposure (%),...,Price/Unit ($),Units Held,
 * Exposure Amount ($),Market Value ($),Market Value (%)`) and the older export (GLOBALX_HOLDINGS_CSV_HEADERS).
 * Market Value is always the sheet's Market Value ($), never the exposure sheet's Exposure Amount ($) (notional exposure).
 */
const GLOBALX_HOLDINGS_COLUMNS = {
  weight: ['% of net assets', 'exposure (%)', 'weightings'],
  ticker: ['ticker', 'stockticker'],
  name: ['name', 'securityname'],
  sedol: ['sedol'],
  price: ['market price ($)', 'price/unit ($)', 'price'],
  shares: ['shares held', 'units held', 'shares'],
  marketValue: ['market value ($)', 'marketvalue'],
};

/**
 * Map the official CSV onto the shared holdings contract, reading every column by its header name, so a
 * reordered sheet gives the same rows. The feed keeps the provider's own weight percentage, market value and
 * shares verbatim, including the negative values of written options; rows without a numeric weight (the
 * disclaimer line, cash rows of the exposure sheet) are left out. A sheet without a Name or weight column or
 * without any holdings row throws, so the source counts as failed and the published fund is kept.
 */
export function parseGlobalXHoldingsCsv(text: string): ParsedHoldings {
  const table = parseCsv(text);
  const known = ([] as string[]).concat(GLOBALX_HOLDINGS_COLUMNS.weight, GLOBALX_HOLDINGS_COLUMNS.name);
  let asOfDate = '';
  let headerAt = -1;
  for (let index = 0; index < table.length && headerAt < 0; index += 1) {
    const row = table[index];
    if (row[0]?.includes('Fund Holdings Data as of')) {
      const match = row[0].match(/as of\s+(\d{1,2}\/\d{1,2}\/\d{4})/i);
      if (match) asOfDate = toIsoDate(match[1]);
    } else if (row.length > 1 && row.some((cell) => known.indexOf(cleanText(cell).toLowerCase()) >= 0)) {
      headerAt = index;
    }
  }
  if (headerAt < 0) throw new Error('holdings CSV: no header row with a Name or weight column');
  const header = table[headerAt].map((cell) => cleanText(cell).toLowerCase());
  const columnOf = (aliases: string[]): number => {
    for (const alias of aliases) if (header.indexOf(alias) >= 0) return header.indexOf(alias);
    return -1;
  };
  const at = {
    weight: columnOf(GLOBALX_HOLDINGS_COLUMNS.weight),
    ticker: columnOf(GLOBALX_HOLDINGS_COLUMNS.ticker),
    name: columnOf(GLOBALX_HOLDINGS_COLUMNS.name),
    sedol: columnOf(GLOBALX_HOLDINGS_COLUMNS.sedol),
    price: columnOf(GLOBALX_HOLDINGS_COLUMNS.price),
    shares: columnOf(GLOBALX_HOLDINGS_COLUMNS.shares),
    marketValue: columnOf(GLOBALX_HOLDINGS_COLUMNS.marketValue),
  };
  if (at.name < 0 || at.weight < 0) {
    throw new Error(`holdings CSV: no ${at.weight < 0 ? 'weight (% of Net Assets)' : 'Name'} column (headers: ${table[headerAt].map(cleanText).join(', ')})`);
  }
  const cell = (row: string[], index: number): string => (index < 0 ? '' : cleanText(row[index]));
  const rows: Array<Record<string, string>> = [];
  for (const row of table.slice(headerAt + 1)) {
    const weight = cell(row, at.weight);
    if (!/^[-+]?\d+(?:\.\d+)?$/.test(weight)) continue;
    const ticker = cell(row, at.ticker);
    const name = cell(row, at.name);
    rows.push({
      Name: name,
      Ticker: globalxHoldingTicker(ticker, name),
      Identifier: cell(row, at.sedol),
      Weight: `${weight}%`,
      'Market Value': cell(row, at.marketValue),
      'Shares Held': cell(row, at.shares),
      'Asset Category': globalxAssetCategory(ticker, name, ''),
      Price: cell(row, at.price),
    });
  }
  if (!rows.length) throw new Error('holdings CSV: no holdings rows under the header');
  return { headers: [...HOLDINGS_HEADERS], rows, asOfDate, netAssets: null, sharesOutstanding: null, creationUnits: null, totalRows: rows.length };
}
// ---------------------------------------------------------------------------
// SEC EDGAR Form N-PORT-P fallback: the shared nport-reader block at the end of this file finds, reads and checks the filing
// ---------------------------------------------------------------------------

export const SEC_FUND_TICKERS_URL = 'https://www.sec.gov/files/company_tickers_mf.json';
export const SEC_COMPANY_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';

/** One run's SEC state: the two SEC ticker tables (each loaded once) and the N-PORT reader cache (submissions and documents). */
let secState: { funds: Promise<Map<string, NportSeriesRef>> | null; names: Promise<Map<string, string>> | null; reader: Map<string, unknown> } = { funds: null, names: null, reader: new Map() };

/** A fresh SEC state for a run (main and tests). */
export function resetSecState(): void {
  secState = { funds: null, names: null, reader: new Map() };
}

/** SEC's fund ticker -> registrant CIK + series id table, loaded once per run (a failed load is asked again by the next fund). */
function loadFundTickerTable(config: UpdaterConfig): Promise<Map<string, NportSeriesRef>> {
  if (!secState.funds) {
    const loading = fetchText(SEC_FUND_TICKERS_URL, secHeaders(config), config, 'SEC fund ticker table').then((text) => parseSecFundTickers(JSON.parse(text)));
    secState.funds = loading;
    loading.catch(() => { if (secState.funds === loading) secState.funds = null; });
  }
  return secState.funds;
}

/** SEC's company name -> ticker table for the N-PORT rows, loaded once per run. */
function loadCompanyNames(config: UpdaterConfig): Promise<Map<string, string>> {
  if (!secState.names) {
    const loading = fetchText(SEC_COMPANY_TICKERS_URL, secHeaders(config), config, 'SEC company ticker table').then((text) => parseSecCompanyNames(JSON.parse(text)));
    secState.names = loading;
    loading.catch(() => { if (secState.names === loading) secState.names = null; });
  }
  return secState.names;
}

/**
 * The Global X holdings sheet (HOLDINGS_HEADERS) of an N-PORT filing: a missing number stays empty (never 0), the weight
 * carries the CSV sheet's percent sign, a missing text is '-'. Tickers come from nportTickers (U.S. equities traded in USD
 * only) and never go to a preferred (EP), the Identifier is the position's own CUSIP, ISIN or other code, the Asset Category
 * the filing's assetCat code.
 */
export function nportHoldingsSheet(filing: NportFiling, tickers: ReadonlyArray<string>): Array<Record<string, string>> {
  return filing.positions.map((position, index) => {
    const weight = nportCell(position.weight);
    return {
      Name: position.name || '-',
      // a preferred (EP) gets no ticker: the name match would give it the issuer's common share (GLOBALX-3, PFFD)
      Ticker: (position.assetCat === 'EP' ? '' : tickers[index]) || '-',
      Identifier: nportIdentifier(position) || '-',
      Weight: weight ? `${weight}%` : '',
      'Market Value': nportCell(position.value, 2),
      'Shares Held': nportCell(position.balance),
      'Asset Category': position.assetCat || '-',
    };
  });
}

// ---------------------------------------------------------------------------
// Yahoo Finance chart feed
// ---------------------------------------------------------------------------

// adjCloseRaw: Yahoo's unrounded value, only used to tell float noise from a real change (never persisted).
export type YahooHistoryRow = { date: string; close: number | null; adjClose: number | null; volume: number | null; adjCloseRaw?: number | null };
export type YahooDistribution = { date: string; amount: number };

export function parseYahooChart(json: unknown): { history: YahooHistoryRow[]; dividends: YahooDistribution[] } {
  const result = (json as any)?.chart?.result?.[0];
  if (!result) return { history: [], dividends: [] };
  const timestamps: number[] = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const adjClose = result.indicators?.adjclose?.[0]?.adjclose || [];
  const history: YahooHistoryRow[] = [];
  for (let index = 0; index < timestamps.length; index += 1) {
    const close = numberOrNull(quote.close?.[index]);
    const adjustedRaw = numberOrNull(adjClose[index]);
    const adjusted = adjustedRaw === null ? null : round(adjustedRaw, 2);
    if (close === null && adjusted === null) continue;
    const date = new Date(timestamps[index] * 1000).toISOString().slice(0, 10);
    history.push({ date, close, adjClose: adjusted, volume: numberOrNull(quote.volume?.[index]), adjCloseRaw: adjustedRaw });
  }
  history.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const dividends: YahooDistribution[] = [];
  const events = result.events?.dividends || {};
  for (const key of Object.keys(events)) {
    const event = events[key];
    const amount = numberOrNull(event?.amount);
    const date = event?.date ? new Date(event.date * 1000).toISOString().slice(0, 10) : '';
    if (date && amount !== null) dividends.push({ date, amount });
  }
  dividends.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return { history, dividends };
}

export function parseYahooExchangeName(json: unknown): string | null {
  const meta = (json as any)?.chart?.result?.[0]?.meta;
  const raw = meta?.exchangeName || meta?.fullExchangeName;
  return raw ? cleanText(raw) : null;
}

// ---------------------------------------------------------------------------
// Return math
// ---------------------------------------------------------------------------

/** Cumulative total return from an annualized figure: `(1 + CAGR)^years - 1`. */
export function cumulativeFromAnnualized(annualized: number | null, years: number): number | null {
  if (annualized === null) return null;
  if (years <= 1) return annualized;
  return round(((1 + annualized / 100) ** years - 1) * 100, 2);
}

/** Annualized figure from a cumulative one: `(1 + TR)^(1/years) - 1`. */
export function annualizedFromCumulative(cumulative: number | null, years: number): number | null {
  if (cumulative === null) return null;
  if (years <= 1) return cumulative;
  const base = 1 + cumulative / 100;
  if (base <= 0) return null;
  return round((base ** (1 / years) - 1) * 100, 2);
}

/** Provider label -> payments per year. */
export function paymentsPerYear(frequency: string | null | undefined): number | null {
  const text = cleanText(frequency).toLowerCase().replace(/[‐‑‒–—]/g, '-');
  if (!text) return null;
  if (text === 'monthly') return 12;
  if (text === 'quarterly') return 4;
  if (text === 'semi-annually' || text === 'semiannually' || text === 'semi-annual' || text === 'semiannual') return 2;
  if (text === 'annually' || text === 'annual') return 1;
  if (text === 'weekly') return 52;
  if (text === 'bi-monthly') return 6;
  return null;
}

/** The coded, sortable label the catalog Frequency column shows. */
export function formatDistributionFrequency(value: unknown): string {
  const raw = cleanText(value);
  const normalized = raw.toLowerCase().replace(/[‐‑‒–—]/g, '-');
  if (!normalized || normalized === '-') return '00 - None';
  if (normalized === 'monthly') return '01 - Monthly';
  if (normalized === 'quarterly') return '04 - Quarterly';
  if (normalized === 'semi-annually' || normalized === 'semiannual' || normalized === 'semi-annual') return '06 - Semi-annually';
  if (normalized === 'annually' || normalized === 'annual') return '12 - Annually';
  if (normalized === 'none') return '00 - None';
  if (normalized === 'unknown') return '00 - Unknown';
  if (normalized === 'irregular' || normalized === 'other') return '99 - Irregular';
  return raw;
}

/**
 * Distribution frequency derived from the fund's own ex-dates, used only when
 * Global X publishes no label (it does for every fund today, so this is a guard).
 */
export function inferDistributionFrequency(exDates: string[], now: Date = new Date()): string {
  const cutoff = new Date(now.getTime() - 400 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const recent = exDates
    .map((value) => toIsoDate(value))
    .filter((value) => value && value >= cutoff)
    .sort();
  if (recent.length < 3) return '00 - Unknown';
  const unique = [...new Set(recent)].slice(-12);
  if (unique.length <= 1) return '00 - Unknown';
  const gaps: number[] = [];
  for (let index = 1; index < unique.length; index += 1) {
    const days = (Date.parse(unique[index]) - Date.parse(unique[index - 1])) / 86_400_000;
    if (days > 0) gaps.push(days);
  }
  if (!gaps.length) return '00 - Unknown';
  const mean = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
  if (mean >= 20 && mean <= 40) return '01 - Monthly';
  if (mean >= 70 && mean <= 110) return '04 - Quarterly';
  if (mean >= 150 && mean <= 215) return '06 - Semi-annually';
  if (mean >= 330 && mean <= 400) return '12 - Annually';
  return '99 - Irregular';
}

// ---------------------------------------------------------------------------
// Deterministic writes
// ---------------------------------------------------------------------------

export function stableStringify(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Write only when the serialized bytes moved, so a no-op run leaves an empty `git diff`. */
export async function writeIfChanged(file: string, content: string): Promise<'written' | 'unchanged'> {
  if (existsSync(file)) {
    const current = await readFile(file, 'utf8');
    if (current === content) return 'unchanged';
  }
  await mkdir(path.dirname(file), { recursive: true });
  // Temp file + rename: a crash never leaves a half-written JSON file behind.
  const temp = `${file}.tmp-${process.pid}`;
  await writeFile(temp, content, 'utf8');
  await rename(temp, file);
  return 'written';
}

export function splitPages<T>(rows: T[], pageSize: number): T[][] {
  const pages: T[][] = [];
  for (let index = 0; index < rows.length; index += pageSize) pages.push(rows.slice(index, index + pageSize));
  return pages;
}

export function pageFileName(index: number): string {
  return `${pad3(index)}.json`;
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export type CatalogEntry = Record<string, unknown> & { ticker: string; holdings?: number; history?: number };

function matchesRange(value: number | null, range: Range | undefined): boolean {
  if (!range) return true;
  if (value === null) return false;
  return value >= range.min && value <= range.max;
}

/**
 * Pre-fetch AND filter on what the lineup prints (ticker, category, AUM, TER).
 * A fund missing AUM or TER under an active filter FAILS it.
 */
function passesFilters(fund: LineupFund, config: UpdaterConfig): boolean {
  if (config.tickers.length && !config.tickers.includes(fund.ticker)) return false;
  if (config.category && !fund.category.toLowerCase().includes(config.category.toLowerCase())) return false;
  if (config.aumRange && config.aumRange.source) {
    if (fund.netAssets === null) return false;
    if (!matchesRange(fund.netAssets, config.aumRange)) return false;
  }
  if (config.terRange) {
    if (fund.managementFee === null) return false;
    if (!matchesRange(fund.managementFee, config.terRange)) return false;
  }
  return true;
}

/**
 * Filters that need the fund page (yields and returns), evaluated on the
 * computed metrics BEFORE anything is written. A fund with no figure for a
 * bounded range is excluded: there is nothing to compare, so it cannot match.
 */
export function passesDataFilters(metrics: Record<string, any>, monthEnd: Record<string, number | null | undefined>, config: UpdaterConfig): boolean {
  if (config.dividendYieldRange && !matchesRange(metrics.dividendYield ?? null, config.dividendYieldRange)) return false;
  if (config.secYieldRange && !matchesRange(metrics.secYield ?? null, config.secYieldRange)) return false;
  const published: Record<ReturnPeriod, number | null> = {
    YTD: monthEnd.ytd ?? null,
    '1Y': metrics.tr1y ?? null,
    '3Y': metrics.cagr3y ?? null,
    '5Y': metrics.cagr5y ?? null,
    '10Y': metrics.cagr10y ?? null,
  };
  const total: Record<ReturnPeriod, number | null> = {
    YTD: monthEnd.ytd ?? null,
    '1Y': metrics.tr1y ?? null,
    '3Y': metrics.tr3y ?? null,
    '5Y': metrics.tr5y ?? null,
    '10Y': metrics.tr10y ?? null,
  };
  for (const period of RETURN_PERIODS) {
    if (config.performanceRanges[period] && !matchesRange(published[period], config.performanceRanges[period])) return false;
    if (config.totalReturnRanges[period] && !matchesRange(total[period], config.totalReturnRanges[period])) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Per-fund update
// ---------------------------------------------------------------------------

type RunStats = { updated: number; unchanged: number; skipped: number; failed: number };

// --- metrics contract (STANDARD.md section 9a) -----------------------------
export const OFFICIAL_RETURNS_BASIS = 'official Global X fund page NAV Performance (monthly series)';
export const NO_RETURNS_BASIS = 'none: Global X has published no NAV performance for this fund in the feed yet, all returns are null';
export const DIVIDEND_YIELD_BASES = ['official-trailing-12m', 'official-distribution-rate', 'official-other', 'computed-trailing-12m', 'indicated'] as const;
export type DividendYieldBasis = typeof DIVIDEND_YIELD_BASES[number];
/** Global X publishes exactly one yield behind `dividendYield`: the official Distribution Rate (latest distribution annualized / ex-date NAV). */
export const GLOBALX_DIVIDEND_YIELD_BASIS: DividendYieldBasis = 'official-distribution-rate';
/** Every metrics key a published row carries, in its order: numbers default to null, their display texts to the empty-value text. */
const METRIC_KEYS: ReadonlyArray<[string, 'number' | 'text']> = [
  ['ytd', 'number'], ['tr1y', 'number'], ['tr3y', 'number'], ['tr5y', 'number'], ['tr10y', 'number'],
  ['cagr3y', 'number'], ['cagr5y', 'number'], ['cagr10y', 'number'], ['siAnn', 'number'],
  ['dividendYield', 'number'], ['dividendYieldText', 'text'], ['distributionYield', 'number'], ['distributionYieldText', 'text'],
  ['yield12M', 'number'], ['yield12MText', 'text'], ['secYield', 'number'], ['secYieldText', 'text'],
];

/**
 * Guarantees `metrics` on a catalog row: every key of METRIC_KEYS present (null
 * or the empty-value text when unknown), non-empty `returnsBasis` and `performanceAsOf` (ISO date of the
 * performance table, or null) as the last two keys. Rows the updater just
 * built already satisfy it; this covers placeholders and preserved rows.
 */
export function withMetricsContract<T extends Record<string, any>>(entry: T): T & { metrics: Record<string, any> } {
  const old: Record<string, any> = entry.metrics && typeof entry.metrics === 'object' ? entry.metrics : {};
  const { returnsBasis, performanceAsOf, dividendYieldBasis, ...rest } = old;
  // The full key set in the published order (a catalog-only row too), then any other key the row carries.
  const metrics: Record<string, any> = {};
  for (const [key, kind] of METRIC_KEYS) metrics[key] = key in rest ? rest[key] : (kind === 'text' ? formatPercentText(null) : null);
  for (const key of Object.keys(rest)) if (!(key in metrics)) metrics[key] = rest[key];
  const monthEnd = (entry.returns as any)?.monthEnd;
  const hasReturns = ['ytd', 'tr1y', 'cagr3y', 'cagr5y', 'cagr10y', 'siAnn'].some((key) => typeof metrics[key] === 'number');
  const basis = typeof returnsBasis === 'string' && returnsBasis.trim() && returnsBasis.trim() !== '-'
    ? returnsBasis
    : (hasReturns ? OFFICIAL_RETURNS_BASIS : NO_RETURNS_BASIS);
  const asOf = typeof performanceAsOf === 'string' && toIsoDate(performanceAsOf)
    ? toIsoDate(performanceAsOf)
    : (toIsoDate(monthEnd?.asOfDate) || null);
  // The code travels with the yield it describes: null exactly when dividendYield is null, else the one Global X definition.
  void dividendYieldBasis;
  metrics.dividendYieldBasis = typeof metrics.dividendYield === 'number' ? GLOBALX_DIVIDEND_YIELD_BASIS : null;
  metrics.returnsBasis = basis;
  metrics.performanceAsOf = asOf;
  return { ...entry, metrics };
}

function readNumber(entry: CatalogEntry, key: string): number | null {
  const value = (entry as any)[key];
  return typeof value === 'number' ? value : null;
}

async function readJsonIfExists(file: string): Promise<any | null> {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

/** The last published meta.json of a fund, or null. */
async function readPreviousMeta(ticker: string): Promise<Record<string, any> | null> {
  return readJsonIfExists(path.join(API_ROOT, 'funds', ticker, 'meta.json'));
}

/** The previously published history rows (all pages), or null when none were published. */
async function readPreviousHistory(ticker: string, meta: Record<string, any> | null): Promise<Array<Record<string, string>> | null> {
  const pages: unknown = meta?.history?.pages;
  if (!Array.isArray(pages) || !pages.length) return null;
  const rows: Array<Record<string, string>> = [];
  for (const page of pages) {
    const envelope = await readJsonIfExists(path.join(API_ROOT, 'funds', ticker, String(page)));
    if (!envelope || !Array.isArray(envelope.rows)) return null;
    rows.push(...envelope.rows);
  }
  return rows;
}

/** The previously published holdings (headers and all page rows), or null when none were published. */
async function readPreviousHoldings(ticker: string, meta: Record<string, any> | null): Promise<{ headers: string[]; rows: Array<Record<string, string>> } | null> {
  const pages: unknown = meta?.holdings?.pages;
  if (!Array.isArray(pages) || !pages.length) return null;
  let headers: string[] = [];
  const rows: Array<Record<string, string>> = [];
  for (const page of pages) {
    const envelope = await readJsonIfExists(path.join(API_ROOT, 'funds', ticker, String(page)));
    if (!envelope || !Array.isArray(envelope.rows)) return null;
    if (Array.isArray(envelope.headers)) headers = envelope.headers;
    rows.push(...envelope.rows);
  }
  return { headers, rows };
}

async function writeHistoryPages(fundDir: string, ticker: string, historyRows: Array<Record<string, string>>, config: UpdaterConfig, manifest: { pages: string[] }): Promise<boolean> {
  let changed = false;
  const historyPages = splitPages(historyRows, config.historyPageSize);
  for (let index = 0; index < historyPages.length; index += 1) {
    const file = path.join(fundDir, 'history', pageFileName(index + 1));
    const envelope = {
      ticker,
      page: index + 1,
      pageSize: config.historyPageSize,
      totalRows: historyRows.length,
      headers: [...HISTORY_HEADERS],
      rows: historyPages[index],
    };
    if (await writeIfChanged(file, stableStringify(envelope)) === 'written') changed = true;
    manifest.pages.push(`./history/${pageFileName(index + 1)}`);
  }
  return changed;
}

// Yahoo's adjusted close is float32 and its last digits move with the request's period2, so a value
// sitting on a cent boundary (31.544998 vs 31.545001) flips between runs. Within that noise the
// published cent is kept: a rerun with the same source data changes nothing.
export const ADJ_CLOSE_NOISE = 1e-4;

/** Fresh Yahoo rows; `published` (the previously written history) keeps its Adj Close cent within float noise. */
export function yahooHistoryRows(parsed: ReturnType<typeof parseYahooChart>, published: Array<Record<string, string>> | null = null): Array<Record<string, string>> {
  const prior = new Map((published || []).map((row) => [row.Date, row]));
  return parsed.history.map((row) => {
    const out = {
      Date: row.date,
      Close: row.close === null ? '' : row.close.toFixed(2),
      'Adj Close': row.adjClose === null ? '' : row.adjClose.toFixed(2),
      Volume: row.volume === null ? '' : String(row.volume),
    };
    const previous = prior.get(row.date);
    const priorAdj = previous ? numberOrNull(previous['Adj Close']) : null;
    const raw = row.adjCloseRaw ?? row.adjClose;
    if (previous && priorAdj !== null && raw !== null && out['Adj Close'] !== previous['Adj Close'] && Math.abs(raw - priorAdj) <= 0.005 + ADJ_CLOSE_NOISE) out['Adj Close'] = previous['Adj Close'];
    return out;
  });
}

/**
 * A HISTORY_RANGE window (`Ny`) never shrinks the published history: the shared windowed-chart block puts the published days
 * older than the window behind the fresh ones (Adj Close rescaled by the overlapping days) and keeps the older published Yahoo
 * dividends (`publishedDividends`: [date, amount] rows). Returns `parsed` unchanged for `max`, null when the window does not
 * join the published history (the caller keeps the published history).
 */
export function windowedYahooChart(parsed: ReturnType<typeof parseYahooChart>, range: string, published: Array<Record<string, string>> | null, publishedDividends: unknown[] = []): ReturnType<typeof parseYahooChart> | null {
  if (parseHistoryRange(range).years === null || !published || !published.length || !parsed.history.length) return parsed;
  const epoch = (iso: string): number => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 1000;
  const days: WindowedChartDay[] = [];
  for (let index = parsed.history.length - 1; index >= 0; index -= 1) {
    const row = parsed.history[index];
    if (row.close === null || row.adjClose === null) continue;
    const day: WindowedChartDay = { date: row.date, close: row.close, adjClose: row.adjClose, volume: row.volume ?? 0 };
    if (row.adjCloseRaw !== null && row.adjCloseRaw !== undefined) day.adjCloseRaw = row.adjCloseRaw;
    days.push(day);
  }
  const merged = mergeWindowedChart({ days, dividends: parsed.dividends.map((row) => ({ epoch: epoch(row.date), amount: row.amount })) }, published, publishedDividends);
  if (!merged) return null;
  const oldest = parsed.history[parsed.history.length - 1].date;
  const older: YahooHistoryRow[] = merged.days.filter((day) => day.date < oldest).reverse()
    .map((day) => ({ date: day.date, close: day.close, adjClose: day.adjClose, volume: day.volume, adjCloseRaw: day.adjCloseRaw ?? day.adjClose }));
  const dividends: YahooDistribution[] = merged.dividends.map((row) => ({ date: new Date(row.epoch * 1000).toISOString().slice(0, 10), amount: row.amount }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return { history: parsed.history.concat(older), dividends };
}

/** The published Yahoo dividend fallback rows (`Ex-Date`, `Dividend`) as [date, amount] for windowedYahooChart; [] when Global X published the distributions. */
function publishedYahooDividends(meta: Record<string, any> | null): unknown[] {
  const distributions = meta?.distributions;
  if (!distributions?.fallback || !Array.isArray(distributions.rows)) return [];
  return distributions.rows.map((row: Record<string, unknown>) => [row['Ex-Date'], row.Dividend]);
}

/**
 * SKIP_GLOBALX keeps every published figure and only refreshes the Yahoo
 * history (a fund is never rewritten from an empty page).
 */
async function updateHistoryOnly(fund: LineupFund, previousEntry: CatalogEntry | undefined, config: UpdaterConfig, stats: RunStats): Promise<CatalogEntry> {
  const ticker = fund.ticker;
  const previousMeta = await readPreviousMeta(ticker);
  if (!previousEntry || !previousMeta) throw new Error(`${ticker}: SKIP_GLOBALX needs previously published data`);
  if (config.skipYahoo) { stats.unchanged += 1; return previousEntry; }
  const url = yahooChartUrl(ticker, config.historyRange);
  const json = await fetchWithRetry(url, yahooHeaders(), config, `${ticker} Yahoo chart`, (response) => response.json());
  const published = await readPreviousHistory(ticker, previousMeta);
  // A HISTORY_RANGE window never shrinks the published history; a window that does not join it keeps the fund as published
  const chart = windowedYahooChart(parseYahooChart(json), config.historyRange, published, publishedYahooDividends(previousMeta));
  if (!chart) throw new Error(`${ticker}: the Yahoo window (${config.historyRange}) does not join the published history, keeping the published data`);
  const rows = yahooHistoryRows(chart, published);
  if (!rows.length) throw new Error(`${ticker}: Yahoo returned no bars`);
  const fundDir = path.join(API_ROOT, 'funds', ticker);
  const manifest = {
    ...previousMeta.history,
    pages: [] as string[],
    pageSize: config.historyPageSize,
    totalRows: rows.length,
    asOfDate: formatGlobalXDate(rows[0].Date),
    asOf: rows[0].Date,
  };
  let changed = await writeHistoryPages(fundDir, ticker, rows, config, manifest);
  if (await writeIfChanged(path.join(fundDir, 'meta.json'), stableStringify({ ...previousMeta, history: manifest })) === 'written') changed = true;
  await prunePages(path.join(fundDir, 'history'), manifest.pages.length);
  if (changed) stats.updated += 1; else stats.unchanged += 1;
  return { ...previousEntry, history: rows.length };
}

async function updateFund(
  fund: LineupFund,
  config: UpdaterConfig,
  stats: RunStats,
  previousEntry?: CatalogEntry,
): Promise<CatalogEntry | null> {
  const ticker = fund.ticker;
  if (config.skipGlobalX) return updateHistoryOnly(fund, previousEntry, config, stats);
  const fundDir = path.join(API_ROOT, 'funds', ticker);
  let changed = false;
  const previousMeta = await readPreviousMeta(ticker);

  let pageHtml = '';
  {
    pageHtml = await fetchText(globalxFundPageUrl(ticker), browserHeaders(), config, `${ticker} fund page`);
    if (config.storeRawDownloads) {
      await writeIfChanged(path.join(API_ROOT, 'raw', `${ticker}-fund-page.html`), pageHtml);
    }
  }

  const details = parseGlobalXFundDetails(pageHtml);
  const distributionInfo = parseGlobalXDistributionInfo(pageHtml);
  // Rows the earlier page published with the exact amount keep it (see keepPublishedAmountPrecision).
  const distributionRows = keepPublishedAmountPrecision(parseGlobalXDistributionHistory(pageHtml), previousMeta?.distributions?.fallback ? null : previousMeta?.distributions?.rows);
  const monthly = parseGlobalXPerformanceSection(pageHtml, 'monthly-performance');
  const quarterly = parseGlobalXPerformanceSection(pageHtml, 'quarterly-performance');
  const navIndex = parseGlobalXNavIndex(pageHtml);
  const documents = parseGlobalXDocuments(pageHtml);
  // A 200 answer without the fund payload (bot wall, error page) must not overwrite a published fund with nulls.
  if (details.netAssetValue === null && details.netAssets === null && !monthly) {
    throw new Error(`${ticker}: the fund page carried no fund details, keeping the published data`);
  }

  // --- holdings (official daily CSV) -------------------------------------
  let holdings = {
    headers: [...HOLDINGS_HEADERS] as string[],
    rows: [] as Array<Record<string, string>>,
    asOfDate: '',
    netAssets: null as number | null,
    sharesOutstanding: null as number | null,
    creationUnits: null as number | null,
    totalRows: 0,
    source: globalxProvenanceHoldingsUrl(ticker, pageHtml),
    sourceKind: 'official Global X daily full-holdings CSV (assets.globalxetfs.com)',
  };
  let holdingsFresh = false; // false while holdings.rows is the previous run's sheet
  let nportDocument: string | null = null; // the N-PORT primary_doc.xml the sheet was read from, null for the issuer CSV
  {
    try {
      const csv = await fetchText(globalxHoldingsCsvUrl(ticker, pageHtml), browserHeaders(), config, `${ticker} holdings CSV`);
      if (/^\s*</.test(csv)) throw new Error(`${ticker} holdings CSV: received HTML instead of CSV`);
      const parsed = parseGlobalXHoldingsCsv(csv);
      holdings = { ...holdings, ...parsed, headers: parsed.headers, source: globalxProvenanceHoldingsUrl(ticker, pageHtml) };
      holdingsFresh = true;
      if (config.storeRawDownloads) {
        await writeIfChanged(path.join(API_ROOT, 'raw', `${ticker}-holdings.csv`), csv);
      }
    } catch (error) {
      // A fund in liquidation no longer publishes its holdings CSV: keep the
      // last published holdings and still refresh the fund details.
      const kept = isGlobalXFundInLiquidation(pageHtml) ? await readPreviousHoldings(ticker, previousMeta) : null;
      if (kept && previousMeta?.holdings) {
        outputNote(`[ ${'holdings'.padEnd(9)}] ${ticker}: fund in liquidation, holdings CSV unavailable (${errorMessage(error)}), keeping the published holdings`);
        holdings = {
          ...holdings,
          headers: kept.headers.length ? kept.headers : holdings.headers,
          rows: kept.rows,
          asOfDate: toIsoDate(previousMeta.holdings.asOf) || '',
          totalRows: kept.rows.length,
          source: String(previousMeta.holdings.source || holdings.source),
          sourceKind: `${String(previousMeta.holdings.sourceKind || holdings.sourceKind).replace(LIQUIDATION_KEPT_NOTE, '')}${LIQUIDATION_KEPT_NOTE}`,
        };
      } else {
        if (!config.edgarFallback) throw error;
        outputNote(`[ ${'holdings'.padEnd(9)}] ${ticker}: holdings CSV unavailable (${errorMessage(error)}), trying EDGAR`);
        // The fund's own newest N-PORT-P filing (shared nport-reader block): identity by the series id of SEC's fund ticker
        // table (the fund name only when SEC lists no series for the ticker), read only when its report period is strictly newer
        // than the published holdings date (the issuer's daily CSV date, or an earlier N-PORT report period).
        const ref = (await loadFundTickerTable(config)).get(ticker);
        const read = await readNportHoldings(
          ref ? { ticker, cik: ref.cik, seriesId: ref.seriesId } : { ticker, cik: GLOBALX_ETF_TRUST_CIK, seriesId: null, name: /^global x\b/i.test(fund.name) ? fund.name : `Global X ${fund.name}` },
          { asOf: calendarIso(previousMeta?.holdings?.asOf) ?? calendarIso(previousMeta?.holdings?.asOfDate), rows: numberOrNull(previousMeta?.holdings?.totalRows) ?? 0 },
          (url, label) => fetchText(url, secHeaders(config), config, label),
          { cache: secState.reader },
        );
        if ('problem' in read) throw new Error(`${read.problem}; ${previousMeta ? 'kept the previous complete data' : 'no data published for this fund yet'}`);
        const rows = nportHoldingsSheet(read.filing, nportTickers(read.filing.positions, await loadCompanyNames(config).catch(() => null)));
        outputNote(`[ ${'nport'.padEnd(9)}] ${ticker}: N-PORT ${read.candidate.accession}, report period ${read.filing.repPdDate || 'n/a'}, ${rows.length} positions${read.loose ? ' (series name matched loosely)' : ''}`);
        holdings = {
          ...holdings,
          headers: [...HOLDINGS_HEADERS],
          rows,
          asOfDate: read.filing.repPdDate,
          totalRows: rows.length,
          source: read.url,
          sourceKind: `SEC EDGAR Form N-PORT-P (fallback; accession ${read.candidate.accession}, report period ${read.filing.repPdDate || 'n/a'})`,
        };
        nportDocument = read.url;
        holdingsFresh = true;
      }
    }
  }
  // Fresh holdings that look broken (no weight column, non-numeric weights, a bad weight sum, half the rows gone) never replace the published ones.
  // No relax lets a sheet without a single numeric weight replace a published sheet that had numeric weights (Q24).
  const publishedHoldings = holdingsFresh && previousMeta ? await readPreviousHoldings(ticker, previousMeta) : null;
  const publishedWeights = publishedHoldings ? holdingsWeightCount(publishedHoldings.headers.length ? publishedHoldings.headers : [...HOLDINGS_HEADERS], publishedHoldings.rows) : null;
  const holdingsProblem = holdingsFresh ? holdingsGuard(holdings.headers, holdings.rows, numberOrNull(previousMeta?.holdings?.totalRows), HOLDINGS_GUARD_RELAX[ticker] ?? HOLDINGS_GUARD_RELAX['*'] ?? [], publishedWeights) : null;
  if (holdingsProblem) throw new Error(`holdings guard: ${holdingsProblem}; ${previousMeta ? 'kept the previous complete data' : 'no data published for this fund yet'}`);

  // --- daily history + dividend fallback (Yahoo) -------------------------
  // A failed or skipped Yahoo read keeps the previously published history.
  let historyRows: Array<Record<string, string>> = [];
  let yahooDividends: YahooDistribution[] = [];
  let yahooExchange: string | null = null;
  let historyKept = false;
  if (!config.skipYahoo) {
    try {
      const url = yahooChartUrl(ticker, config.historyRange);
      const json = await fetchWithRetry(url, yahooHeaders(), config, `${ticker} Yahoo chart`, (response) => response.json());
      const published = await readPreviousHistory(ticker, previousMeta);
      // A HISTORY_RANGE window never shrinks the published history (shared windowed-chart block)
      const parsed = windowedYahooChart(parseYahooChart(json), config.historyRange, published, publishedYahooDividends(previousMeta));
      if (!parsed) throw new Error(`the window (${config.historyRange}) does not join the published history`);
      yahooDividends = parsed.dividends;
      yahooExchange = parseYahooExchangeName(json);
      historyRows = yahooHistoryRows(parsed, published);
    } catch (error) {
      outputNote(`[ ${'chart'.padEnd(9)}] ${ticker}: Yahoo chart unavailable (${errorMessage(error)}), keeping the published history`);
    }
  }
  if (!historyRows.length) {
    const kept = await readPreviousHistory(ticker, previousMeta);
    if (kept) { historyRows = kept; historyKept = true; }
  }

  // --- assemble metrics --------------------------------------------------
  // The lineup prints Net Assets to the cent; the fund page panel only rounds it ($90.97 million).
  const netAssets = holdings.netAssets ?? fund.netAssets ?? details.netAssets ?? null;
  const sharesOutstanding = holdings.sharesOutstanding ?? details.sharesOutstanding ?? null;
  // Global X prints NAV and Market Price directly; the derived quotient is only a
  // guard for the day a fund page omits the panel.
  const derivedNav = netAssets !== null && sharesOutstanding ? round(netAssets / sharesOutstanding, 2) : null;
  const navValue = details.netAssetValue ?? derivedNav;
  const navKind = details.netAssetValue !== null ? 'official (fund page Fund Details)' : 'derived (Net Assets / Shares Outstanding)';
  const marketPriceValue = details.marketPrice
    ?? (historyRows.length ? numberOrNull(historyRows[0].Close) : null);
  const derivedPremiumDiscount = navValue && marketPriceValue !== null ? round(((marketPriceValue - navValue) / navValue) * 100, 2) : null;
  // Global X prints its own latest premium/discount; the quotient is only the guard
  // for the day the page omits it.
  const premiumDiscount = details.premiumDiscount ?? derivedPremiumDiscount;
  const premiumDiscountKind = details.premiumDiscount !== null
    ? 'official (fund page Daily Premium / Discount, latest day)'
    : 'derived (Market Price - NAV) / NAV';

  const monthEndValues = monthly?.nav || {};
  const quarterEndValues = quarterly?.nav || {};
  const monthEndDate = monthly?.asOfDate || '';
  const quarterEndDate = quarterly?.asOfDate || '';

  const rateValue = positiveYieldOrNull(distributionInfo?.distributionRate ?? fund.distributionRate ?? null);
  const performanceAsOfIso = toIsoDate(monthEndDate) || null;
  const grossExpense = fund.grossExpense ?? numberOrNull(details.totalOperatingExpensesText) ?? fund.managementFee ?? null;
  const inceptionIso = toIsoDate(fund.inceptionDate) || toIsoDate(details.inceptionDate);
  // The shared "younger than its horizon" rule (calendar anniversary of the inception, inclusive): no 1-year or since-inception
  // return before the first anniversary, no 3, 5 or 10-year return before those; an unknown date keeps the value.
  const returns = withoutYoungReturns({
    tr1y: monthEndValues.yr1 ?? null,
    tr3y: cumulativeFromAnnualized(monthEndValues.yr3 ?? null, 3),
    tr5y: cumulativeFromAnnualized(monthEndValues.yr5 ?? null, 5),
    tr10y: cumulativeFromAnnualized(monthEndValues.yr10 ?? null, 10),
    cagr3y: monthEndValues.yr3 ?? null,
    cagr5y: monthEndValues.yr5 ?? null,
    cagr10y: monthEndValues.yr10 ?? null,
    siAnn: monthEndValues.sinceInception ?? null,
  }, inceptionIso, performanceAsOfIso, { tr1y: 1, tr3y: 3, tr5y: 5, tr10y: 10, cagr3y: 3, cagr5y: 5, cagr10y: 10, siAnn: 1 });
  const metrics = {
    ytd: monthEndValues.ytd ?? null,
    ...returns,
    dividendYield: rateValue,
    dividendYieldText: formatPercentText(rateValue),
    distributionYield: rateValue,
    distributionYieldText: formatPercentText(rateValue),
    yield12M: distributionInfo?.trailingRate12M ?? null,
    yield12MText: formatPercentText(distributionInfo?.trailingRate12M ?? null),
    secYield: distributionInfo?.secYield ?? fund.secYield ?? null,
    secYieldText: formatPercentText(distributionInfo?.secYield ?? fund.secYield ?? null),
    dividendYieldBasis: rateValue === null ? null : GLOBALX_DIVIDEND_YIELD_BASIS,
    returnsBasis: OFFICIAL_RETURNS_BASIS,
    // The month-end date printed on the Global X performance table, not the NAV date.
    performanceAsOf: performanceAsOfIso,
  };

  // Yield and return filters decide BEFORE any file is written, so an excluded fund keeps its published state whole.
  if (!passesDataFilters(metrics, monthEndValues, config)) {
    stats.skipped += 1;
    return null;
  }

  const latestDistribution = distributionRows.find((row) => row['Amount ($)'] && !isMissingCell(row['Amount ($)']));
  const exDates = distributionRows.map((row) => row['Ex-Div Date']);
  const frequencyLabel = distributionInfo?.frequency || details.distributionFrequency || fund.frequency || '—';
  const frequencyCode = formatDistributionFrequency(frequencyLabel);
  const paymentCount = paymentsPerYear(frequencyLabel);

  let holdingsMeta = {
    pages: [] as string[],
    pageSize: config.holdingsPageSize,
    totalRows: holdings.totalRows,
    asOfDate: holdings.asOfDate ? formatGlobalXDate(holdings.asOfDate) : '',
    asOf: holdings.asOfDate,
    source: holdings.source,
    sourceKind: holdings.sourceKind,
  };
  let historyMeta = {
    pages: [] as string[],
    pageSize: config.historyPageSize,
    totalRows: historyRows.length,
    asOfDate: historyRows.length ? formatGlobalXDate(historyRows[0].Date) : '',
    asOf: historyRows.length ? historyRows[0].Date : '',
    source: historyKept ? String(previousMeta?.history?.source || yahooChartProvenanceUrl(ticker)) : (config.skipYahoo ? '' : yahooChartProvenanceUrl(ticker)),
    sourceKind: 'Yahoo Finance public chart API (daily Close / Adj Close / Volume)',
  };

  const meta: Record<string, unknown> = {
    ticker,
    name: fund.name,
    category: fund.category,
    categoryClass: fund.categoryClass || null,
    dataFile: `./funds/${ticker}/meta.json`,
    fundPage: globalxFundPageUrl(ticker),
    source: {
      provider: 'Global X Investment Management LLC (Global X ETFs)',
      site: GLOBALX_SITE,
      lineup: GLOBALX_LINEUP_URL,
      fundPage: globalxFundPageUrl(ticker),
      holdingsDownload: holdings.source,
      holdingsSource: holdings.sourceKind,
      historySource: historyMeta.sourceKind,
      historyUrl: historyMeta.source,
      returnsSource: 'Global X fund page performance tables (NAV Performance)',
      distributionsSource: 'Global X fund page Distribution History table',
      distributionInfoSource: 'Global X fund page Distribution Information block',
      documentsSource: 'Global X fund page Documents table',
      registrant: `Global X Funds (Investment Company Act file ${GLOBALX_ETF_TRUST_FILE_NUMBER})`,
      // the N-PORT primary_doc.xml the holdings were read from; no key when they came from the issuer CSV
      ...(nportDocument ? { nportDoc: nportDocument } : {}),
      exchangeSource: 'Global X fund page Fund Details "Primary Exchange"',
      navSource: `Global X fund page Fund Details "Net Asset Value" (${navKind})`,
      premiumDiscountSource: premiumDiscountKind,
      bidAskSpreadSource: 'Global X fund page Fund Details "30-Day Median Bid-Ask Spread"',
    },
    identifiers: {
      cusip: details.cusip || null,
      isin: details.isin || null,
      underlyingExposure: details.underlyingExposure || null,
      indexName: details.underlyingExposure || null,
      benchmarkIndexName: monthly?.benchmarkName || null,
    },
    expenseRatio: {
      display: fund.managementFeeText || details.totalOperatingExpensesText || null,
      value: fund.managementFee ?? numberOrNull(details.totalOperatingExpensesText) ?? null,
      gross: grossExpense,
      managementFeeDisplay: details.managementFeeText || fund.managementFeeText || null,
      managementFeeValue: numberOrNull(details.managementFeeText) ?? fund.managementFee ?? null,
    },
    nav: {
      display: formatMoneyText(navValue),
      value: navValue,
      asOfDate: details.asOfDate ? formatGlobalXDate(details.asOfDate) : holdingsMeta.asOfDate,
      dailyChangeText: details.navDailyChangeValue === null
        ? null
        : `${formatMoneyText(details.navDailyChangeValue)} (${formatPercentText(details.navDailyChangePercent)})`,
      kind: navKind,
    },
    marketPrice: {
      display: formatMoneyText(marketPriceValue),
      value: marketPriceValue,
      asOfDate: details.asOfDate ? formatGlobalXDate(details.asOfDate) : '',
      dailyChangeText: details.marketPriceDailyChangeValue === null
        ? null
        : `${formatMoneyText(details.marketPriceDailyChangeValue)} (${formatPercentText(details.marketPriceDailyChangePercent)})`,
      source: details.marketPrice !== null ? 'Global X fund page Fund Details "Market Price"' : 'Yahoo Finance daily close',
    },
    premiumDiscount: {
      display: formatPercentText(premiumDiscount),
      value: premiumDiscount,
      derivedValue: derivedPremiumDiscount,
      kind: premiumDiscountKind,
    },
    bidAskSpread: {
      display: details.bidAskSpreadText || null,
      value: details.bidAskSpread,
      asOfDate: details.asOfDate ? formatGlobalXDate(details.asOfDate) : null,
      kind: 'official (fund page Fund Details "30-Day Median Bid-Ask Spread")',
    },
    aum: {
      display: netAssets === null ? null : formatAumDisplay(netAssets),
      value: netAssets,
      asOfDate: details.asOfDate ? formatGlobalXDate(details.asOfDate) : holdingsMeta.asOfDate,
      source: holdings.netAssets !== null
        ? holdings.sourceKind
        : (fund.netAssets !== null ? 'Global X ETF lineup "Net Assets"' : 'Global X fund page Fund Details "Net Assets"'),
    },
    sharesOutstanding: {
      display: sharesOutstanding === null ? null : sharesOutstanding.toLocaleString('en-US'),
      value: sharesOutstanding,
      asOfDate: holdingsMeta.asOfDate,
    },
    yields: {
      dividendYield: metrics.dividendYield,
      dividendYieldText: metrics.dividendYieldText,
      dividendYieldKind: 'official Global X Distribution Rate (latest distribution annualized / ex-date NAV)',
      distributionRate: metrics.distributionYield,
      distributionRateText: metrics.distributionYieldText,
      yield12M: metrics.yield12M,
      yield12MText: metrics.yield12MText,
      secYield: metrics.secYield,
      secYieldText: metrics.secYieldText,
      secYieldKind: 'official Global X 30-Day SEC Yield',
      distributionAmountText: distributionInfo?.distributionAmountText || null,
      distributionAmountPercentText: distributionInfo?.distributionAmountPercentText || null,
      distributionInfoAsOfDate: distributionInfo?.asOfDate ? formatGlobalXDate(distributionInfo.asOfDate) : null,
    },
    returns: {
      derivedFrom: 'official Global X fund page performance tables (NAV Performance series)',
      monthEnd: {
        asOfDate: formatGlobalXDate(monthEndDate),
        raw: monthEndDate,
        mo1: monthEndValues.mo1 ?? null,
        mo3: monthEndValues.mo3 ?? null,
        mo6: monthEndValues.mo6 ?? null,
        ytd: monthEndValues.ytd ?? null,
        yr1: monthEndValues.yr1 ?? null,
        yr3: monthEndValues.yr3 ?? null,
        yr5: monthEndValues.yr5 ?? null,
        yr10: monthEndValues.yr10 ?? null,
        sinceInception: monthEndValues.sinceInception ?? null,
        sinceInceptionCumulative: monthEndValues.sinceInceptionCumulative ?? null,
        market: monthly?.market || {},
        benchmarkName: monthly?.benchmarkName || null,
        benchmark: monthly?.benchmark || {},
      },
      quarterEnd: {
        asOfDate: formatGlobalXDate(quarterEndDate),
        raw: quarterEndDate,
        mo1: quarterEndValues.mo1 ?? null,
        mo3: quarterEndValues.mo3 ?? null,
        mo6: quarterEndValues.mo6 ?? null,
        ytd: quarterEndValues.ytd ?? null,
        yr1: quarterEndValues.yr1 ?? null,
        yr3: quarterEndValues.yr3 ?? null,
        yr5: quarterEndValues.yr5 ?? null,
        yr10: quarterEndValues.yr10 ?? null,
        sinceInception: quarterEndValues.sinceInception ?? null,
        sinceInceptionCumulative: quarterEndValues.sinceInceptionCumulative ?? null,
        market: quarterly?.market || {},
      },
    },
    navIndex: navIndex
      ? {
          startDate: navIndex.startDate,
          endDate: navIndex.endDate,
          points: navIndex.points,
          benchmarkName: monthly?.benchmarkName || null,
          source: 'Global X fund page "Growth of $10,000 at NAV Since Inception" chart series',
        }
      : null,
    distributions: {
      frequency: frequencyLabel,
      paymentsPerYear: paymentCount ?? inferPaymentsFromRows(exDates),
      headers: [...GLOBALX_DISTRIBUTION_HEADERS],
      rows: distributionRows,
      fallback: false,
      source: 'Global X fund page Distribution History table',
    },
    documents: { ...documents },
    holdings: holdingsMeta,
    history: historyMeta,
  };

  // Yahoo dividend history is the fallback only when Global X published no rows.
  if (!distributionRows.length && yahooDividends.length) {
    (meta.distributions as Record<string, unknown>).headers = ['Ex-Date', 'Dividend'];
    (meta.distributions as Record<string, unknown>).rows = yahooDividends.map((row) => ({
      'Ex-Date': formatGlobalXDate(row.date),
      Dividend: `$${row.amount.toFixed(4)}`,
    }));
    (meta.distributions as Record<string, unknown>).frequency = formatDistributionFrequency(
      inferDistributionFrequency(yahooDividends.map((row) => row.date)),
    );
    (meta.distributions as Record<string, unknown>).fallback = true;
    (meta.distributions as Record<string, unknown>).source = 'Yahoo Finance dividend history (Global X published no distribution rows)';
  }

  // --- write pages -------------------------------------------------------
  // Every page file is written before `meta.json`, because the manifest it
  // carries lists exactly the files that were just published.
  const holdingsPages = splitPages(holdings.rows, config.holdingsPageSize);
  for (let index = 0; index < holdingsPages.length; index += 1) {
    const file = path.join(fundDir, 'holdings', pageFileName(index + 1));
    const envelope = {
      ticker,
      page: index + 1,
      pageSize: config.holdingsPageSize,
      totalRows: holdings.rows.length,
      headers: holdings.headers,
      rows: holdingsPages[index],
    };
    if (await writeIfChanged(file, stableStringify(envelope)) === 'written') changed = true;
    holdingsMeta.pages.push(`./holdings/${pageFileName(index + 1)}`);
  }

  if (await writeHistoryPages(fundDir, ticker, historyRows, config, historyMeta)) changed = true;

  // --- catalog entry -----------------------------------------------------
  // The catalog row is built first: `meta.json` mirrors it (the sibling feeds
  // publish the same fields in both files) and `index.json` collects it.
  const inferredExchange = details.primaryExchange || yahooExchange || null;
  // globalxetfs.com prints two inception dates for a fund whose ETF share class
  // was converted from a predecessor fund (HYBI: the lineup table keeps the
  // predecessor's 2014 date its performance history is based on, while the fund
  // page panel shows the 2024 conversion). The catalog shows the lineup figure
  // and meta.json keeps both.
  const lineupInception = fund.inceptionDate || '';
  const fundPageInception = details.inceptionDate || '';
  const entry: CatalogEntry = {
    ticker,
    name: fund.name,
    category: fund.category,
    fundPage: globalxFundPageUrl(ticker),
    dataFile: `./funds/${ticker}/meta.json`,
    cusip: details.cusip || null,
    isin: details.isin || null,
    ter: fund.managementFeeText || details.totalOperatingExpensesText || '—',
    // terValue is the NET ratio (the lineup prints NET_EXP after waivers, GROSS_EXP otherwise);
    // terGrossValue is the published GROSS ratio, never a copy of the net one.
    terValue: fund.managementFee ?? numberOrNull(details.totalOperatingExpensesText) ?? null,
    terGross: grossExpense === null ? null : formatPercentText(grossExpense),
    terGrossValue: grossExpense,
    nav: formatMoneyText(navValue),
    navValue,
    aum: netAssets === null ? '—' : formatAumDisplay(netAssets),
    aumValue: netAssets,
    asOfDate: details.asOfDate ? formatGlobalXDate(details.asOfDate) : (holdings.asOfDate ? formatGlobalXDate(holdings.asOfDate) : ''),
    inceptionDate: formatGlobalXDate(lineupInception || fundPageInception),
    inceptionDateFundPage: fundPageInception ? formatGlobalXDate(fundPageInception) : null,
    exchange: inferredExchange,
    closePrice: formatMoneyText(marketPriceValue),
    closePriceValue: marketPriceValue,
    premiumDiscount: formatPercentText(premiumDiscount),
    premiumDiscountValue: premiumDiscount,
    premiumDiscountDerivedValue: derivedPremiumDiscount,
    premiumDiscountKind,
    bidAskSpread: details.bidAskSpreadText || null,
    bidAskSpreadValue: details.bidAskSpread,
    acquiredFundFeesText: details.acquiredFundFeesText,
    totalNetAssets: netAssets,
    sharesOutstanding,
    netAssetsAsOf: details.asOfDate ? formatGlobalXDate(details.asOfDate) : (holdings.asOfDate ? formatGlobalXDate(holdings.asOfDate) : ''),
    secYieldAsOf: distributionInfo?.asOfDate ? formatGlobalXDate(distributionInfo.asOfDate) : null,
    distributions: {
      frequency: frequencyLabel,
      paymentsPerYear: paymentCount ?? null,
      exDate: latestDistribution ? latestDistribution['Ex-Div Date'] : null,
      dividend: latestDistribution ? latestDistribution['Amount ($)'] : null,
    },
    returns: {
      monthEnd: {
        asOfDate: formatGlobalXDate(monthEndDate),
        ytd: monthEndValues.ytd ?? null,
        ytdText: formatPercentText(monthEndValues.ytd ?? null),
        yr1: monthEndValues.yr1 ?? null,
        yr3: monthEndValues.yr3 ?? null,
        yr5: monthEndValues.yr5 ?? null,
        yr10: monthEndValues.yr10 ?? null,
        sinceInception: monthEndValues.sinceInception ?? null,
        // The page's own "Inception (Cumulative)" cell, which the app's
        // Overview tab renders beside the annualized figure.
        sinceInceptionCumulative: monthEndValues.sinceInceptionCumulative ?? null,
        sinceInceptionCumulativeText: formatPercentText(monthEndValues.sinceInceptionCumulative ?? null),
      },
      quarterEnd: {
        asOfDate: formatGlobalXDate(quarterEndDate),
        ytd: quarterEndValues.ytd ?? null,
        yr1: quarterEndValues.yr1 ?? null,
        yr3: quarterEndValues.yr3 ?? null,
        yr5: quarterEndValues.yr5 ?? null,
        yr10: quarterEndValues.yr10 ?? null,
        sinceInception: quarterEndValues.sinceInception ?? null,
        sinceInceptionCumulative: quarterEndValues.sinceInceptionCumulative ?? null,
        sinceInceptionCumulativeText: formatPercentText(quarterEndValues.sinceInceptionCumulative ?? null),
      },
    },
    metrics,
    distributionFrequency: frequencyCode,
    providerCategory: fund.category,
    holdings: holdings.totalRows,
    history: historyRows.length,
    navKind,
  };

  // `meta.json` carries the catalog row plus the sheet manifests, the
  // provenance block and the richer per-field objects (the sibling feeds have
  // exactly this shape, so a consumer can read either file for the headline
  // figures).
  const metaWithCatalog: Record<string, unknown> = {
    ...entry,
    source: meta.source,
    identifiers: meta.identifiers,
    expenseRatio: meta.expenseRatio,
    nav: meta.nav,
    marketPrice: meta.marketPrice,
    premiumDiscount: meta.premiumDiscount,
    bidAskSpread: meta.bidAskSpread,
    aum: meta.aum,
    sharesOutstanding: meta.sharesOutstanding,
    yields: meta.yields,
    returns: meta.returns,
    navIndex: meta.navIndex,
    distributions: meta.distributions,
    documents: meta.documents,
    inceptionNote: lineupInception && fundPageInception && lineupInception !== fundPageInception
      ? `globalxetfs.com publishes ${formatGlobalXDate(lineupInception)} in the ETF lineup table and ${formatGlobalXDate(fundPageInception)} in the Fund Details panel (the date the fund's predecessor converted into the ETF); the catalog shows the lineup figure, which is the basis of the published 5Y and 10Y returns.`
      : null,
    holdings: holdingsMeta,
    history: historyMeta,
  };
  if (await writeIfChanged(path.join(fundDir, 'meta.json'), stableStringify(metaWithCatalog)) === 'written') changed = true;
  // Stale pages go only after the new meta.json (which lists the live pages) is in place.
  await prunePages(path.join(fundDir, 'holdings'), holdingsPages.length);
  await prunePages(path.join(fundDir, 'history'), historyMeta.pages.length);

  if (changed) stats.updated += 1; else stats.unchanged += 1;

  return entry;
}


function inferPaymentsFromRows(exDates: string[]): number | null {
  const code = inferDistributionFrequency(exDates);
  if (code === '01 - Monthly') return 12;
  if (code === '04 - Quarterly') return 4;
  if (code === '06 - Semi-annually') return 2;
  if (code === '12 - Annually') return 1;
  return null;
}

/** Remove page files beyond `count` so a shrinking fund leaves no orphan pages. */
async function prunePages(dir: string, count: number): Promise<void> {
  if (!existsSync(dir)) return;
  const files = (await readdir(dir)).filter((name) => /^\d{3}\.json$/.test(name));
  for (const file of files) {
    const index = Number(file.slice(0, 3));
    if (index > count) await rm(path.join(dir, file));
  }
}

async function readCursor(): Promise<string | null> {
  const file = path.join(API_ROOT, 'update-state.json');
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    return parsed.cursor ? String(parsed.cursor) : null;
  } catch {
    return null;
  }
}

/** The run stops taking new funds after this long and still writes the index (the workflow allows 30 minutes). */
export const SOFT_DEADLINE_MS = 25 * 60 * 1000;

const isoNow = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Index row for a lineup fund that has no published data yet: no meta.json, so dataFile is null. */
function placeholderRow(fund: LineupFund): CatalogEntry {
  return {
    ticker: fund.ticker,
    name: fund.name,
    category: fund.category,
    fundPage: fund.fundPage,
    dataFile: null,
    holdings: 0,
    history: 0,
    metrics: withMetricsContract({}).metrics,
  };
}

/** `dataFile` points at a file that exists, or is null. */
function withDataFile<T extends CatalogEntry>(entry: T): T {
  const exists = existsSync(path.join(API_ROOT, 'funds', entry.ticker, 'meta.json'));
  return { ...entry, dataFile: exists ? `./funds/${entry.ticker}/meta.json` : null };
}

export type MainOptions = { apiRoot?: string; deadlineMs?: number };

export async function main(env: Record<string, string | undefined> = process.env, options: MainOptions = {}): Promise<void> {
  if (process.argv.slice(2).some((arg) => arg === '-h' || arg === '--help')) {
    console.log(USAGE);
    return;
  }
  const controls = await runtimeControls(env);
  installSystemCa(controls.USE_SYSTEM_CA ?? 'auto');
  if (controls.VERBOSE !== undefined && env === process.env) process.env.VERBOSE = controls.VERBOSE;
  const config = readConfig(controls);
  if (options.apiRoot) setApiRootForTests(options.apiRoot);
  const startedAt = Date.now();
  const deadlineAt = startedAt + (options.deadlineMs ?? SOFT_DEADLINE_MS);
  outputPrintConfig('Global X', config);
  resetSecState();
  const stats: RunStats = { updated: 0, unchanged: 0, skipped: 0, failed: 0 };

  // The lineup table is the catalog: it lists every fund, its asset class, the
  // declared distribution frequency and the headline figures.
  let lineup: LineupFund[] = [];
  const indexFile = path.join(API_ROOT, 'index.json');
  const previous: Record<string, CatalogEntry> = {};
  let previousIndex: Record<string, any> | null = null;
  if (existsSync(indexFile)) {
    try {
      previousIndex = JSON.parse(await readFile(indexFile, 'utf8'));
      for (const fund of previousIndex?.funds || []) previous[fund.ticker] = fund;
    } catch {
      previousIndex = null;
    }
  }

  if (!config.skipGlobalX) {
    const home = await fetchText(GLOBALX_LINEUP_URL, browserHeaders(), config, 'Global X home page');
    if (config.storeRawDownloads) await writeIfChanged(path.join(API_ROOT, 'raw', 'lineup.html'), home);
    lineup = parseGlobalXLineup(home);
    if (!lineup.length) throw new Error('lineup: no ETF table rows were found on globalxetfs.com/explore');
  } else {
    lineup = Object.values(previous).map((entry) => ({
      ticker: String(entry.ticker),
      name: String(entry.name || ''),
      category: String(entry.category || ''),
      categoryClass: '',
      frequency: String((entry as any).distributions?.frequency || ''),
      distributionRate: readNumber((entry.metrics || {}) as CatalogEntry, 'dividendYield'),
      distributionRateText: '',
      secYield: null,
      secYieldText: '',
      managementFee: readNumber(entry, 'terValue'),
      grossExpense: readNumber(entry, 'terGrossValue'),
      managementFeeText: String(entry.ter || ''),
      netAssets: readNumber(entry, 'aumValue'),
      netAssetsText: String(entry.aum || ''),
      inceptionDate: String(entry.inceptionDate || ''),
      fundPage: String(entry.fundPage || ''),
    }));
  }
  console.log(`[ catalog  ] ${lineup.length} Global X ETFs (${config.skipGlobalX ? 'previous index, SKIP_GLOBALX' : 'globalxetfs.com Explore Our ETFs table'})`);

  // The live catalog (null when only the published feed is known, SKIP_GLOBALX): a catalog-only row it no longer lists is dropped.
  const live = config.skipGlobalX ? null : lineup.map((fund) => fund.ticker);
  // Q27: a TICKERS entry outside the live lineup and the published funds (a closed fund keeps its data) stops the run before any fund request
  if (config.tickers.length) assertKnownTickers(config.tickers, knownTickers(live, Object.values(previous)), 'the Global X lineup or published feed');

  // MAX_FETCHES batches walk the filtered set in lineup order from the saved cursor and wrap around.
  // A TICKERS run is an explicit selection: it never reads, moves or deletes the cursor.
  // A closed fund leaves the run here, before the cursor and the MAX_FETCHES budget: never fetched, guarded or reported.
  const filtered = withoutClosedFunds(lineup.filter((fund) => passesFilters(fund, config)), (fund) => fund.ticker, CLOSED_FUNDS);
  const useCursor = config.tickers.length === 0;
  // A cursor left by an interrupted (deadline) run resumes there; a finished pass clears it.
  const cursor = useCursor ? await readCursor() : null;
  const cursorAt = cursor ? filtered.findIndex((fund) => fund.ticker === cursor) : -1;
  const ordered = cursorAt >= 0 ? filtered.slice(cursorAt + 1).concat(filtered.slice(0, cursorAt + 1)) : filtered;
  const candidates = config.maxFetches > 0 ? ordered.slice(0, config.maxFetches) : ordered;
  if (cursor && cursorAt < 0) console.log(`Cursor ${cursor} is not in the filtered set; starting from the top.`);
  else if (cursor) console.log(`Resuming after cursor ${cursor}.`);

  outputPrintFilter(candidates.length, lineup.length, outputHasOutputFilters(config));
  const output = outputCreateReporter(API_ROOT, candidates.length);

  const byTicker = new Map<string, CatalogEntry>();
  const queue = candidates.slice();
  const attempted: string[] = [];
  const laneCount = Math.max(1, config.concurrency);
  lastRequestAtLanes = new Array(laneCount).fill(0);
  let deadlineHit = false;
  const workers = Array.from({ length: laneCount }, async () => {
    for (;;) {
      if (Date.now() > deadlineAt) { deadlineHit = true; return; }
      const fund = queue.shift();
      if (!fund) return;
      attempted.push(fund.ticker);
      const before = await output.before(fund.ticker);
      try {
        const entry = await updateFund(fund, config, stats, previous[fund.ticker]);
        if (!entry) {
          await output.result(fund.ticker, before, 'skipped', 'yield/return filter');
          continue;
        }
        byTicker.set(fund.ticker, entry);
        await output.result(fund.ticker, before);
      } catch (error) {
        stats.failed += 1;
        await output.result(fund.ticker, before, 'failed', errorMessage(error));
      }
    }
  });
  await Promise.all(workers);
  if (deadlineHit) console.log(`Soft deadline reached after ${Math.round((Date.now() - startedAt) / 1000)}s: ${queue.length} fund(s) left for the next run.`);

  // Every published row stays (a bounded, filtered or failed run never drops a fund), fresh rows replace
  // their old ones, lineup funds without data get a placeholder row (dataFile null).
  const rows: Record<string, CatalogEntry> = {};
  for (const row of withoutStalePlaceholders(Object.values(previous), live)) rows[row.ticker] = row;
  for (const fund of lineup) if (!rows[fund.ticker]) rows[fund.ticker] = placeholderRow(fund);
  for (const [ticker, entry] of byTicker) rows[ticker] = entry;
  // A closed fund keeps its published row, marked closed (status, closedDate, closedSource).
  const funds = markClosedFunds(Object.values(rows).map((fund) => withMetricsContract(withDataFile(fund))).sort((a, b) => String(a.ticker).localeCompare(String(b.ticker))), CLOSED_FUNDS);
  const counts = {
    funds: funds.length,
    holdings: funds.reduce((sum, fund) => sum + Number(fund.holdings || 0), 0),
    history: funds.reduce((sum, fund) => sum + Number(fund.history || 0), 0),
  };
  const body = {
    source: {
      provider: 'Global X Investment Management LLC (Global X ETFs)',
      market: 'us',
      site: GLOBALX_SITE,
      catalog: GLOBALX_LINEUP_URL,
      catalogNote: 'ETF table rows of globalxetfs.com/explore (React Flight payload); category = first two hierarchy levels.',
      fundPages: `${GLOBALX_SITE}/funds/<ticker>/`,
      holdings: 'https://assets.globalxetfs.com/funds/holdings/<ticker>_full-holdings_<YYYYMMDD>.csv',
      holdingsNote: 'Official dated daily full-holdings CSV linked by the fund page.',
      history: 'Yahoo Finance public chart API (daily Close / Adj Close / Volume)',
      distributions: 'Global X fund page Distribution History calendar',
      nportRegistrant: `SEC EDGAR Form N-PORT-P, Global X Funds CIK ${GLOBALX_ETF_TRUST_CIK} (holdings fallback only)`,
      registrant: `Global X Funds (Investment Company Act file ${GLOBALX_ETF_TRUST_FILE_NUMBER})`,
      exchange: 'Global X fund page Fund Details "Primary Exchange", Yahoo Finance chart meta as fallback',
    },
    counts,
    funds,
  };
  // generatedAt moves only when content moved: an identical rerun is a zero-byte diff.
  const unchanged = previousIndex !== null && stableStringify({ source: previousIndex.source, counts: previousIndex.counts, funds: previousIndex.funds }) === stableStringify(body);
  if (!unchanged) await writeIfChanged(indexFile, stableStringify({ generatedAt: isoNow(), ...body }));
  // Q28: a fund is announced on its first successful publish (a catalog-only row is not published), new catalog-only rows as pending
  const newFunds = newFundsLines(newFundsReport(Object.values(previous), funds));
  for (const line of newFunds) console.log(line);
  if (newFunds.length && process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `### NEW FUNDS\n\n${newFunds.join('\n')}\n`, 'utf8');

  // Cursor bookkeeping: only a MAX_FETCHES run of the whole filter set moves it.
  const stateFile = path.join(API_ROOT, 'update-state.json');
  if (useCursor) {
    const reachedEnd = attempted.length >= ordered.length;
    const nextCursor = config.maxFetches > 0 && attempted.length && !reachedEnd ? attempted[attempted.length - 1] : null;
    if (nextCursor === null) {
      if (existsSync(stateFile)) await rm(stateFile);
    } else if (nextCursor !== cursor) {
      await writeIfChanged(stateFile, stableStringify({ cursor: nextCursor, savedAt: isoNow() }));
    }
  }

  console.log(output.summary(startedAt));
  console.log(outputCounts(counts.funds, counts.holdings, counts.history));
  if (attempted.length > 0 && stats.failed === attempted.length) {
    throw new Error(`every selected fund failed (${stats.failed} of ${attempted.length})`);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(errorMessage(error));
    process.exit(1);
  });
}

// <holdings-guard> shared block of .claude/tools/etfs/etf-std/holdings-guard.block.ts, applied by apply-holdings-guard.ts: never edit it in one repo
/**
 * Sanity check of a fund's new holdings before they replace the published ones. Returns why they must be rejected
 * (the caller then keeps the fund's previous state and reports it as failed), or null when they may be written.
 * An empty sheet passes only when nothing was published before. Otherwise a Name and a weight column (Weight,
 * Weight (%) or Market Weight) are required, >= 80% of the rows carry a numeric weight, the weights add up to
 * 50..150 and the sheet keeps >= 50% of the previously published rows. `relax` switches off the checks a fund
 * legitimately fails: 'numeric' and 'sum' (geared, inverse, futures, look-through, top-N lists) and 'count'. No relax lets
 * a sheet without a single numeric weight replace a published sheet that had numeric weights (`previousWeights`: how many
 * rows of the published sheet carry a numeric weight, see holdingsWeightCount; open-items etfs Q24).
 * Rows are arrays in header order or objects keyed by the header text. A fund in the brand's CLOSED_FUNDS never reaches the guard.
 */
export function holdingsGuard(headers: ReadonlyArray<string>, rows: ReadonlyArray<unknown>, previousRows: number | null | undefined, relax: ReadonlyArray<string> = [], previousWeights: number | null = null): string | null {
  const previous = Number(previousRows) > 0 ? Number(previousRows) : 0;
  if (!rows.length) return previous ? `no holdings rows (${previous} published)` : null;
  const names = headers.map((header) => String(header).trim().toLowerCase());
  const nameAt = names.indexOf('name');
  let weightAt = names.indexOf('weight');
  if (weightAt < 0) weightAt = names.indexOf('weight (%)');
  if (weightAt < 0) weightAt = names.indexOf('market weight');
  if (nameAt < 0 || weightAt < 0) return `no ${nameAt < 0 ? 'Name' : 'weight'} column (headers: ${headers.join(', ') || 'none'})`;
  const weights = holdingsGuardWeights(headers, rows, weightAt);
  const numeric = weights.count;
  const sum = weights.sum;
  if (numeric === 0 && Number(previousWeights) > 0) return `no row has a numeric weight, the published sheet had ${Number(previousWeights)}`;
  if (relax.indexOf('numeric') < 0 && numeric < rows.length * 0.8) return `only ${numeric} of ${rows.length} rows have a numeric weight`;
  if (relax.indexOf('sum') < 0 && (sum < 50 || sum > 150)) return `weights add up to ${sum.toFixed(2)}, outside 50..150`;
  if (relax.indexOf('count') < 0 && previous && rows.length < previous * 0.5) return `${rows.length} rows, less than half of the ${previous} published`;
  return null;
}

/** How many rows carry a numeric weight (Weight, Weight (%) or Market Weight column), 0 without such a column: pass it for the published sheet as holdingsGuard's previousWeights. */
export function holdingsWeightCount(headers: ReadonlyArray<string>, rows: ReadonlyArray<unknown>): number {
  const names = headers.map((header) => String(header).trim().toLowerCase());
  let weightAt = names.indexOf('weight');
  if (weightAt < 0) weightAt = names.indexOf('weight (%)');
  if (weightAt < 0) weightAt = names.indexOf('market weight');
  return weightAt < 0 ? 0 : holdingsGuardWeights(headers, rows, weightAt).count;
}

/** Count and sum of the numeric weights in column weightAt; rows are arrays in header order or objects keyed by the header text. */
function holdingsGuardWeights(headers: ReadonlyArray<string>, rows: ReadonlyArray<unknown>, weightAt: number): { count: number; sum: number } {
  let count = 0;
  let sum = 0;
  for (let i = 0; i < rows.length; i++) {
    const row: any = rows[i];
    const weight = holdingsGuardNumber(Array.isArray(row) ? row[weightAt] : row && typeof row === 'object' ? row[headers[weightAt]] : undefined);
    if (weight !== null) {
      count++;
      sum += weight;
    }
  }
  return { count, sum };
}

/** A weight cell as a number: %, $, commas and spaces are ignored, (x) is negative; null when it is no plain number (a zero-width character inside counts as broken). */
function holdingsGuardNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let text = String(value === null || value === undefined ? '' : value).replace(/[ \t ,%$]/g, '').replace(/−/g, '-');
  const negative = /^\(.*\)$/.test(text);
  if (negative) text = text.slice(1, -1);
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text)) return null;
  return negative ? -Number(text) : Number(text);
}

/** A fund its issuer closed (liquidated, delisted or merged away), confirmed from an official source: an SEC filing or the issuer's notice. */
export type ClosedFund = { ticker: string; closed: string; source: string };

/**
 * The brand's CLOSED_FUNDS entry for a ticker, or null. A closed fund is never fetched, never guarded and never reported failed: it keeps
 * its last published data and its index row carries `status: 'closed'`, `closedDate` and `closedSource`. A malformed entry throws, so a
 * typo (no ISO date, no https source) never ships.
 */
export function closedFund(list: ReadonlyArray<ClosedFund>, ticker: unknown): ClosedFund | null {
  const wanted = String(ticker === null || ticker === undefined ? '' : ticker).trim().toUpperCase();
  let found: ClosedFund | null = null;
  for (let i = 0; i < list.length; i++) {
    const fund = list[i];
    if (!/^[A-Z0-9][A-Z0-9.-]{0,9}$/.test(fund.ticker) || !/^\d{4}-\d{2}-\d{2}$/.test(fund.closed) || !/^https:\/\/\S+$/.test(fund.source)) throw new Error(`CLOSED_FUNDS: ${fund.ticker} needs an upper-case ticker, an ISO closing date and an https source`);
    if (fund.ticker === wanted) found = fund;
  }
  return found;
}

/** The index rows with every closed fund marked (`status: 'closed'`, `closedDate`, `closedSource`); other rows are returned as they are. */
export function markClosedFunds<T extends object>(rows: ReadonlyArray<T>, list: ReadonlyArray<ClosedFund>): T[] {
  return rows.map((row) => {
    const fund = closedFund(list, (row as { ticker?: unknown }).ticker);
    return fund ? ({ ...row, status: 'closed', closedDate: fund.closed, closedSource: fund.source } as T) : row;
  });
}

/** A run's queue without the closed funds, which are named once in the log: they are neither fetched nor counted as failed. */
export function withoutClosedFunds<T>(queue: ReadonlyArray<T>, tickerOf: (item: T) => string, list: ReadonlyArray<ClosedFund>): T[] {
  const closed: string[] = [];
  const open: T[] = [];
  for (let i = 0; i < queue.length; i++) {
    if (closedFund(list, tickerOf(queue[i]))) closed.push(tickerOf(queue[i]));
    else open.push(queue[i]);
  }
  if (closed.length) console.log(`[ closed   ] ${closed.join(', ')}: closed by the issuer, published data kept`);
  return open;
}
// </holdings-guard>

// <nport-reader> shared block of .claude/tools/etfs/etf-std/nport-reader.block.ts, applied by apply-block.ts: never edit it in one repo
/**
 * SEC EDGAR Form N-PORT-P holdings reader (open-items etfs ETF-H2), one copy for every brand. Pure functions plus one reader
 * that takes the brand's own `getText(url, label)` (its SEC User-Agent, timeout, retries and pacing). Rules it enforces:
 * - identifiers come from the position itself: `<cusip>` text (or a `value` attribute), `<isin value>`, `<ticker value>`,
 *   `<other value>`; a derivative's reference instrument (inside `<derivativeInfo>`) never lends its identifiers to the position
 * - CUSIP `000000000` and `N/A` are missing; a missing weight or value is null (an empty cell), never 0
 * - a ticker only for an equity row (assetCat EC or EP) traded in USD with a U.S. ISIN or none, and never one ticker on two
 *   different securities (`nportTickers`)
 * - identity: the filing must name the fund's own series id, or, with no series id known, the fund's name (`nportIdentity`)
 * - freshness: the report period must be strictly newer than the published holdings (`nportIsFresh`)
 * - filings come newest report period first from the registrant's own archive folder, never from the filer agent's CIK
 *   (the accession number prefix)
 */
export type NportPosition = {
  name: string;
  title: string;
  lei: string;
  cusip: string;
  isin: string;
  ticker: string;
  other: string;
  otherDesc: string;
  balance: number | null;
  units: string;
  currency: string;
  /** valUSD, null when the filing has none */
  value: number | null;
  /** pctVal: percent of net assets (0.5 = 0.5%), null when the filing has none */
  weight: number | null;
  payoff: string;
  assetCat: string;
  issuerCat: string;
  country: string;
  /** derivCat of the position's derivativeInfo (FUT, FWD, SWP, OPT, ...), empty for a security */
  derivative: string;
  /** debtSec annualizedRt and maturityDt (ISO), null and '' for a non-debt row */
  coupon: number | null;
  maturity: string;
};

export type NportFiling = {
  seriesId: string;
  seriesName: string;
  regName: string;
  regCik: string;
  /** report period end (genInfo repPdDate) as ISO, '' when missing */
  repPdDate: string;
  netAssets: number | null;
  totalAssets: number | null;
  positions: NportPosition[];
};

export type NportCandidate = { accession: string; filed: string; period: string; cik: string };
export type NportSeriesRef = { cik: string; seriesId: string; classId: string };

/** XML text: entities decoded, tags dropped, whitespace collapsed. */
function nportText(raw: string): string {
  return String(raw)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_m: string, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m: string, dec: string) => String.fromCharCode(Number(dec)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/[\s ]+/g, ' ')
    .trim();
}

/** Text of the first `<tag>` (any namespace prefix) in `xml`, '' when absent. */
function nportTag(xml: string, tag: string): string {
  const match = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?${tag}>`, 'i').exec(xml);
  return match ? nportText(match[1]) : '';
}

/** The `attribute` of the first `<tag ...>` (any namespace prefix) in `xml`, '' when absent. */
function nportAttr(xml: string, tag: string, attribute: string): string {
  const match = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${tag}\\s[^>]*?\\b${attribute}\\s*=\\s*"([^"]*)"`, 'i').exec(xml);
  return match ? nportText(match[1]) : '';
}

/** A plain decimal or exponent number, null for an empty, N/A or broken cell. */
function nportNumber(raw: string): number | null {
  const text = String(raw).replace(/[\s,]/g, '');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** An identifier code, '' for N/A, NONE and all zeros (CUSIP 000000000 means "no CUSIP"). */
function nportCode(raw: string): string {
  const text = String(raw).trim().toUpperCase();
  return !text || /^(N\/?A|NONE|-+|0+)$/.test(text) ? '' : text;
}

/** ISO date of an N-PORT date (YYYY-MM-DD, possibly with a time), '' otherwise. */
function nportIso(raw: unknown): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(raw === null || raw === undefined ? '' : raw).trim());
  return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
}

/** One N-PORT-P primary_doc.xml (or the full submission .txt that embeds it) as series facts and positions. */
export function parseNportFiling(xml: string): NportFiling {
  const text = String(xml === null || xml === undefined ? '' : xml);
  const genInfo = /<(?:[A-Za-z0-9_.-]+:)?genInfo\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?genInfo>/i.exec(text);
  const fundInfo = /<(?:[A-Za-z0-9_.-]+:)?fundInfo\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?fundInfo>/i.exec(text);
  const gen = genInfo ? genInfo[1] : '';
  const fund = fundInfo ? fundInfo[1].replace(/<(?:[A-Za-z0-9_.-]+:)?returnInfo\b[\s\S]*?<\/(?:[A-Za-z0-9_.-]+:)?returnInfo>/gi, ' ') : '';
  const positions: NportPosition[] = [];
  const blocks = /<(?:[A-Za-z0-9_.-]+:)?invstOrSec\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?invstOrSec>/gi;
  let block: RegExpExecArray | null;
  while ((block = blocks.exec(text)) !== null) {
    const raw = block[1];
    const derivativeInfo = /<(?:[A-Za-z0-9_.-]+:)?derivativeInfo\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?derivativeInfo>/i.exec(raw);
    // The reference instrument of a derivative (SPY for a SPY option, a bond for a CDS) is another security: drop it first.
    const own = raw.replace(/<(?:[A-Za-z0-9_.-]+:)?derivativeInfo\b[^>]*>[\s\S]*?<\/(?:[A-Za-z0-9_.-]+:)?derivativeInfo>/gi, ' ');
    const identifiers = /<(?:[A-Za-z0-9_.-]+:)?identifiers\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?identifiers>/i.exec(own);
    const ids = identifiers ? identifiers[1] : '';
    const debt = /<(?:[A-Za-z0-9_.-]+:)?debtSec\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?debtSec>/i.exec(own);
    const name = nportTag(own, 'name');
    positions.push({
      name: name && !/^N\/?A$/i.test(name) ? name : nportTag(own, 'title'),
      title: nportTag(own, 'title'),
      lei: nportCode(nportTag(own, 'lei')),
      cusip: nportCode(nportTag(own, 'cusip') || nportAttr(ids, 'cusip', 'value')),
      isin: nportCode(nportAttr(ids, 'isin', 'value')),
      ticker: nportCode(nportAttr(ids, 'ticker', 'value')),
      other: nportCode(nportAttr(ids, 'other', 'value')),
      otherDesc: nportAttr(ids, 'other', 'otherDesc'),
      balance: nportNumber(nportTag(own, 'balance')),
      units: nportTag(own, 'units'),
      currency: (nportTag(own, 'curCd') || nportAttr(own, 'currencyConditional', 'curCd')).toUpperCase(),
      value: nportNumber(nportTag(own, 'valUSD')),
      weight: nportNumber(nportTag(own, 'pctVal')),
      payoff: nportTag(own, 'payoffProfile'),
      assetCat: (nportTag(own, 'assetCat') || nportAttr(own, 'assetConditional', 'assetCat')).toUpperCase(),
      issuerCat: (nportTag(own, 'issuerCat') || nportAttr(own, 'issuerConditional', 'issuerCat')).toUpperCase(),
      country: nportTag(own, 'invCountry').toUpperCase(),
      derivative: derivativeInfo ? (/\bderivCat\s*=\s*"([^"]*)"/i.exec(derivativeInfo[1]) || ['', 'OTHER'])[1].toUpperCase() : '',
      coupon: debt ? nportNumber(nportTag(debt[1], 'annualizedRt')) : null,
      maturity: debt ? nportIso(nportTag(debt[1], 'maturityDt')) : '',
    });
  }
  return {
    seriesId: nportTag(gen, 'seriesId').toUpperCase(),
    seriesName: nportTag(gen, 'seriesName'),
    regName: nportTag(gen, 'regName'),
    regCik: nportTag(gen, 'regCik').replace(/\D/g, ''),
    repPdDate: nportIso(nportTag(gen, 'repPdDate')),
    netAssets: nportNumber(nportTag(fund, 'netAssets')),
    totalAssets: nportNumber(nportTag(fund, 'totAssets')),
    positions,
  };
}

/** A number as sheet text: '' for null, no exponent, at most `digits` decimals (trailing zeros dropped). */
export function nportCell(value: number | null, digits = 8): string {
  if (value === null || !Number.isFinite(value)) return '';
  const text = value.toFixed(digits);
  return text.indexOf('.') < 0 ? text : text.replace(/0+$/, '').replace(/\.$/, '');
}

/** The position's own identifier for a sheet: CUSIP, else ISIN, else the "other" code (a Bloomberg or internal id), else ''. */
export function nportIdentifier(position: NportPosition): string {
  return position.cusip || position.isin || position.other;
}

/**
 * A company name as a lookup key: upper case, punctuation and legal suffixes dropped, `CLASS A` -> `CL A`. Dotted
 * abbreviations collapse like the undotted forms (`N.V.` = `NV`, `S.p.A.` = `SPA`, `A/S` = `A S` = `AS`, `S.A.B. de C.V.` = `SAB DE CV`)
 * and `PUBLIC LIMITED COMPANY` is `plc`, so both spellings of one issuer give one key.
 */
export function nportNameKey(value: unknown): string {
  // EDGAR adds a state or qualifier suffix to company titles ("COSTCO WHOLESALE CORP /NEW", "BANK OF AMERICA CORP /DE/"): drop a trailing one
  const raw = String(value === null || value === undefined ? '' : value).replace(/(?:\s*\/\s*[A-Za-z]{2,3}\s*\/?)+\s*$/, '')
    .replace(/\b[A-Za-z](?:\.[A-Za-z])+\.?(?![A-Za-z])/g, (dotted) => dotted.replace(/\./g, ''))
    .replace(/\bA\/S\b/gi, 'AS');
  let text = nportText(raw).toUpperCase().replace(/['’]/g, '').replace(/&/g, ' AND ').replace(/[^A-Z0-9]+/g, ' ');
  text = text.replace(/ A S ?$/, ' AS').replace(/\bPUBLIC (?:(?:LIMITED|LTD)(?: (?:COMP[A-Z]*|CO))?|(?:COMPANY|CO) (?:LIMITED|LTD))\b/g, 'PLC').replace(/\b(?:S DE RL )?DE CV\b/g, ' ');
  text = text.replace(/\bCLASS\s+([A-Z])\b/g, 'CL $1').replace(/\bCL\s+([A-Z])\b/g, 'CL $1');
  const share = /\bCL [A-Z]\b/.exec(text);
  text = text.replace(/\b(THE|INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|PLC|SA|SAB|NV|AG|SE|SPA|AS|ASA|ORDINARY|COMMON|STOCK|SHS|SHARES|ADR|DEPOSITARY|RECEIPT|USD|US|REG|REGISTERED)\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (share && !/\bCL [A-Z]\b/.test(text)) text = `${text} ${share[0]}`;
  return text;
}

/** SEC company_tickers.json -> name key -> ticker (the first, largest company wins a shared key; the class-less key is added too). */
export function parseSecCompanyNames(payload: unknown): Map<string, string> {
  const names = new Map<string, string>();
  const rows = payload && typeof payload === 'object' ? Object.keys(payload as object).map((key) => (payload as Record<string, unknown>)[key]) : [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as { ticker?: unknown; title?: unknown } | null;
    if (!row || typeof row !== 'object') continue;
    const ticker = String(row.ticker === null || row.ticker === undefined ? '' : row.ticker).trim().toUpperCase();
    const key = nportNameKey(row.title);
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker) || !key) continue;
    if (!names.has(key)) names.set(key, ticker);
    const core = key.replace(/ CL [A-Z]$/, '');
    if (core && !names.has(core)) names.set(core, ticker);
  }
  return names;
}

/** SEC company_tickers_mf.json -> fund ticker -> registrant CIK (10 digits), series id, class id. */
export function parseSecFundTickers(payload: unknown): Map<string, NportSeriesRef> {
  const map = new Map<string, NportSeriesRef>();
  const record = (payload && typeof payload === 'object' ? payload : {}) as { fields?: unknown; data?: unknown };
  const fields = Array.isArray(record.fields) ? record.fields.map(String) : [];
  const rows = Array.isArray(record.data) ? record.data : [];
  const at = (row: unknown[], field: string): string => (fields.indexOf(field) < 0 ? '' : String(row[fields.indexOf(field)] === null || row[fields.indexOf(field)] === undefined ? '' : row[fields.indexOf(field)]).trim());
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;
    const ticker = at(row, 'symbol').toUpperCase();
    const cik = at(row, 'cik').replace(/\D/g, '');
    const seriesId = at(row, 'seriesId').toUpperCase();
    if (!ticker || !Number(cik) || !/^S\d{9}$/.test(seriesId) || map.has(ticker)) continue;
    map.set(ticker, { cik: `0000000000${Number(cik)}`.slice(-10), seriesId, classId: at(row, 'classId').toUpperCase() });
  }
  return map;
}

/**
 * Exchange tickers for the positions, in their order ('' for none). A ticker is given only to an equity row (assetCat EC or
 * EP) traded in USD (or with no currency) whose ISIN is U.S. or missing: first the filer's own `<ticker value>`, else the
 * SEC issuer-name table (`names`) when the row has a CUSIP or a U.S. ISIN. A ticker that lands on two different securities
 * (Alphabet A and C, an ordinary share and its ADR) is dropped from the name-matched rows; when the filer itself gave it
 * to two securities it is dropped from all of them. Bonds, cash, funds and derivatives stay identifier-keyed.
 */
export function nportTickers(positions: ReadonlyArray<NportPosition>, names: Map<string, string> | null = null): string[] {
  const fromFiler: boolean[] = [];
  const tickers = positions.map((position, index) => {
    fromFiler[index] = false;
    const equity = (position.assetCat === 'EC' || position.assetCat === 'EP') && !position.derivative;
    const usd = !position.currency || position.currency === 'USD';
    if (!equity || !usd || (position.isin && position.isin.slice(0, 2) !== 'US')) return '';
    if (/^[A-Z][A-Z0-9.-]{0,9}$/.test(position.ticker)) {
      fromFiler[index] = true;
      return position.ticker;
    }
    if (!names || !(/^[0-9A-Z]{9}$/.test(position.cusip) || /^US[0-9A-Z]{10}$/.test(position.isin))) return '';
    const key = nportNameKey(position.name);
    return names.get(key) || names.get(key.replace(/ CL [A-Z]$/, '')) || '';
  });
  const securities = new Map<string, { keys: string[]; filer: string[] }>();
  tickers.forEach((ticker, index) => {
    if (!ticker) return;
    const position = positions[index];
    const key = position.cusip || position.isin || position.other || nportNameKey(position.name);
    const seen = securities.get(ticker) || { keys: [], filer: [] };
    if (seen.keys.indexOf(key) < 0) seen.keys.push(key);
    if (fromFiler[index] && seen.filer.indexOf(key) < 0) seen.filer.push(key);
    securities.set(ticker, seen);
  });
  return tickers.map((ticker, index) => {
    const seen = ticker ? securities.get(ticker) : undefined;
    if (!seen || seen.keys.length < 2) return ticker;
    return seen.filer.length === 1 && fromFiler[index] ? ticker : '';
  });
}

/** The browse-edgar Atom feed of one series' NPORT-P filings. */
export function nportSeriesFeedUrl(seriesId: string, count = 10): string {
  return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(String(seriesId).toUpperCase())}&type=NPORT-P&dateb=&owner=include&count=${count}&output=atom`;
}

/** The registrant's submissions JSON (report periods of its recent filings). */
export function nportSubmissionsUrl(cik: string): string {
  return `https://data.sec.gov/submissions/CIK${`0000000000${Number(String(cik).replace(/\D/g, '')) || 0}`.slice(-10)}.json`;
}

/** primary_doc.xml of a filing in the registrant's own folder. Throws without a registrant CIK: the accession prefix is the filer agent. */
export function nportDocumentUrl(registrantCik: string, accession: string): string {
  const cik = Number(String(registrantCik).replace(/\D/g, ''));
  if (!cik) throw new Error(`N-PORT ${accession}: no registrant CIK (the accession prefix is the filer agent, never used as the folder)`);
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${String(accession).replace(/-/g, '')}/primary_doc.xml`;
}

/** NPORT-P entries of a browse-edgar Atom feed (amendments and other forms skipped), with the registrant CIK of the filing link. */
export function parseNportFeed(atom: string): NportCandidate[] {
  const out: NportCandidate[] = [];
  const entries = /<entry>([\s\S]*?)<\/entry>/gi;
  let entry: RegExpExecArray | null;
  while ((entry = entries.exec(String(atom === null || atom === undefined ? '' : atom))) !== null) {
    const body = entry[1];
    const form = (nportTag(body, 'filing-type') || nportAttr(body, 'category', 'term')).toUpperCase();
    const accession = nportTag(body, 'accession-number');
    if (form !== 'NPORT-P' || !/^\d{10}-\d{2}-\d{6}$/.test(accession)) continue;
    const folder = /\/Archives\/edgar\/data\/(\d+)\//i.exec(nportTag(body, 'filing-href'));
    out.push({ accession, filed: nportIso(nportTag(body, 'filing-date')), period: nportIso(nportTag(body, 'period')), cik: folder ? folder[1] : '' });
  }
  return out;
}

/** NPORT-P filings of a registrant's submissions JSON (`filings.recent`), with report periods; the registrant is the JSON's own CIK. */
export function parseNportSubmissions(payload: unknown): NportCandidate[] {
  const record = (payload && typeof payload === 'object' ? payload : {}) as { cik?: unknown; filings?: { recent?: Record<string, unknown> } };
  const recent = record.filings && record.filings.recent ? record.filings.recent : {};
  const column = (name: string): unknown[] => (Array.isArray(recent[name]) ? (recent[name] as unknown[]) : []);
  const forms = column('form'), accessions = column('accessionNumber'), filed = column('filingDate'), periods = column('reportDate');
  const cik = String(record.cik === null || record.cik === undefined ? '' : record.cik).replace(/\D/g, '');
  const out: NportCandidate[] = [];
  for (let i = 0; i < forms.length; i++) {
    const accession = String(accessions[i] === null || accessions[i] === undefined ? '' : accessions[i]);
    if (String(forms[i]).toUpperCase() !== 'NPORT-P' || !/^\d{10}-\d{2}-\d{6}$/.test(accession)) continue;
    out.push({ accession, filed: nportIso(filed[i]), period: nportIso(periods[i]), cik });
  }
  return out;
}

/**
 * Candidates newest report period first, then newest filing: a late filing for an older period never wins. A missing
 * period is taken from `known` (the registrant's submissions) by accession; candidates still without one go last.
 */
export function nportNewestFirst(candidates: ReadonlyArray<NportCandidate>, known: ReadonlyArray<NportCandidate> = []): NportCandidate[] {
  const periods = new Map<string, string>();
  for (let i = 0; i < known.length; i++) if (known[i].period) periods.set(known[i].accession, known[i].period);
  return candidates
    .map((candidate) => (candidate.period ? candidate : { ...candidate, period: periods.get(candidate.accession) || '' }))
    .sort((a, b) => (a.period && b.period ? b.period.localeCompare(a.period) : a.period ? -1 : b.period ? 1 : 0) || b.filed.localeCompare(a.filed));
}

/**
 * Does the filing belong to the fund? With a series id: only the same series id. Without one: the normalized series name
 * equals the fund name, or (`loose`, reported to the caller) one contains the other. Returns the problem, or null.
 */
export function nportIdentity(filing: Pick<NportFiling, 'seriesId' | 'seriesName'>, fund: { seriesId?: string | null; name?: string | null }): { problem: string | null; loose: boolean } {
  const wantedSeries = String(fund.seriesId || '').trim().toUpperCase();
  if (wantedSeries) return { problem: filing.seriesId === wantedSeries ? null : `names series ${filing.seriesId || 'none'}, not ${wantedSeries}`, loose: false };
  const filed = nportNameKey(filing.seriesName), wanted = nportNameKey(fund.name);
  if (!filed || !wanted) return { problem: 'no series id and no fund name to match', loose: false };
  if (filed === wanted) return { problem: null, loose: false };
  if (filed.indexOf(wanted) >= 0 || wanted.indexOf(filed) >= 0) return { problem: null, loose: true };
  return { problem: `names series "${filing.seriesName}", not "${String(fund.name)}"`, loose: false };
}

/**
 * May a filing replace the published holdings? Nothing published (no rows): any dated or undated report. Otherwise only a
 * report period strictly newer than the published holdings date; both must be ISO dates (convert the brand's display
 * date first), an unknown date on either side keeps the published sheet.
 */
export function nportIsFresh(repPdDate: unknown, publishedAsOf: unknown, publishedRows: unknown): boolean {
  if (!(Number(publishedRows) > 0)) return true;
  const report = nportIso(repPdDate), published = nportIso(publishedAsOf);
  return Boolean(report && published && String(publishedAsOf).trim().length === 10 && report > published);
}

export type NportRead = { filing: NportFiling; candidate: NportCandidate; url: string; loose: boolean } | { problem: string };

/**
 * The newest N-PORT-P filing of one fund, or why there is none. Candidates: the series' Atom feed (when a series id is known;
 * an empty feed means no filing yet) with periods from the registrant's submissions, else (no series id, or the feed failed)
 * the registrant's NPORT-P filings themselves; newest period first.
 * Documents are read until one passes the identity check (at most `maxDocuments`); that newest own filing is returned only
 * when it is fresh against the published holdings (`published.asOf` ISO, `published.rows`). Errors of the optional
 * submissions request are tolerated; others come back as `problem`. `cache` (one Map per run) keeps the submissions and
 * the parsed documents, so funds of one registrant share requests.
 */
export async function readNportHoldings(
  fund: { ticker: string; cik: string; seriesId?: string | null; name?: string | null },
  published: { asOf?: unknown; rows?: unknown },
  getText: (url: string, label: string) => Promise<string>,
  options: { maxDocuments?: number; cache?: Map<string, unknown> } = {},
): Promise<NportRead> {
  const cache = options.cache || new Map<string, unknown>();
  const once = async <T>(key: string, load: () => Promise<T>): Promise<T> => {
    if (!cache.has(key)) cache.set(key, load().catch((error: unknown) => { cache.delete(key); throw error; }));
    return (await cache.get(key)) as T;
  };
  const cik = String(fund.cik || '').replace(/\D/g, '');
  if (!Number(cik)) return { problem: `${fund.ticker}: no registrant CIK` };
  let known: NportCandidate[] = [];
  try {
    known = await once(`submissions:${Number(cik)}`, async () => parseNportSubmissions(JSON.parse(await getText(nportSubmissionsUrl(cik), `${fund.ticker} N-PORT periods`))));
  } catch {
    known = [];
  }
  // null: no series feed (no series id, or the feed failed), so the registrant's own NPORT-P filings are scanned instead
  let candidates: NportCandidate[] | null = null;
  try {
    if (fund.seriesId) candidates = parseNportFeed(await getText(nportSeriesFeedUrl(fund.seriesId), `${fund.ticker} N-PORT filings`));
  } catch (error) {
    if (!known.length) return { problem: `${fund.ticker}: N-PORT filings unavailable (${error instanceof Error ? error.message : String(error)})` };
  }
  const sorted = nportNewestFirst(candidates || known, known);
  if (!sorted.length) return { problem: `${fund.ticker}: no NPORT-P filing yet` };
  const limit = Math.max(1, options.maxDocuments || (candidates ? 3 : 12));
  const misses: string[] = [];
  for (let i = 0; i < sorted.length && i < limit; i++) {
    const candidate = sorted[i];
    const url = nportDocumentUrl(Number(candidate.cik) ? candidate.cik : cik, candidate.accession);
    let filing: NportFiling;
    try {
      filing = await once(`document:${url}`, async () => parseNportFiling(await getText(url, `${fund.ticker} N-PORT ${candidate.accession}`)));
    } catch (error) {
      misses.push(`${candidate.accession} unreadable (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    const identity = nportIdentity(filing, fund);
    if (identity.problem) {
      misses.push(`${candidate.accession} ${identity.problem}`);
      continue;
    }
    if (!filing.positions.length) return { problem: `${fund.ticker}: ${candidate.accession} has no positions` };
    if (!nportIsFresh(filing.repPdDate, published.asOf, published.rows)) return { problem: `${fund.ticker}: N-PORT ${filing.repPdDate || 'undated'} is not newer than the published holdings (${String(published.asOf || 'undated')})` };
    return { filing, candidate, url, loose: identity.loose };
  }
  return { problem: `${fund.ticker}: no N-PORT-P filing of its own${misses.length ? `: ${misses.join('; ')}` : ''}` };
}
// </nport-reader>

// <calendar-dates> shared block of .claude/tools/etfs/etf-std/calendar-dates.block.ts, applied by apply-block.ts: never edit it in one repo
/**
 * A calendar date as ISO `YYYY-MM-DD`, or null. Pure text work, never `Date.parse` or local getters, so a run in Tokyo
 * publishes the same day as CI (open-items etfs ETF-H4). Accepts ISO (`2026-10-24`, with a time the date part is kept as
 * written), `2026/10/24`, U.S. `10/24/2026` and `10-24-26` (two-digit years up to 69 are 20xx), month names in either order
 * (`Oct 24, 2026`, `October 24 2026`, `Sept. 30, 2026`, `24 Oct 2026`, `24-Oct-26`), an optional weekday or `as of` in front.
 * A day that does not exist (`02/30/2026`) is null.
 */
export function calendarIso(value: unknown): string | null {
  const text = String(value === null || value === undefined ? '' : value).replace(/[\s ]+/g, ' ').trim()
    .replace(/^as of:? /i, '').replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,? /i, '');
  const year = (raw: string): number => (raw.length === 2 ? (Number(raw) <= 69 ? 2000 : 1900) + Number(raw) : Number(raw));
  const month = (raw: string): number => {
    const word = raw.toLowerCase();
    const names = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    for (let i = 0; i < names.length; i++) if (word.length >= 3 && names[i].indexOf(word) === 0) return i + 1;
    return 0;
  };
  let y = 0, m = 0, d = 0, match: RegExpExecArray | null;
  if ((match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(text)) || (match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(text))) {
    y = Number(match[1]); m = Number(match[2]); d = Number(match[3]);
  } else if ((match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})$/.exec(text))) {
    y = year(match[3]); m = Number(match[1]); d = Number(match[2]);
  } else if ((match = /^([A-Za-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/.exec(text))) {
    y = Number(match[3]); m = month(match[1]); d = Number(match[2]);
  } else if ((match = /^(\d{1,2})(?:st|nd|rd|th)?[ -]([A-Za-z]{3,9})\.?,?[ -](\d{4}|\d{2})$/.exec(text))) {
    y = year(match[3]); m = month(match[2]); d = Number(match[1]);
  } else {
    return null;
  }
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (y < 1900 || y > 2999 || m < 1 || m > 12 || d < 1 || d > days[m - 1]) return null;
  return `${y}-${m < 10 ? '0' : ''}${m}-${d < 10 ? '0' : ''}${d}`;
}

/**
 * Is the fund at least `years` old on `asOf`? Calendar anniversary, inclusive: a fund started 2025-10-24 is one year old on
 * 2026-10-24 (a 29 February start on 1 March). Unknown or unreadable dates answer true, so a value is never dropped for want
 * of a date. The shared "younger than one year" rule: since-inception returns are annualized only from one year on.
 */
export function fundAgeAtLeast(inception: unknown, asOf: unknown, years: number): boolean {
  const start = calendarIso(inception), end = calendarIso(asOf);
  if (!start || !end) return true;
  return end >= `${Number(start.slice(0, 4)) + years}${start.slice(4)}`;
}

/**
 * The returns with every horizon the fund is too young for set to null: `horizons` maps a key of `returns` to the years it
 * needs (`{ yr1: 1, cagr3y: 3, siAnn: 1 }`). Keys that are absent or already null stay as they are; the object is copied.
 */
export function withoutYoungReturns<T extends object>(returns: T, inception: unknown, asOf: unknown, horizons: Record<string, number>): T {
  const out: Record<string, unknown> = { ...(returns as Record<string, unknown>) };
  const keys = Object.keys(horizons);
  for (let i = 0; i < keys.length; i++) {
    if (out[keys[i]] !== undefined && out[keys[i]] !== null && !fundAgeAtLeast(inception, asOf, horizons[keys[i]])) out[keys[i]] = null;
  }
  return out as T;
}
// </calendar-dates>

// <windowed-chart> shared block of .claude/tools/etfs/etf-std/windowed-chart.block.ts, applied by apply-block.ts: never edit it in one repo
export type WindowedChartDay = { date: string; close: number; adjClose: number; volume: number; adjCloseRaw?: number };
export type WindowedChartDividend = { epoch: number; amount: number };

/**
 * A HISTORY_RANGE window (`period1` N years back) never shrinks the published history, and with it the 3y, 5y, 10y and
 * since-inception returns (open-items etfs Q25; was a byte-identical copy in Fidelity, Invesco and JPMorgan). The published
 * rows older than the first fresh day are put in front of the fresh days; their Adj Close is rescaled by the ratio measured on
 * the overlapping days (Yahoo re-adjusts the whole series after each distribution). Published distributions older than the
 * window are kept as well. Returns the chart unchanged when nothing published is older, and null when the window cannot be
 * joined safely (no overlap, Close changed, inconsistent or implausible ratio): the caller then keeps the fund as published.
 * `published` rows carry `Date` (any calendarIso form), `Close`, `Adj Close`, `Volume`; distribution rows are
 * [date, amount, ...] arrays. The chart's days must be sorted by ISO date.
 */
export function mergeWindowedChart<C extends { days: WindowedChartDay[]; dividends: WindowedChartDividend[] }>(chart: C, published: ReadonlyArray<Record<string, unknown>>, publishedDistributions: ReadonlyArray<unknown> = []): C | null {
  if (!chart.days.length || !published.length) return chart;
  const num = (value: unknown): number | null => {
    const text = String(value === null || value === undefined ? '' : value).replace(/[\s,$]/g, '');
    return text && Number.isFinite(Number(text)) ? Number(text) : null;
  };
  const firstFresh = chart.days[0].date;
  const rows: Array<{ date: string; close: number; adjClose: number; volume: number }> = [];
  for (let i = 0; i < published.length; i++) {
    const date = calendarIso(published[i].Date), close = num(published[i].Close), adjClose = num(published[i]['Adj Close']);
    if (date && close !== null && adjClose !== null && adjClose > 0) rows.push({ date, close, adjClose, volume: num(published[i].Volume) || 0 });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const older = rows.filter((row) => row.date < firstFresh);
  if (!older.length) return chart;
  const byDate = new Map<string, { close: number; adjClose: number }>();
  for (let i = 0; i < rows.length; i++) byDate.set(rows[i].date, rows[i]);
  const adjRatios: number[] = [];
  const closeRatios: number[] = [];
  for (let i = 0; i < chart.days.length; i++) {
    const day = chart.days[i];
    const prior = byDate.get(day.date);
    if (!prior) continue;
    adjRatios.push((day.adjCloseRaw === undefined ? day.adjClose : day.adjCloseRaw) / prior.adjClose);
    if (prior.close > 0) closeRatios.push(day.close / prior.close);
  }
  if (!adjRatios.length) return null;
  const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
  if (closeRatios.length && Math.abs(mean(closeRatios) - 1) > 1e-3) return null;
  if (Math.max.apply(null, adjRatios) / Math.min.apply(null, adjRatios) - 1 > 5e-3) return null;
  const measured = mean(adjRatios);
  if (measured < 0.5 || measured > 1.001) return null;
  const factor = Math.abs(measured - 1) < 1e-4 ? 1 : measured;
  const days: WindowedChartDay[] = older.map((row) => {
    const raw = row.adjClose * factor;
    return { date: row.date, close: row.close, adjClose: factor === 1 ? row.adjClose : Math.round(raw * 100) / 100, volume: row.volume, adjCloseRaw: raw };
  });
  const firstFreshEpoch = Date.UTC(Number(firstFresh.slice(0, 4)), Number(firstFresh.slice(5, 7)) - 1, Number(firstFresh.slice(8, 10))) / 1000;
  const kept: WindowedChartDividend[] = [];
  for (let i = 0; i < publishedDistributions.length; i++) {
    const cells = publishedDistributions[i];
    const date = Array.isArray(cells) ? calendarIso(cells[0]) : null;
    const amount = Array.isArray(cells) ? num(cells[1]) : null;
    if (!date || amount === null || amount <= 0) continue;
    const epoch = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / 1000;
    if (epoch < firstFreshEpoch) kept.push({ epoch, amount });
  }
  kept.sort((a, b) => a.epoch - b.epoch);
  return { ...chart, days: days.concat(chart.days), dividends: kept.concat(chart.dividends.filter((dividend) => dividend.epoch >= firstFreshEpoch)) };
}
// </windowed-chart>

// <fund-selection> shared block of .claude/tools/etfs/etf-std/fund-selection.block.ts, applied by apply-block.ts: never edit it in one repo
/** An index row as far as these helpers read it: the ticker and whether it has published data (`dataFile`, null for a catalog-only row). */
export type FundSelectionRow = { ticker?: unknown; dataFile?: unknown };

function fundSelectionTicker(row: FundSelectionRow): string {
  return String(row.ticker === null || row.ticker === undefined ? '' : row.ticker).trim().toUpperCase();
}

/**
 * The tickers a TICKERS entry may name: the live catalog plus every fund with published data (closed funds included). When
 * the live catalog could not be read (`live` null) every previous index row counts, since nothing tells a real catalog-only
 * row from a stale one. A catalog-only row from an earlier mistyped TICKERS run is therefore not "known" (open-items etfs Q27).
 */
export function knownTickers(live: ReadonlyArray<string> | null, previous: ReadonlyArray<FundSelectionRow>): string[] {
  const out: string[] = [];
  const add = (ticker: string): void => { if (ticker && out.indexOf(ticker) < 0) out.push(ticker); };
  if (live) for (let i = 0; i < live.length; i++) add(String(live[i]).trim().toUpperCase());
  for (let i = 0; i < previous.length; i++) if (!live || previous[i].dataFile) add(fundSelectionTicker(previous[i]));
  return out;
}

/** Throws before any fund request when TICKERS names a fund outside `known` (see knownTickers): a clear error, nothing fetched or written. */
export function assertKnownTickers(selected: ReadonlyArray<string> | null, known: ReadonlyArray<string>, where: string): void {
  const unknown = (selected || []).map((ticker) => String(ticker).trim().toUpperCase()).filter((ticker) => ticker && known.indexOf(ticker) < 0);
  if (unknown.length) throw new Error(`TICKERS: ${unknown.join(', ')} not in ${where}; nothing was fetched or written`);
}

/**
 * The index rows without stale catalog-only rows: a row with no published data whose ticker the live catalog no longer lists
 * (an earlier mistyped TICKERS entry, a fund withdrawn before launch). Rows with data always stay; nothing is dropped when the
 * live catalog could not be read (`live` null).
 */
export function withoutStalePlaceholders<T extends FundSelectionRow>(rows: ReadonlyArray<T>, live: ReadonlyArray<string> | null): T[] {
  if (!live) return rows.slice();
  const listed = live.map((ticker) => String(ticker).trim().toUpperCase());
  return rows.filter((row) => Boolean(row.dataFile) || listed.indexOf(fundSelectionTicker(row)) >= 0);
}

/**
 * New funds of a run (open-items etfs Q28): `published` - first published in this run (the previous index had no row for it,
 * or only a catalog-only one), so a fund whose first read failed is announced when it finally succeeds; `pending` - new in the
 * catalog this run but not published yet. Nothing is reported on a first run (empty previous index).
 */
export function newFundsReport(previous: ReadonlyArray<FundSelectionRow>, next: ReadonlyArray<FundSelectionRow>): { published: string[]; pending: string[] } {
  const report = { published: [] as string[], pending: [] as string[] };
  if (!previous.length) return report;
  const before = new Map<string, boolean>();
  for (let i = 0; i < previous.length; i++) before.set(fundSelectionTicker(previous[i]), Boolean(previous[i].dataFile));
  for (let i = 0; i < next.length; i++) {
    const ticker = fundSelectionTicker(next[i]);
    if (!ticker || before.get(ticker)) continue;
    if (next[i].dataFile) report.published.push(ticker);
    else if (!before.has(ticker)) report.pending.push(ticker);
  }
  report.published.sort();
  report.pending.sort();
  return report;
}

/** The log and step-summary lines of a newFundsReport: `NEW FUNDS: A, B` and `NEW FUNDS (not published yet): C`; none when empty. */
export function newFundsLines(report: { published: ReadonlyArray<string>; pending: ReadonlyArray<string> }): string[] {
  const lines: string[] = [];
  if (report.published.length) lines.push(`NEW FUNDS: ${report.published.join(', ')}`);
  if (report.pending.length) lines.push(`NEW FUNDS (not published yet): ${report.pending.join(', ')}`);
  return lines;
}
// </fund-selection>
