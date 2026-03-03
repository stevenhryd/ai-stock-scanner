/**
 * Data Service
 *
 * Responsible for fetching historical stock data from Yahoo Finance.
 * Uses the Yahoo Finance chart API directly via axios for reliability.
 * Supports batched fetching with concurrency limiting and retry logic.
 */

import axios from "axios";
import config from "../config/index.js";
import logger from "../utils/logger.js";

const MODULE = "DataService";

const YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart";
const YAHOO_CHART_URL_2 = "https://query2.finance.yahoo.com/v8/finance/chart";

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
];

let requestCount = 0;

function getRandomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function getYahooUrl(): string {
  // Alternate between query1 and query2 to spread load
  return requestCount % 2 === 0 ? YAHOO_CHART_URL : YAHOO_CHART_URL_2;
}

export interface CandleData {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TickerData {
  ticker: string;
  candles: CandleData[];
}

export interface FetchSummary {
  success: number;
  failed: number;
  rateLimited: string[];
  notFound: string[];
  otherErrors: string[];
}

/**
 * Delay utility for backoff.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculate period in seconds for Yahoo Finance range.
 */
function getPeriodSeconds(period: string): number {
  switch (period) {
    case "1mo":
      return 30 * 24 * 3600;
    case "3mo":
      return 90 * 24 * 3600;
    case "6mo":
      return 180 * 24 * 3600;
    case "1y":
      return 365 * 24 * 3600;
    default:
      return 180 * 24 * 3600;
  }
}

/**
 * Fetch historical data for a single ticker using Yahoo Finance chart API.
 *
 * @param ticker - Stock ticker (e.g., "BBRI.JK")
 * @param period - Lookback period (e.g., "6mo", "1y")
 * @param interval - Candle interval (e.g., "1d", "1h")
 * @param retries - Number of retry attempts
 */
// Global error tracker reset per scan session
let _fetchSummary: FetchSummary = { success: 0, failed: 0, rateLimited: [], notFound: [], otherErrors: [] };

export function resetFetchSummary(): void {
  _fetchSummary = { success: 0, failed: 0, rateLimited: [], notFound: [], otherErrors: [] };
}

export function getFetchSummary(): FetchSummary {
  return { ..._fetchSummary };
}

export async function fetchHistoricalData(ticker: string, period: string = "6mo", interval: string = "1d", retries: number = 3): Promise<CandleData[]> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const now = Math.floor(Date.now() / 1000);
      const periodSec = getPeriodSeconds(period);
      const period1 = now - periodSec;

      requestCount++;
      const baseUrl = getYahooUrl();
      const response = await axios.get(`${baseUrl}/${ticker}`, {
        params: {
          period1: period1,
          period2: now,
          interval: interval,
          includePrePost: false,
          events: "",
        },
        headers: {
          "User-Agent": getRandomUserAgent(),
          Accept: "application/json",
          "Accept-Language": "en-US,en;q=0.9",
          "Accept-Encoding": "gzip, deflate, br",
          Referer: "https://finance.yahoo.com/",
          Origin: "https://finance.yahoo.com",
        },
        timeout: 20000,
      });

      const result = response.data?.chart?.result?.[0];
      if (!result || !result.timestamp || !result.indicators?.quote?.[0]) {
        logger.warn(MODULE, `No data returned for ${ticker}`);
        return [];
      }

      const timestamps: number[] = result.timestamp;
      const quote = result.indicators.quote[0];
      const opens: (number | null)[] = quote.open;
      const highs: (number | null)[] = quote.high;
      const lows: (number | null)[] = quote.low;
      const closes: (number | null)[] = quote.close;
      const volumes: (number | null)[] = quote.volume;

      const candles: CandleData[] = [];
      for (let i = 0; i < timestamps.length; i++) {
        if (opens[i] !== null && highs[i] !== null && lows[i] !== null && closes[i] !== null && volumes[i] !== null) {
          candles.push({
            date: new Date(timestamps[i] * 1000),
            open: opens[i]!,
            high: highs[i]!,
            low: lows[i]!,
            close: closes[i]!,
            volume: volumes[i]!,
          });
        }
      }

