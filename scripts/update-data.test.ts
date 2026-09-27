import { describe, expect, test } from "bun:test";
import {
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
  sanitizeTicker,
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
    expect(readConfig({}).requestSleep).toBe(1.5);
    expect(readConfig({}).concurrency).toBe(2);
    expect(readConfig({ TICKERS: "pave, AIQ" }).tickers).toEqual(["PAVE", "AIQ"]);
  });
});
