import { describe, expect, test } from "bun:test";
import {
  parseGlobalXLineup,
  parseGlobalXHoldingsCsv,
  parseHtmlTables,
  cleanText
} from "./update-data.ts";

describe("GlobalX parser", () => {
  test("parseGlobalXLineup", () => {
    const html = `
      <table>
        <tr>
          <td></td><td></td><td>Ticker</td><td>ETF Name</td><td>NAV</td><td>Net Assets</td><td>Gross Exp.</td><td>Net Exp.</td><td>Fact Sheet</td><td>YTD</td><td>1 MO</td>
        </tr>
        <tr>
          <td></td><td></td><td>PAVE</td><td>U.S. Infrastructure Development ETF</td><td>$53.46</td><td>$13,532,865,123</td><td>0.47%</td><td>--</td><td>Fact Sheet</td><td>10.00</td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td>Mar 06 2017</td>
        </tr>
      </table>
    `;
    const funds = parseGlobalXLineup(html);
    expect(funds.length).toBe(1);
    expect(funds[0].ticker).toBe("PAVE");
    expect(funds[0].name).toBe("U.S. Infrastructure Development ETF");
    expect(funds[0].managementFee).toBe(0.47);
    expect(funds[0].netAssets).toBe(13532865123);
    expect(funds[0].inceptionDate).toBe("2017-03-06");
  });

  test("parseGlobalXHoldingsCsv", () => {
    const csv = `Global X U.S. Infrastructure Development ETF
Fund Holdings Data as of 09/25/2026
% of Net Assets,Ticker,Name,SEDOL,Market Price ($),Shares Held,Market Value ($)
3.65,DE,DEERE & CO,2261203,690.46,"714,766.00","493,517,332.36"`;

    const parsed = parseGlobalXHoldingsCsv(csv);
    expect(parsed.asOfDate).toBe("2026-09-25");
    expect(parsed.rows.length).toBe(1);
    expect(parsed.rows[0].Ticker).toBe("DE");
    expect(parsed.rows[0].Name).toBe("DEERE & CO");
    expect(parsed.rows[0]["Weight (%)"]).toBe("3.65");
    expect(parsed.rows[0]["Market Value"]).toBe("493,517,332.36");
  });
});
