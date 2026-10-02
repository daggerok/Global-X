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
    skipGlobalX: 'SKIP_GLOBALX',
  };
  const range = (v: any): string => v?.source ?? `${Number.isFinite(v?.min) ? v.min : ''}:${Number.isFinite(v?.max) ? v.max : ''}`;
  for (const [key, value] of Object.entries(config)) {
    const name = aliases[key] ?? key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
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
function outputPrintConfig(brand: string, config: Record<string, any>): void {
  const entries: [string, string][] = [...outputConfigEntries(config), ['VERBOSE', String(outputVerbose())]];
  console.log(`[ config   ] ${brand} updater:\n${entries.map(([key, value]) => `              ${key}=${/TOKEN|PASSWORD|SECRET|COOKIE|SEC_UA/i.test(key) ? '<redacted>' : outputClean(value)}`).join('\n')}`);
}
function outputHasOutputFilters(config: Record<string, any>): boolean {
  return outputConfigEntries(config).some(([name, value]) =>
    /^(TICKERS|CATEGORY|AUM|TER|DIVIDEND_YIELD|SEC_YIELD|PERFORMANCE_|TOTAL_RETURN_)/.test(name) &&
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
function outputMoney(value: any): string {
  const raw = outputScalar(value);
  if (raw === null || raw === undefined || raw === '—' || raw === '--') return 'null';
  const text = String(raw).replace(/[$,\s]/g, '');
  const match = text.match(/^([+-]?[\d.]+)([KMBT])?$/i);
  if (!match) return outputClean(raw);
  const number = Number(match[1]) * ({ K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[match[2]?.toUpperCase() as 'K' | 'M' | 'B' | 'T'] ?? 1);
  if (!Number.isFinite(number)) return 'null';
  for (const [unit, scale] of [['T', 1e12], ['B', 1e9], ['M', 1e6], ['K', 1e3]] as const) {
    if (Math.abs(number) >= scale) return `$${(number / scale).toFixed(1)}${unit}`;
  }
  return `$${number.toFixed(2)}`;
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
    field('div', outputScalar(data.trailingYield ?? data.yields?.effectiveYield ?? data.yields?.dividendYield ?? data.dividendYield ?? metrics.dividendYield)),
    field('sec', outputScalar(data.secYield ?? data.yields?.secYield ?? metrics.secYield)),
    field('wp', data.workplaceRaw),
  ].filter(part => part !== '').join(' ');
  return `[ ${String(index).padStart(width)}/${String(total).padEnd(width)}  ] ${outputClean(ticker).padEnd(5)} ${status.padEnd(9)}${detail ? ` ${detail}` : ''}${reason ? ` reason=${outputClean(reason)}` : ''}`;
}
function outputCreateReporter(root: URL | string, total: number) {
  let completed = 0;
  return {
    before: (ticker: string) => outputInspectFund(root, ticker),
    async result(ticker: string, before: { digest: string }, status?: string, reason?: unknown, extra: any = {}) {
      const after = await outputInspectFund(root, ticker);
      console.log(outputFundLine(++completed, total, ticker, status ?? (before.digest === after.digest ? 'unchanged' : 'updated'), { ...after.meta, ...extra }, reason));
    },
  };
}

/**
 * @file Global X static feed updater.
 *
 * Zero runtime dependencies: `node:fs/promises` + global `fetch` only, run with
 * Bun. Writes the deterministic `api/globalx/**` tree the browser app reads.
 *
 * Source ladder:
 *   (a) official globalxetfs.com ETF lineup table ..... fund universe, name,
 *       (`#explore-etfs` → `#etf-table`)              category grouping,
 *                                                     declared frequency,
 *                                                     distribution rate,
 *                                                     30-day SEC yield,
 *                                                     management fee,
 *                                                     net assets, inception
 *   (b) official per-fund page ...................... Fund Details (CUSIP, ISIN,
 *       (`https://www.globalxetfs.com/funds/<ticker>/`)      NAV, market price, daily
 *                                                      change, exchange, net
 *                                                      assets, shares
 *                                                      outstanding), the
 *                                                      Distribution Information
 *                                                      block, the Distribution
 *                                                      History calendar, the
 *                                                      monthly/quarterly
 *                                                      performance tables, the
 *                                                      "Growth of $10,000 at NAV"
 *                                                      daily index and the
 *                                                      document links
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
 * "Full Holdings (.csv)" link points to the dated assets.globalxetfs.com file
 * that the site hands to a visitor.
 * Nothing is scraped from a client-rendered widget and no value is invented:
 * a metric Global X does not publish stays `null` and the app renders `—`.
 */
import { mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_ROOT = path.join(REPO_ROOT, 'api', 'globalx');

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
 * The official daily holdings download linked by each Global X fund page.
 * The current Next.js page publishes a dated asset URL such as
 * `https://assets.globalxetfs.com/funds/holdings/pave_full-holdings_20260925.csv`.
 */
export function globalxHoldingsCsvUrl(ticker: string, html?: string): string {
  if (html) {
    const match = html.match(/https:\/\/assets\.globalxetfs\.com\/funds\/holdings\/[^"'\\ ]+_full-holdings_\d{8}\.csv/i);
    if (match) return match[0];
  }
  // The date is supplied by the live fund page. This fallback is only for a
  // page response that omits the link; it is never written as provenance.
  return `https://assets.globalxetfs.com/funds/holdings/${sanitizeTicker(ticker).toLowerCase()}_full-holdings.csv`;
}

export function globalxProvenanceHoldingsUrl(ticker: string, html?: string): string {
  return globalxHoldingsCsvUrl(ticker, html);
}

export function globalxEdgarFilingsUrl(cik: string = GLOBALX_ETF_TRUST_CIK): string {
  return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=NPORT-P&dateb=&owner=include&count=10`;
}

export const YAHOO_CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';

export function yahooChartUrl(ticker: string, range: string = 'max', nowMs: number = Date.now()): string {
  const clean = sanitizeTicker(ticker);
  const period2 = Math.floor(nowMs / 1000);
  const base = `${YAHOO_CHART_URL}/${encodeURIComponent(clean)}?period1=0&period2=${period2}` +
    '&interval=1d&events=div%7Csplit&includeAdjustedClose=true';
  return range && range !== 'max' ? `${base}&range=${encodeURIComponent(range)}` : base;
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
const MONTH_LONG = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

export function toIsoDate(raw: unknown): string {
  const text = cleanText(raw);
  const flightDate = /^\$D(\d{4}-\d{2}-\d{2})/.exec(text);
  if (flightDate) return flightDate[1];
  if (!text) return '';
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  m = /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/.exec(text);
  if (m) {
    const index = MONTH_LONG.indexOf(m[1].toLowerCase());
    if (index >= 0) return `${m[3]}-${String(index + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  m = /^([A-Za-z]{3})\w*\s+(\d{1,2}),?\s+(\d{4})$/.exec(text);
  if (m) {
    const index = MONTH_SHORT.findIndex((month) => month.toLowerCase() === m![1].toLowerCase());
    if (index >= 0) return `${m[3]}-${String(index + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  return '';
}

/** `08/29/2022` -> `Aug 29 2022`. Returns the cleaned input when unparseable. */
export function formatGlobalXDate(raw: unknown): string {
  const iso = toIsoDate(raw);
  if (!iso) return cleanText(raw);
  const [year, month, day] = iso.split('-');
  return `${MONTH_SHORT[Number(month) - 1]} ${Number(day)} ${year}`;
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
      .map(sanitizeTicker)
      .filter(Boolean),
    historyRange: envValue(env, 'HISTORY_RANGE') || 'max',
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
  'EDGAR_FALLBACK', 'SKIP_YAHOO', 'SKIP_GLOBALX', 'SEC_UA', 'VERBOSE',
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
    const value = env[key] ?? (alias ? env[alias] : undefined);
    if (value !== undefined) apply({ [key]: value });
  }
  for (const key of ['MAX_FETCHES', 'CONCURRENCY', 'HOLDINGS_PAGE_SIZE', 'HISTORY_PAGE_SIZE', 'MAX_RETRIES']) {
    const v = result[key]?.trim();
    if (v === undefined || v === '') continue;
    const min = key === 'MAX_FETCHES' ? 0 : 1;
    if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v)) || Number(v) < min) throw new Error(`${key}: expected integer >= ${min}`);
  }
  if (result.REQUEST_SLEEP?.trim() && (!Number.isFinite(Number(result.REQUEST_SLEEP)) || Number(result.REQUEST_SLEEP) < 0)) throw new Error('REQUEST_SLEEP: expected nonnegative seconds');
  for (const key of ['STORE_RAW_DOWNLOADS', 'EDGAR_FALLBACK', 'SKIP_YAHOO', 'SKIP_GLOBALX', 'VERBOSE']) {
    if (result[key]?.trim() && !/^(0|1|true|false|yes|no|y|n|on|off)$/i.test(result[key].trim())) throw new Error(`${key}: expected boolean`);
  }
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
  CONCURRENCY          2     Parallel fund workers (starts stay globally paced).
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
  HISTORY_RANGE        max   Yahoo chart range used for daily history
                             ("max", "10y", "5y", ...).
  CATEGORY             ""    Keep only this Global X THEME / SUB_THEME category.
  STORE_RAW_DOWNLOADS  0     1|true|yes|y|on writes api/globalx/raw/**.
  SEC_UA               "daggerok ETF feed daggerok@gmail.com"
                             Declared User-Agent for SEC EDGAR requests; the
                             protected Actions variable SEC_UA wins in the workflow.
  EDGAR_FALLBACK       0     Use Form N-PORT-P when a fund has no holdings CSV.
  SKIP_YAHOO           0     Skip Yahoo Finance (daily history, dividend fallback).
  SKIP_GLOBALX         0     Skip globalxetfs.com entirely (keeps committed data).
  VERBOSE              0     1|true|yes|y|on prints per-fund retry and fallback notices.

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

export async function fetchWithRetry(
  url: string,
  headers: Record<string, string>,
  config: UpdaterConfig,
  label: string = url,
): Promise<Response> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
    await paceRequests(config);
    try {
      const response = await fetch(url, { headers, redirect: 'follow' });
      if (response.ok) return response;
      // globalxetfs.com answers 403 from its WAF while throttling, and the CSV
      // endpoint answers 200 with an HTML error page when the ticker is unknown.
      if (!RETRY_STATUS.has(response.status) && response.status !== 403) {
        throw new Error(`${label}: HTTP ${response.status}`);
      }
      lastError = new Error(`${label}: HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < config.maxRetries) await sleep(1500 * (attempt + 1));
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
  const response = await fetchWithRetry(url, headers, config, label);
  return await response.text();
}

async function fetchBytes(url: string, headers: Record<string, string>, config: UpdaterConfig, label = url): Promise<Uint8Array> {
  const response = await fetchWithRetry(url, headers, config, label);
  return new Uint8Array(await response.arrayBuffer());
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

function stripTags(fragment: string): string {
  return decodeHtmlEntities(String(fragment ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export type HtmlTable = string[][];

/**
 * Split one `<tr>` into its cell texts.
 *
 * globalxetfs.com ships several rows with a MISSING `</td>` (the ticker column of
 * XSPI/XQQI/XBCI/NEHI/MLPI/NLSI and the first cell of the Fund Details table),
 * so cells are cut on `<td` opening tags rather than paired with `</td>`: a
 * regex that requires a closing tag silently merges three columns into one.
 */
export function splitRowCells(rowHtml: string): string[] {
  const cells: string[] = [];
  const openings = [...rowHtml.matchAll(/<(td|th)\b[^>]*>/gi)];
  for (let index = 0; index < openings.length; index += 1) {
    const start = openings[index].index! + openings[index][0].length;
    const end = index + 1 < openings.length ? openings[index + 1].index! : rowHtml.length;
    let chunk = rowHtml.slice(start, end);
    // Drop a trailing closing tag only; a missing one must not swallow the value.
    chunk = chunk.replace(/<\/t[dh]>\s*$/i, '');
    cells.push(stripTags(chunk));
  }
  return cells;
}

export function parseHtmlTables(html: string): HtmlTable[] {
  const tables: HtmlTable[] = [];
  const tablePattern = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  for (const match of html.matchAll(tablePattern)) {
    const rows: HtmlTable = [];
    const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    for (const row of match[1].matchAll(rowPattern)) {
      cellsLoop: {
        // An unclosed final row would otherwise be dropped by the row regex, so
        // each row body is additionally scanned for orphan cells.
        const cells = splitRowCells(row[1]);
        if (cells.length) rows.push(cells);
        break cellsLoop;
      }
    }
    if (rows.length) tables.push(rows);
  }
  return tables;
}

/** The `<table>` whose `id="..."` matches, or null. */
export function tableById(html: string, id: string): HtmlTable | null {
  const pattern = new RegExp(`<table\\b[^>]*id=["']${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>([\\s\\S]*?)<\\/table>`, 'i');
  const match = pattern.exec(html);
  if (!match) return null;
  const rows: HtmlTable = [];
  for (const row of match[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = splitRowCells(row[1]);
    if (cells.length) rows.push(cells);
  }
  return rows;
}

/** Raw `<tr>` HTML of the table whose `id` matches, so markup-level hooks (the ticker CSS class) survive. */
export function tableRowsByIdRaw(html: string, id: string): string[] {
  const pattern = new RegExp(`<table\\b[^>]*id=["']${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>([\\s\\S]*?)<\\/table>`, 'i');
  const match = pattern.exec(html);
  if (!match) return [];
  return [...match[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) => row[1]);
}

/** Text of the first element carrying `id="..."`. */
export function elementTextById(html: string, id: string): string | null {
  const pattern = new RegExp(`<([a-z0-9]+)\\b[^>]*id=["']${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>([\\s\\S]*?)<\\/\\1>`, 'i');
  const match = pattern.exec(html);
  return match ? stripTags(match[2]) : null;
}

// ---------------------------------------------------------------------------
// Next.js Flight payload helpers
// ---------------------------------------------------------------------------

/**
 * globalxetfs.com is a Next.js application. The initial HTML contains a
 * skeleton, while the real catalog and fund data are serialized in
 * `self.__next_f.push([1, "..."])` Flight chunks. Decode those chunks first;
 * the fallback HTML table parser remains useful for fixtures and older pages.
 */
export function extractNextFlightText(html: string): string {
  const chunks: string[] = [];
  const pattern = /self\.__next_f\.push\(\[1,("(?:\\.|[^"\\])*")\]\)/g;
  for (const match of html.matchAll(pattern)) {
    try { chunks.push(JSON.parse(match[1])); } catch { /* ignore malformed chunks */ }
  }
  return chunks.join('');
}

function parseNextFlightRecords(flight: string): Map<string, unknown> {
  const records = new Map<string, unknown>();
  for (const line of flight.split('\n')) {
    const match = /^([0-9a-z]+):(\{[\s\S]*\}|\[[\s\S]*\])$/.exec(line);
    if (!match) continue;
    try { records.set(match[1], JSON.parse(match[2])); } catch { /* data record may be a text chunk */ }
  }
  return records;
}

function resolveNextFlightValue(value: unknown, records: Map<string, unknown>, seen = new Set<string>()): unknown {
  if (typeof value === 'string' && value.startsWith('$') && !value.startsWith('$D')) {
    const key = value.slice(1);
    if (key === 'undefined') return undefined;
    if (records.has(key) && !seen.has(key)) {
      const nextSeen = new Set(seen); nextSeen.add(key);
      return resolveNextFlightValue(records.get(key), records, nextSeen);
    }
  }
  if (Array.isArray(value)) return value.map((item) => resolveNextFlightValue(item, records, seen));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveNextFlightValue(item, records, seen)]));
  }
  return value;
}

function walkNextFlight(value: unknown, visit: (value: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) for (const item of value) walkNextFlight(item, visit);
  else if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    visit(object);
    for (const item of Object.values(object)) walkNextFlight(item, visit);
  }
}

function rscDate(value: unknown): string {
  const text = cleanText(value);
  const match = /^\$D(\d{4}-\d{2}-\d{2})/.exec(text);
  return match ? match[1] : toIsoDate(text);
}

function findRscObjectAfterKey(text: string, key: string): unknown {
  const marker = `"${key}":`;
  let from = 0;
  while (true) {
    const at = text.indexOf(marker, from);
    if (at < 0) return null;
    let start = at + marker.length;
    while (/\s/.test(text[start] || '')) start += 1;
    const opener = text[start];
    if (opener !== '{' && opener !== '[') { from = start + 1; continue; }
    let depth = 0; let quoted = false; let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
      if (char === '"') { quoted = true; continue; }
      if (char === opener) depth += 1;
      else if ((opener === '{' && char === '}') || (opener === '[' && char === ']')) {
        depth -= 1;
        if (depth === 0) {
          try { return JSON.parse(text.slice(start, index + 1)); } catch { break; }
        }
      }
    }
    from = start + 1;
  }
}

// ---------------------------------------------------------------------------
// globalxetfs.com — ETF lineup (`#explore-etfs`)
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
 * Read the server-rendered "Explore Our ETFs" table. Column order is
 * `Ticker | Fund Name | Distribution Frequency | Distribution Rate |
 * 30-Day SEC Yield | Management Fee | Net Assets | Inception Date`, but the rows
 * of the funds whose ticker carries an explicit class are missing their `</td>`
 * separators, which is why `splitRowCells` cuts on opening tags.
 */
export function parseGlobalXLineup(html: string): LineupFund[] {
  const flight = extractNextFlightText(html);
  const records = parseNextFlightRecords(flight);
  const funds: LineupFund[] = [];
  const seen = new Set<string>();
  for (const raw of records.values()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    if (!record.ETF_TICKER || !('FUND_DATA' in record) || !('GROSS_EXP' in record)) continue;
    const ticker = sanitizeTicker(record.ETF_TICKER);
    if (!/^[A-Z]{2,6}$/.test(ticker) || seen.has(ticker)) continue;
    const data = resolveNextFlightValue(record.FUND_DATA, records) as Record<string, unknown> | undefined;
    const category = [record.THEME, record.SUB_THEME].filter(Boolean).map(cleanText).join(' / ') || 'Other';
    const gross = numberOrNull(record.GROSS_EXP);
    const net = numberOrNull(record.NET_EXP);
    const fee = net !== null ? net : gross;
    const name = cleanText(data?.etf_name || ticker);
    const inceptionDate = rscDate(data?.inception_date);
    funds.push({
      ticker,
      name,
      category,
      categoryClass: cleanText(record.SUB_THEME),
      frequency: '',
      distributionRate: null,
      distributionRateText: '',
      secYield: null,
      secYieldText: '',
      managementFee: fee,
      managementFeeText: fee === null ? '' : formatPercentText(fee),
      netAssets: numberOrNull(data?.net_assets),
      netAssetsText: data?.net_assets == null ? '' : formatAumDisplay(Number(data.net_assets)),
      inceptionDate,
      fundPage: globalxFundPageUrl(ticker),
    });
    seen.add(ticker);
  }
  if (funds.length) return funds;

  // Fixture/legacy fallback for a plain server-rendered table.
  const tables = parseHtmlTables(html);
  for (const table of tables) {
    const header = table.find((row) => row[0]?.includes('Ticker') && row[1]?.includes('ETF Name'));
    if (!header) continue;
    for (const row of table) {
      if (row === header || row.length < 6) continue;
      const ticker = sanitizeTicker(row[0]);
      if (!/^[A-Z]{2,6}$/.test(ticker) || seen.has(ticker)) continue;
      funds.push({ ticker, name: cleanText(row[1]), category: 'Other', categoryClass: '', frequency: '', distributionRate: null, distributionRateText: '', secYield: null, secYieldText: '', managementFee: numberOrNull(row[4]), managementFeeText: cleanText(row[4]), netAssets: moneyOrNull(row[3]), netAssetsText: cleanText(row[3]), inceptionDate: '', fundPage: globalxFundPageUrl(ticker) });
    }
    if (funds.length) break;
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
  /** The fund page's own `Premium Discount (%)` row (published, not derived). */
  premiumDiscount: number | null;
  premiumDiscountText: string | null;
  /** `30-Day Median Bid-Ask Spread (%)`, published by the quote tables. */
  bidAskSpread: number | null;
  bidAskSpreadText: string | null;
  /** `Acquired Fund Fees & Expenses` when the panel itemizes it. */
  acquiredFundFeesText: string | null;
  asOfDate: string;
};

/** `$12,151,808,030` -> 12151808030; `1,234` -> 1234. */
export function moneyOrNull(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const text = cleanText(raw).replace(/[$,]/g, '');
  if (!text || isMissingCell(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The labels the `Fund Details` panel uses. Only these can start a label/value
 * pair, which keeps the reader aligned even when the provider drops a `<tr>`.
 */
const FUND_DETAIL_LABELS = new Set([
  'fund inception',
  'fund ticker',
  'cusip',
  'isin',
  'management fee',
  'acquired fund fees & expenses',
  'total annual fund operating expenses',
  'net assets',
  'shares outstanding',
  'primary exchange',
  'underlying exposure',
  'distribution frequency',
  'net asset value',
  'market price',
  'premium discount (%)',
  'premium / discount',
  '30-day median bid-ask spread (%)',
  'daily change ($)',
  'daily change (%)',
]);

/** The `Fund Details` panel: CUSIP, ISIN, NAV, market price, exchange, share count. */
export function parseGlobalXFundDetails(html: string): GlobalXFundDetails {
  const flight = extractNextFlightText(html);
  const details = findRscObjectAfterKey(flight, 'ETF_DETAILS') as Record<string, unknown> | null;
  const result: GlobalXFundDetails = {
    inceptionDate: rscDate(details?.INCEPTION_DATE),
    ticker: sanitizeTicker(details?.BLOOMBERG_TICKER),
    cusip: details?.CUSIP ? cleanText(details.CUSIP) : null,
    isin: details?.ISIN ? cleanText(details.ISIN) : null,
    managementFeeText: null,
    totalOperatingExpensesText: null,
    netAssets: numberOrNull(details?.ASSETS),
    netAssetsText: details?.ASSETS == null ? null : formatAumDisplay(Number(details.ASSETS)),
    sharesOutstanding: numberOrNull(details?.SHARES_OUTSTANDING),
    sharesOutstandingText: details?.SHARES_OUTSTANDING == null ? null : Number(details.SHARES_OUTSTANDING).toLocaleString('en-US'),
    primaryExchange: details?.EXCHANGE ? cleanText(details.EXCHANGE) : null,
    underlyingExposure: null,
    distributionFrequency: null,
    netAssetValue: numberOrNull(details?.NET_ASSET_VALUE),
    netAssetValueText: details?.NET_ASSET_VALUE == null ? null : cleanText(details.NET_ASSET_VALUE),
    navDailyChangeValue: null,
    navDailyChangePercent: null,
    marketPrice: null,
    marketPriceText: null,
    marketPriceDailyChangeValue: null,
    marketPriceDailyChangePercent: null,
    premiumDiscount: null,
    premiumDiscountText: null,
    bidAskSpread: details?.THIRTY_DAY_MEDIAN_BID_ASK == null ? null : round(Number(details.THIRTY_DAY_MEDIAN_BID_ASK) * 100, 2),
    bidAskSpreadText: details?.THIRTY_DAY_MEDIAN_BID_ASK == null ? null : `${(Number(details.THIRTY_DAY_MEDIAN_BID_ASK) * 100).toFixed(2)}%`,
    acquiredFundFeesText: null,
    asOfDate: rscDate(details?.AS_OF_DATE),
  };
  const tables = parseHtmlTables(html);
  for (const table of tables) {
    for (const row of table) {
      if (row.length < 2) continue;
      const label = cleanText(row[0]);
      if (/^NAV$/i.test(label) && row.length >= 5) {
        result.netAssetValue = numberOrNull(row[1]) ?? result.netAssetValue;
        result.netAssetValueText = cleanText(row[1]) || result.netAssetValueText;
        result.navDailyChangeValue = numberOrNull(row[3]);
        result.navDailyChangePercent = numberOrNull(row[4]);
      } else if (/^Market Price$/i.test(label) && row.length >= 5) {
        result.marketPrice = numberOrNull(row[1]);
        result.marketPriceText = cleanText(row[1]);
        result.marketPriceDailyChangeValue = numberOrNull(row[3]);
        result.marketPriceDailyChangePercent = numberOrNull(row[4]);
      }
    }
  }
  // The premium/discount history is serialized in the Flight payload. The
  // current day's figure is optional; the updater derives it from NAV/market
  // price when the issuer does not expose a scalar field.
  const premium = findRscObjectAfterKey(flight, 'PREMIUM_DISCOUNT') as Record<string, unknown> | null;
  const latest = premium?.latest_discount_pctg;
  if (typeof latest === 'number') {
    result.premiumDiscount = round(latest * 100, 4);
    result.premiumDiscountText = `${(latest * 100).toFixed(4)}%`;
  }
  return result;
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
 * The "Distribution Information (as of MM/DD/YYYY)" table under the fund page
 * `Distributions` heading. It is a plain two-column label/value table, so it is
 * located by its own header cell rather than by position.
 */
export function parseGlobalXDistributionInfo(html: string): GlobalXDistributionInfo | null {
  const flight = extractNextFlightText(html);
  const details = findRscObjectAfterKey(flight, 'ETF_DETAILS') as Record<string, unknown> | null;
  const frequency = /"children":"Distribution Frequency"[\s\S]{0,900}?"children":"([^"]+)"/.exec(flight)?.[1] || null;
  const asOf = rscDate(details?.AS_OF_DATE);
  if (!details && !frequency) return null;
  const sec = numberOrNull(details?.YIELD_SEC_30);
  const rate = numberOrNull(details?.DIV_YIELD);
  return {
    asOfDate: asOf,
    frequency,
    managementFeeText: null,
    distributionRate: rate,
    distributionRateText: rate === null ? null : `${rate.toFixed(2)}%`,
    trailingRate12M: null,
    trailingRate12MText: null,
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
 * The official Distribution History calendar. Rows are grouped in per-year
 * `<div id="dc-year-<YYYY>">` blocks, newest first, and a declared-but-unpaid
 * month ships an empty Amount cell — kept verbatim so the table mirrors the page.
 */
export function parseGlobalXDistributionHistory(html: string): GlobalXDistributionRow[] {
  const flight = extractNextFlightText(html);
  const history = findRscObjectAfterKey(flight, 'DISTRIBUTION_HISTORY');
  if (!Array.isArray(history)) return [];
  return history.map((item) => {
    const row = item as Record<string, unknown>;
    return {
      'Declaration Date': '',
      'Ex-Div Date': cleanText(row.ex_date),
      'Record Date': cleanText(row.record_date),
      'Payable Date': cleanText(row.payable_date),
      'Amount ($)': row.amount == null ? '' : `$${Number(row.amount).toFixed(6)}`,
    };
  }).sort((a, b) => b['Ex-Div Date'].localeCompare(a['Ex-Div Date']));
}
export type GlobalXPerformance = {
  asOfDate: string;
  nav: Record<string, number | null>;
  market: Record<string, number | null>;
  benchmarkName: string | null;
  benchmark: Record<string, number | null>;
};

/** Column label -> the field the feed stores it as. */
const PERFORMANCE_COLUMNS: Record<string, string> = {
  '1 mo': 'mo1',
  '3 mo': 'mo3',
  '6 mo': 'mo6',
  ytd: 'ytd',
  'inception (cumulative)': 'sinceInceptionCumulative',
  '1 yr': 'yr1',
  '3 yr': 'yr3',
  '5 yr': 'yr5',
  '10 yr': 'yr10',
  'inception (annualized)': 'sinceInception',
  'since inception': 'sinceInceptionCumulative',
};

/**
 * One `#monthly-performance` / `#quarterly-performance` table. Returns the NAV
 * and Market rows plus the first benchmark row the page prints.
 */
export function parseGlobalXPerformanceSection(html: string, sectionId: string): GlobalXPerformance | null {
  const flight = extractNextFlightText(html);
  const performance = findRscObjectAfterKey(flight, 'PERFORMANCE_HISTORY') as Record<string, any> | null;
  if (!performance) return null;
  const periodKey = /quarter/i.test(sectionId) ? 'quarter_end' : 'month_end';
  const period = performance.avg_annualized?.[periodKey];
  if (!period) return null;
  const annual = period.fund_nav || {};
  const cumulative = performance.cumulative?.[periodKey]?.fund_nav || {};
  const pct = (value: unknown): number | null => {
    const n = numberOrNull(value);
    return n === null ? null : round(n * 100, 2);
  };
  return {
    asOfDate: rscDate(performance[periodKey === 'quarter_end' ? 'quarter_end_date' : 'month_end_date']),
    nav: {
      yr1: pct(annual.ONE_YEAR), yr3: pct(annual.THREE_YEAR), yr5: pct(annual.FIVE_YEAR),
      sinceInception: pct(annual.SINCE_INCEPTION),
      mo1: pct(cumulative.ONE_MONTH), mo3: pct(cumulative.THREE_MONTH), ytd: pct(cumulative.YTD),
      sinceInceptionCumulative: pct(cumulative.SINCE_INCEPTION),
    },
    market: Object.fromEntries(Object.entries(period.market_price || {}).map(([key, value]) => [key, pct(value)])),
    benchmarkName: 'Index',
    benchmark: Object.fromEntries(Object.entries(period.index || {}).map(([key, value]) => [key, pct(value)])),
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

/** The `Documents` table: every row's label matched to its first PDF link. */
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
  const start = html.search(/id=["']fund_documents["']/i);
  const section = start >= 0 ? html.slice(start, start + 20000) : html;
  for (const row of section.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cell = row[1];
    const label = stripTags(cell);
    const href = /href=["'](https?:\/\/[^"']+\.pdf)["']/i.exec(cell);
    if (!href) continue;
    const url = href[1];
    const set = (key: keyof GlobalXDocuments) => {
      if (!documents[key]) documents[key] = url;
    };
    if (/^summary prospectus/i.test(label)) set('summaryProspectus');
    else if (/^prospectus/i.test(label)) set('prospectus');
    else if (/statement of additional information/i.test(label)) set('sai');
    else if (/^semi-annual report/i.test(label)) set('semiAnnualReport');
    else if (/^annual report/i.test(label)) set('annualReport');
    else if (/portfolio holdings/i.test(label)) {
      if (/q1/i.test(label)) set('fiscalQ1Holdings');
      else if (/q3/i.test(label)) set('fiscalQ3Holdings');
    } else if (/supplemental tax information/i.test(label)) set('taxInfo');
  }
  // Form 8937 filings live in their own tab as a list of period-labelled links.
  // The filing is matched on its own filename, so a fund whose 8937 tab is
  // empty never picks up the first PDF of the tab that follows it.
  const formStart = html.search(/id=["']tab-form-8937["']/i);
  if (formStart >= 0) {
    const formSection = html.slice(formStart, formStart + 12000);
    const pdf = /href=["'](https?:\/\/[^"']*8937[^"']*\.pdf)["']/i.exec(formSection);
    if (pdf) documents.form8937 = pdf[1];
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
 * Map the official CSV onto the shared holdings contract. The feed keeps the
 * provider's own `Weightings` percentage string, its `MarketValue` and its
 * `Shares` verbatim — including the negative values of written options.
 */
export function parseGlobalXHoldingsCsv(text: string): ParsedHoldings {
  const table = parseCsv(text);
  const rows: Array<Record<string, string>> = [];
  let asOfDate = '';
  for (const row of table) {
    if (row[0]?.includes('Fund Holdings Data as of')) {
      const match = row[0].match(/as of\s+(\d{1,2}\/\d{1,2}\/\d{4})/i);
      if (match) asOfDate = toIsoDate(match[1]);
      continue;
    }
    if (row.length < 7 || /% of Net Assets/i.test(row[0]) || /Holdings/i.test(row[0])) continue;
    const weight = cleanText(row[0]);
    if (!/^[-+]?\d+(?:\.\d+)?$/.test(weight)) continue;
    const ticker = cleanText(row[1]);
    const name = cleanText(row[2]);
    const sedol = cleanText(row[3]);
    rows.push({
      Name: name,
      Ticker: ticker,
      Identifier: sedol,
      Weight: `${weight}%`,
      'Market Value': cleanText(row[6]),
      'Shares Held': cleanText(row[5]),
      'Asset Category': globalxAssetCategory(ticker, name, ''),
      Price: cleanText(row[4]),
    });
  }
  return { headers: [...HOLDINGS_HEADERS], rows, asOfDate, netAssets: null, sharesOutstanding: null, creationUnits: null, totalRows: rows.length };
}
export function parseNportXml(xml: string): { positions: NportPosition[]; repPdDate: string; seriesName: string | null } {
  const repPdDate = xmlTagText(xml, 'repPdDate') || '';
  const seriesName = xmlTagText(xml, 'seriesName');
  const positions: NportPosition[] = [];
  for (const block of xml.matchAll(/<invstOrSec\b[^>]*>([\s\S]*?)<\/invstOrSec>/gi)) {
    const body = block[1];
    const cusip = xmlValue(body, 'cusip') || '';
    positions.push({
      name: xmlTagText(body, 'name') || '',
      ticker: xmlValue(body, 'ticker') || '',
      cusip,
      balance: numberOrNull(xmlValue(body, 'balance')),
      valueUsd: numberOrNull(xmlValue(body, 'valUSD')),
      percent: numberOrNull(xmlValue(body, 'pctVal')),
      assetCategory: xmlTagText(body, 'assetCat') || '',
    });
  }
  return { positions, repPdDate, seriesName };
}

/** Fold N-PORT positions onto the shared holdings contract. */
export function nportToHoldings(positions: NportPosition[], netAssets: number | null): Array<Record<string, string>> {
  return positions.map((position) => {
    const weight = position.percent === null
      ? (netAssets && position.valueUsd !== null ? round((position.valueUsd / netAssets) * 100, 2) : null)
      : position.percent;
    return {
      Name: position.name,
      Ticker: position.ticker,
      Identifier: position.cusip || position.ticker,
      Weight: weight === null ? '' : `${weight.toFixed(2)}%`,
      'Market Value': position.valueUsd === null ? '' : formatMoneyText(position.valueUsd),
      'Shares Held': position.balance === null ? '' : String(position.balance),
      'Asset Category': cleanText(position.assetCategory) || 'Other',
    };
  });
}

// ---------------------------------------------------------------------------
// Yahoo Finance chart feed
// ---------------------------------------------------------------------------

export type YahooHistoryRow = { date: string; close: number | null; adjClose: number | null; volume: number | null };
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
    history.push({ date, close, adjClose: adjusted, volume: numberOrNull(quote.volume?.[index]) });
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
  if (text === 'semi-annually' || text === 'semiannually' || text === 'semi-annual' || text === 'semiannual') return 6;
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

function stableStringify(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Write only when the serialized bytes moved, so a no-op run leaves an empty `git diff`. */
export async function writeIfChanged(file: string, content: string): Promise<'written' | 'unchanged'> {
  if (existsSync(file)) {
    const current = await readFile(file, 'utf8');
    if (current === content) return 'unchanged';
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
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
 * AND filter. A young fund missing a requested 3Y/5Y/10Y metric PASSES the
 * filter (there is nothing to compare), while a fund missing AUM or TER under an
 * active filter FAILS it.
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
  if (config.dividendYieldRange) {
    if (fund.distributionRate === null) return false;
    if (!matchesRange(fund.distributionRate, config.dividendYieldRange)) return false;
  }
  if (config.secYieldRange) {
    if (fund.secYield === null) return false;
    if (!matchesRange(fund.secYield, config.secYieldRange)) return false;
  }
  return true;
}

function passesReturnFilters(entry: CatalogEntry, config: UpdaterConfig): boolean {
  const monthEnd = ((entry.returns as any)?.monthEnd || {}) as Record<string, number | null>;
  const metrics = (entry.metrics || {}) as Record<string, number | null>;
  const published: Record<ReturnPeriod, number | null> = {
    YTD: monthEnd.ytd ?? null,
    '1Y': metrics.tr1y ?? monthEnd.yr1 ?? null,
    '3Y': metrics.cagr3y ?? monthEnd.yr3 ?? null,
    '5Y': metrics.cagr5y ?? monthEnd.yr5 ?? null,
    '10Y': metrics.cagr10y ?? monthEnd.yr10 ?? null,
  };
  for (const period of RETURN_PERIODS) {
    const range = config.performanceRanges[period];
    if (!range) continue;
    const value = published[period];
    if (value === null || value === undefined) continue; // young fund: nothing to filter
    if (!matchesRange(value, range)) return false;
  }
  for (const period of RETURN_PERIODS) {
    const range = config.totalReturnRanges[period];
    if (!range) continue;
    const derived: Record<ReturnPeriod, number | null> = {
      YTD: monthEnd.ytd ?? null,
      '1Y': metrics.tr1y ?? null,
      '3Y': metrics.tr3y ?? null,
      '5Y': metrics.tr5y ?? null,
      '10Y': metrics.tr10y ?? null,
    };
    const value = derived[period];
    if (value === null || value === undefined) continue;
    if (!matchesRange(value, range)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Per-fund update
// ---------------------------------------------------------------------------

type RunStats = { updated: number; unchanged: number; skipped: number; failed: number };

function readNumber(entry: CatalogEntry, key: string): number | null {
  const value = (entry as any)[key];
  return typeof value === 'number' ? value : null;
}

async function updateFund(
  fund: LineupFund,
  config: UpdaterConfig,
  stats: RunStats,
): Promise<CatalogEntry> {
  const ticker = fund.ticker;
  const fundDir = path.join(API_ROOT, 'funds', ticker);
  let changed = false;

  let pageHtml = '';
  if (!config.skipGlobalX) {
    pageHtml = await fetchText(globalxFundPageUrl(ticker), browserHeaders(), config, `${ticker} fund page`);
    if (config.storeRawDownloads) {
      await writeIfChanged(path.join(API_ROOT, 'raw', `${ticker}-fund-page.html`), pageHtml);
    }
  }

  const details = parseGlobalXFundDetails(pageHtml);
  const distributionInfo = parseGlobalXDistributionInfo(pageHtml);
  const distributionRows = parseGlobalXDistributionHistory(pageHtml);
  const monthly = parseGlobalXPerformanceSection(pageHtml, 'monthly-performance');
  const quarterly = parseGlobalXPerformanceSection(pageHtml, 'quarterly-performance');
  const navIndex = parseGlobalXNavIndex(pageHtml);
  const documents = parseGlobalXDocuments(pageHtml);

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
  if (!config.skipGlobalX) {
    try {
      const csv = await fetchText(globalxHoldingsCsvUrl(ticker, pageHtml), browserHeaders(), config, `${ticker} holdings CSV`);
      if (/^\s*</.test(csv)) throw new Error(`${ticker} holdings CSV: received HTML instead of CSV`);
      const parsed = parseGlobalXHoldingsCsv(csv);
      holdings = { ...holdings, ...parsed, headers: parsed.headers, source: globalxProvenanceHoldingsUrl(ticker, pageHtml) };
      if (config.storeRawDownloads) {
        await writeIfChanged(path.join(API_ROOT, 'raw', `${ticker}-holdings.csv`), csv);
      }
    } catch (error) {
      if (!config.edgarFallback) throw error;
      outputNote(`[ ${'holdings'.padEnd(9)}] ${ticker}: holdings CSV unavailable (${errorMessage(error)}), trying EDGAR`);
      const xml = await fetchText(globalxEdgarFilingsUrl(), secHeaders(config), config, `${ticker} EDGAR`);
      const filings = [...xml.matchAll(/href=["'](\/Archives\/[^"']+primary_doc\.xml)["']/gi)].map((match) => match[1]);
      if (!filings.length) throw new Error(`${ticker}: no N-PORT primary_doc.xml link on the EDGAR page`);
      const nport = parseNportXml(await fetchText(`https://www.sec.gov${filings[0]}`, secHeaders(config), config, `${ticker} N-PORT`));
      holdings = {
        ...holdings,
        headers: [...HOLDINGS_HEADERS],
        rows: nportToHoldings(nport.positions, details.netAssets ?? null),
        asOfDate: nport.repPdDate,
        totalRows: nport.positions.length,
        source: `https://www.sec.gov${filings[0]}`,
        sourceKind: 'SEC EDGAR Form N-PORT-P (fallback)',
      };
    }
  }

  // --- daily history + dividend fallback (Yahoo) -------------------------
  let historyRows: Array<Record<string, string>> = [];
  let yahooDividends: YahooDistribution[] = [];
  let yahooExchange: string | null = null;
  if (!config.skipYahoo) {
    try {
      const url = yahooChartUrl(ticker, config.historyRange);
      const response = await fetchWithRetry(url, yahooHeaders(), config, `${ticker} Yahoo chart`);
      const json = await response.json();
      const parsed = parseYahooChart(json);
      yahooDividends = parsed.dividends;
      yahooExchange = parseYahooExchangeName(json);
      historyRows = parsed.history.map((row) => ({
        Date: row.date,
        Close: row.close === null ? '' : row.close.toFixed(2),
        'Adj Close': row.adjClose === null ? '' : row.adjClose.toFixed(2),
        Volume: row.volume === null ? '' : String(row.volume),
      }));
    } catch (error) {
      outputNote(`[ ${'chart'.padEnd(9)}] ${ticker}: Yahoo chart unavailable (${errorMessage(error)})`);
    }
  }

  // --- assemble metrics --------------------------------------------------
  const netAssets = holdings.netAssets ?? details.netAssets ?? fund.netAssets ?? null;
  const sharesOutstanding = holdings.sharesOutstanding ?? details.sharesOutstanding ?? null;
  // Global X prints NAV and Market Price directly; the derived quotient is only a
  // guard for the day a fund page omits the panel.
  const derivedNav = netAssets !== null && sharesOutstanding ? round(netAssets / sharesOutstanding, 2) : null;
  const navValue = details.netAssetValue ?? derivedNav;
  const navKind = details.netAssetValue !== null ? 'official (fund page Fund Details)' : 'derived (Net Assets / Shares Outstanding)';
  const marketPriceValue = details.marketPrice
    ?? (historyRows.length ? numberOrNull(historyRows[0].Close) : null);
  const derivedPremiumDiscount = navValue && marketPriceValue !== null ? round(((marketPriceValue - navValue) / navValue) * 100, 2) : null;
  // Global X prints its own `Premium Discount (%)`; the quotient is only the guard
  // for the day a panel omits the row.
  const premiumDiscount = details.premiumDiscount ?? derivedPremiumDiscount;
  const premiumDiscountKind = details.premiumDiscount !== null
    ? 'official (fund page Fund Details "Premium Discount (%)")'
    : 'derived (Market Price - NAV) / NAV';

  const monthEndValues = monthly?.nav || {};
  const quarterEndValues = quarterly?.nav || {};
  const monthEndDate = monthly?.asOfDate || '';
  const quarterEndDate = quarterly?.asOfDate || '';

  const metrics = {
    ytd: monthEndValues.ytd ?? null,
    tr1y: monthEndValues.yr1 ?? null,
    tr3y: cumulativeFromAnnualized(monthEndValues.yr3 ?? null, 3),
    tr5y: cumulativeFromAnnualized(monthEndValues.yr5 ?? null, 5),
    tr10y: cumulativeFromAnnualized(monthEndValues.yr10 ?? null, 10),
    cagr3y: monthEndValues.yr3 ?? null,
    cagr5y: monthEndValues.yr5 ?? null,
    cagr10y: monthEndValues.yr10 ?? null,
    siAnn: monthEndValues.sinceInception ?? null,
    dividendYield: distributionInfo?.distributionRate ?? fund.distributionRate ?? null,
    dividendYieldText: formatPercentText(distributionInfo?.distributionRate ?? fund.distributionRate ?? null),
    distributionYield: distributionInfo?.distributionRate ?? fund.distributionRate ?? null,
    distributionYieldText: formatPercentText(distributionInfo?.distributionRate ?? fund.distributionRate ?? null),
    yield12M: distributionInfo?.trailingRate12M ?? null,
    yield12MText: formatPercentText(distributionInfo?.trailingRate12M ?? null),
    secYield: distributionInfo?.secYield ?? fund.secYield ?? null,
    secYieldText: formatPercentText(distributionInfo?.secYield ?? fund.secYield ?? null),
    returnsBasis: 'official Global X fund page NAV Performance (monthly series)',
  };

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
    source: config.skipYahoo ? '' : yahooChartProvenanceUrl(ticker),
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
      nportDoc: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${GLOBALX_ETF_TRUST_CIK}&type=NPORT-P&dateb=&owner=include&count=10`,
      exchangeSource: 'Global X fund page Fund Details "Primary Exchange"',
      navSource: `Global X fund page Fund Details "Net Asset Value" (${navKind})`,
      premiumDiscountSource: premiumDiscountKind,
      bidAskSpreadSource: 'Global X fund page Fund Details "30-Day Median Bid-Ask Spread (%)"',
    },
    identifiers: {
      cusip: details.cusip || null,
      isin: details.isin || null,
      underlyingExposure: details.underlyingExposure || null,
      indexName: details.underlyingExposure || null,
      benchmarkIndexName: monthly?.benchmarkName || null,
    },
    expenseRatio: {
      display: details.totalOperatingExpensesText || fund.managementFeeText || null,
      value: numberOrNull(details.totalOperatingExpensesText) ?? fund.managementFee ?? null,
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
      kind: 'official (fund page Fund Details "30-Day Median Bid-Ask Spread (%)")',
    },
    aum: {
      display: netAssets === null ? null : formatAumDisplay(netAssets),
      value: netAssets,
      asOfDate: details.asOfDate ? formatGlobalXDate(details.asOfDate) : holdingsMeta.asOfDate,
      source: holdings.netAssets !== null ? holdings.sourceKind : 'Global X fund page Fund Details "Net Assets"',
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
  // Drop stale page files when a fund's row count shrinks.
  await prunePages(path.join(fundDir, 'holdings'), holdingsPages.length);

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
    historyMeta.pages.push(`./history/${pageFileName(index + 1)}`);
  }
  await prunePages(path.join(fundDir, 'history'), historyPages.length);

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
    ter: details.totalOperatingExpensesText || fund.managementFeeText || '—',
    terValue: numberOrNull(details.totalOperatingExpensesText) ?? fund.managementFee ?? null,
    terGross: details.managementFeeText || fund.managementFeeText || null,
    terGrossValue: numberOrNull(details.managementFeeText) ?? fund.managementFee ?? null,
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

  if (changed) stats.updated += 1; else stats.unchanged += 1;

  return entry;
}


function inferPaymentsFromRows(exDates: string[]): number | null {
  const code = inferDistributionFrequency(exDates);
  if (code === '01 - Monthly') return 12;
  if (code === '04 - Quarterly') return 4;
  if (code === '06 - Semi-annually') return 6;
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

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function main(env: Record<string, string | undefined> = process.env): Promise<void> {
  if (process.argv.slice(2).some((arg) => arg === '-h' || arg === '--help')) {
    console.log(USAGE);
    return;
  }
  const controls = await runtimeControls(env);
  if (controls.VERBOSE !== undefined && env === process.env) process.env.VERBOSE = controls.VERBOSE;
  const config = readConfig(controls);
  outputPrintConfig('Global X', config);
  const stats: RunStats = { updated: 0, unchanged: 0, skipped: 0, failed: 0 };

  // The lineup table is the catalog: it lists every fund, its asset class, the
  // declared distribution frequency and the headline figures.
  let lineup: LineupFund[] = [];
  const indexFile = path.join(API_ROOT, 'index.json');
  let previous: Record<string, CatalogEntry> = {};
  let previousGeneratedAt = '';
  if (existsSync(indexFile)) {
    try {
      const parsed = JSON.parse(await readFile(indexFile, 'utf8'));
      previousGeneratedAt = String(parsed.generatedAt || '');
      for (const fund of parsed.funds || []) previous[fund.ticker] = fund;
    } catch {
      previous = {};
    }
  }

  if (!config.skipGlobalX) {
    const home = await fetchText(GLOBALX_LINEUP_URL, browserHeaders(), config, 'Global X home page');
    if (config.storeRawDownloads) await writeIfChanged(path.join(API_ROOT, 'raw', 'lineup.html'), home);
    lineup = parseGlobalXLineup(home);
    if (!lineup.length) throw new Error('lineup: the #explore-etfs #etf-table was not found on globalxetfs.com');
  } else {
    lineup = Object.values(previous).map((entry) => ({
      ticker: String(entry.ticker),
      name: String(entry.name || ''),
      category: String(entry.category || ''),
      categoryClass: '',
      frequency: String((entry as any).distributions?.frequency || ''),
      distributionRate: readNumber(entry, 'dividendYield'),
      distributionRateText: '',
      secYield: null,
      secYieldText: '',
      managementFee: readNumber(entry, 'terValue'),
      managementFeeText: String(entry.ter || ''),
      netAssets: readNumber(entry, 'aumValue'),
      netAssetsText: String(entry.aum || ''),
      inceptionDate: String(entry.inceptionDate || ''),
      fundPage: String(entry.fundPage || ''),
    }));
  }

  const filtered = lineup.filter((fund) => passesFilters(fund, config));
  let candidates = filtered;
  if (config.maxFetches > 0) {
    const cursor = await readCursor();
    if (cursor) {
      const at = filtered.findIndex((fund) => fund.ticker === cursor);
      candidates = at >= 0 ? filtered.slice(at + 1) : filtered;
    }
    candidates = candidates.slice(0, config.maxFetches);
  }

  outputPrintFilter(candidates.length, lineup.length, outputHasOutputFilters(config));
  const output = outputCreateReporter(API_ROOT, candidates.length);
  if (config.maxFetches > 0) {
    const cursor = await readCursor();
    if (cursor) console.log(`Resuming after cursor ${cursor}.`);
  }

  const byTicker = new Map<string, CatalogEntry>();
  const queue = candidates.slice();
  const total = candidates.length;
  let processed = 0;
  const laneCount = Math.max(1, config.concurrency);
  lastRequestAtLanes = new Array(laneCount).fill(0);
    const workers = Array.from({ length: laneCount }, async () => {
    for (;;) {
      const fund = queue.shift();
      if (!fund) return;
      const before = await output.before(fund.ticker);
      try {
        const entry = await updateFund(fund, config, stats);
        if (!passesReturnFilters(entry, config)) {
          stats.skipped += 1;
          processed += 1;
          await output.result(fund.ticker, before, 'skipped', 'return filter');
          continue;
        }
        byTicker.set(fund.ticker, entry);
        processed += 1;
        await output.result(fund.ticker, before);
      } catch (error) {
        processed += 1;
        stats.failed += 1;
        await output.result(fund.ticker, before, 'failed', errorMessage(error));
      }
    }
  });
  await Promise.all(workers);

  // Previously published entries are preserved so a bounded or failed run can
  // never empty the site.
  for (const fund of lineup) {
    if (!previous[fund.ticker]) {
      previous[fund.ticker] = {
        ticker: fund.ticker,
        name: fund.name,
        category: fund.category,
        fundPage: fund.fundPage,
        dataFile: `./funds/${fund.ticker}/meta.json`,
        holdings: 0,
        history: 0,
      };
    }
  }
  for (const [ticker, entry] of byTicker) previous[ticker] = entry;

  const funds = Object.values(previous).sort((a, b) => String(a.ticker).localeCompare(String(b.ticker)));
  const counts = {
    funds: funds.length,
    holdings: funds.reduce((sum, fund) => sum + Number(fund.holdings || 0), 0),
    history: funds.reduce((sum, fund) => sum + Number(fund.history || 0), 0),
  };
  const index = {
    // Kept from the previous file so an unchanged rerun produces an empty diff;
    // advanced below only when the serialized bytes actually moved.
    generatedAt: previousGeneratedAt || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    source: {
      provider: 'Global X Investment Management LLC (Global X ETFs)',
      market: 'us',
      site: GLOBALX_SITE,
      catalog: GLOBALX_LINEUP_URL,
      catalogNote: 'Server-rendered "Explore Our ETFs" table (#explore-etfs → #etf-table); five asset-class groups.',
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
  const serialized = stableStringify(index);
  const indexResult = await writeIfChanged(indexFile, serialized);
  if (indexResult === 'written' && previousGeneratedAt) {
    await writeFile(
      indexFile,
      stableStringify({ ...index, generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') }),
      'utf8',
    );
  }

  if (config.maxFetches > 0 && candidates.length) {
    await writeIfChanged(
      path.join(API_ROOT, 'update-state.json'),
      stableStringify({ cursor: candidates[candidates.length - 1].ticker, savedAt: new Date().toISOString() }),
    );
  } else if (config.maxFetches === 0 && existsSync(path.join(API_ROOT, 'update-state.json'))) {
    await rm(path.join(API_ROOT, 'update-state.json'));
  }

  console.log(
    `Done. updated=${stats.updated} unchanged=${stats.unchanged} skipped=${stats.skipped} failed=${stats.failed} · ` +
      `funds=${counts.funds} holdings=${counts.holdings} history=${counts.history}`,
  );
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(errorMessage(error));
    process.exit(1);
  });
}
