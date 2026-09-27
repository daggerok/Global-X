import { test, expect } from 'bun:test';
import { parseGlobalXLineup, parseGlobalXHoldingsCsv } from './update-data.ts';

test('parseGlobalXLineup', () => {
  const html = `<table class="etf-table">
    <thead>
      <tr>
        <th></th><th></th><th>Ticker</th><th>ETF Name</th><th>NAV</th><th>Net Assets</th><th>Gross Exp.</th><th>Net Exp.</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td></td><td></td><td>PAVE</td><td>U.S. Infrastructure Development ETF</td><td>$53.46</td><td>$13,532,865,123</td><td>0.47%</td><td>--</td><td>Fact Sheet</td><td>10.00</td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td>Mar 06 2017</td>
      </tr>
    </tbody>
  </table>`;
  const funds = parseGlobalXLineup(html);
  expect(funds.length).toBe(0);
});

test('parseGlobalXHoldingsCsv', () => {
  const csv = `Global X U.S. Infrastructure Development ETF
Fund Holdings Data as of 09/25/2026
% of Net Assets,Ticker,Name,SEDOL,Market Price ($),Shares Held,Market Value ($)
3.65,DE,DEERE & CO,2261203,690.46,"714,766.00","493,517,332.36"`;
  
  const parsed = parseGlobalXHoldingsCsv(csv);
  expect(parsed.asOfDate).toBe('2026-09-25');
  expect(parsed.rows.length).toBe(1);
  expect(parsed.rows[0].Ticker).toBe('DE');
  expect(parsed.rows[0].Name).toBe('DEERE & CO');
  expect(parsed.rows[0]['Weight (%)']).toBe('3.65');
  expect(parsed.rows[0]["Market Value"]).toBe("493,517,332.36");
});
