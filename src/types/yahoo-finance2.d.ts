declare module "yahoo-finance2" {
  interface SearchResult {
    news?: Array<{ title?: string; link?: string; [key: string]: any }>;
    [key: string]: any;
  }

  interface QuoteSummaryResult {
    assetProfile?: {
      longBusinessSummary?: string;
      [key: string]: any;
    };
    [key: string]: any;
  }

  interface YahooFinance {
    search(query: string, options?: { newsCount?: number; [key: string]: any }): Promise<SearchResult>;

    quoteSummary(ticker: string, options?: { modules?: string[]; [key: string]: any }): Promise<QuoteSummaryResult>;
  }

  const yahooFinance: YahooFinance;
  export default yahooFinance;
}