      logger.debug(MODULE, `Fetched ${candles.length} candles for ${ticker} (${interval})`);
      _fetchSummary.success++;
      return candles;
    } catch (error: any) {
      const statusCode = error.response?.status;
      const isRateLimit = statusCode === 429;
      const isNotFound = statusCode === 404;

      if (isNotFound) {
        logger.warn(MODULE, `Ticker ${ticker} not found (404). Skipping.`);
        if (!_fetchSummary.notFound.includes(ticker)) _fetchSummary.notFound.push(ticker);
        _fetchSummary.failed++;
        return [];
      }

      if (isRateLimit) {
        const backoff = Math.pow(2, attempt) * 5000 + Math.random() * 3000;
        logger.warn(MODULE, `Rate limited on ${ticker}. Retrying in ${Math.round(backoff)}ms (attempt ${attempt}/${retries})`);
        if (attempt === retries) {
          if (!_fetchSummary.rateLimited.includes(ticker)) _fetchSummary.rateLimited.push(ticker);
          _fetchSummary.failed++;
        }
        await delay(backoff);
      } else if (attempt < retries) {
        const backoff = attempt * 2000 + Math.random() * 1000;
        logger.warn(MODULE, `Error fetching ${ticker}: ${error.message}. Retrying in ${backoff}ms (attempt ${attempt}/${retries})`);
        await delay(backoff);
      } else {
        logger.error(MODULE, `Failed to fetch ${ticker} after ${retries} attempts: ${error.message}`);
        if (!_fetchSummary.otherErrors.includes(ticker)) _fetchSummary.otherErrors.push(ticker);
        _fetchSummary.failed++;
        return [];
      }
    }
  }

  return [];
}

/**
 * Process a batch of tickers with concurrency limiting.
 */
async function processBatch(tickers: string[], interval: string, period: string, concurrencyLimit: number): Promise<TickerData[]> {
  const results: TickerData[] = [];

  // Dynamic import for ESM module
  const pLimit = (await import("p-limit")).default;
  const limit = pLimit(concurrencyLimit);

  const tasks = tickers.map((ticker) =>
    limit(async () => {
      const candles = await fetchHistoricalData(ticker, period, interval);
      // Small delay after each request to avoid rate limiting (concurrency is already 1)
      await delay(1500 + Math.random() * 1000);
      if (candles.length > 0) {
        results.push({ ticker, candles });
      }
    }),
  );

  await Promise.all(tasks);
  return results;
}

/**
 * Fetch data for all tickers, processing in batches with concurrency limits.
 *
 * @param tickers - Array of stock tickers
 * @param interval - Candle interval
 * @param period - Lookback period
 */
export async function fetchAllTickers(tickers: string[], interval: string = "1d", period: string = "6mo"): Promise<TickerData[]> {
  const batchSize = config.batch.size;
  const concurrencyLimit = config.batch.concurrencyLimit;
  const allResults: TickerData[] = [];

  resetFetchSummary();
  logger.info(MODULE, `Starting fetch for ${tickers.length} tickers (interval: ${interval}, period: ${period}, batchSize: ${batchSize})`);

  for (let i = 0; i < tickers.length; i += batchSize) {
    const batch = tickers.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(tickers.length / batchSize);

    logger.info(MODULE, `Processing batch ${batchNum}/${totalBatches} (${batch.length} tickers)`);

    const batchResults = await processBatch(batch, interval, period, concurrencyLimit);
    allResults.push(...batchResults);

    // Pause between batches
    if (i + batchSize < tickers.length) {
      const batchDelay = 10000 + Math.random() * 5000;
      logger.info(MODULE, `Batch ${batchNum}/${totalBatches} done. Waiting ${Math.round(batchDelay / 1000)}s before next batch...`);
      await delay(batchDelay);
    }
  }

  logger.info(MODULE, `Finished fetching. Got data for ${allResults.length}/${tickers.length} tickers.`);

  return allResults;
}

/**
 * Placeholder for auto-updating ticker list.
 */
export async function updateTickerList(): Promise<string[]> {
  logger.info(MODULE, "Ticker auto-update is not yet implemented. Using static list.");
  return [];
}

export default {
  fetchHistoricalData,
  fetchAllTickers,
  updateTickerList,
};
