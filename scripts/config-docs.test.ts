/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { CONTROL_NAMES, readConfig, resolveControls, runtimeControls } from './update-data';

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
  for (const value of [{ UNKNOWN: 1 }, { SEC_UA: 'x\nEVIL=yes' }, { CONCURRENCY: 0 }, { MAX_RETRIES: -1 }, { MAX_FETCHES: 1.5 }, { REQUEST_SLEEP: '-1' }, { VERBOSE: 'maybe' }, { AUM: '1:2:3' }, { TER: '2:1' }, { TICKERS: ['PAVE'] }, { TICKERS: { a: 1 } }, null, []]) {
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
