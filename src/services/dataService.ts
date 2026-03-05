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
import http from "http";
import https from "https";

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
let _consecutive429Count = 0;

const MAX_RETRIES = Math.max(1, parseInt(process.env.YAHOO_MAX_RETRIES || "3", 10));
const REQUEST_TIMEOUT_MS = Math.max(5000, parseInt(process.env.YAHOO_REQUEST_TIMEOUT_MS || "15000", 10));
const INTER_REQUEST_DELAY_MIN_MS = Math.max(100, parseInt(process.env.INTER_REQUEST_DELAY_MIN_MS || "3000", 10));
const INTER_REQUEST_DELAY_MAX_MS = Math.max(INTER_REQUEST_DELAY_MIN_MS, parseInt(process.env.INTER_REQUEST_DELAY_MAX_MS || "5000", 10));
const BATCH_DELAY_MIN_MS = Math.max(200, parseInt(process.env.BATCH_DELAY_MIN_MS || "10000", 10));
const BATCH_DELAY_MAX_MS = Math.max(BATCH_DELAY_MIN_MS, parseInt(process.env.BATCH_DELAY_MAX_MS || "15000", 10));
// Max penalty cap per request from accumulated 429s (prevents death spiral)
const MAX_RATE_LIMIT_PENALTY_MS = Math.max(5000, parseInt(process.env.MAX_RATE_LIMIT_PENALTY_MS || "15000", 10));
const IDX_STOCK_LIST_URL = process.env.IDX_STOCK_LIST_URL || "https://www.idx.co.id/primary/StockData/GetSecuritiesStock?start=0&length=9999&code=&sector=&board=&language=id";
const MIN_REMOTE_TICKER_THRESHOLD = Math.max(50, parseInt(process.env.MIN_REMOTE_TICKER_THRESHOLD || "200", 10));
const EXCLUDED_BOARDS = (process.env.EXCLUDED_BOARDS || "Watchlist").split(",").map((b) => b.trim().toLowerCase());

const axiosClient = axios.create({
  timeout: REQUEST_TIMEOUT_MS,
  httpAgent: new http.Agent({ keepAlive: true, maxSockets: 10 }),
  httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 10 }),
});

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

function normalizeTickerSymbols(symbols: string[]): string[] {
  const normalized = symbols
    .map((item) =>
      String(item || "")
        .trim()
        .toUpperCase(),
    )
    .filter((item) => /^[A-Z0-9]{2,8}$/.test(item))
    .map((item) => `${item}.JK`);

  return Array.from(new Set(normalized));
}

function parseTickersFromHtml(html: string): string[] {
  const symbols: string[] = [];
  const tdMatches = html.matchAll(/<td[^>]*>\s*([A-Z0-9]{2,8})\s*<\/td>/gi);
  for (const match of tdMatches) {
    symbols.push(match[1]);
  }

  if (symbols.length === 0) {
    const looseMatches = html.matchAll(/\b([A-Z0-9]{2,8})\b/g);
    for (const match of looseMatches) {
      symbols.push(match[1]);
    }
  }

  return normalizeTickerSymbols(symbols);
}

function parseTickersFromCsv(csv: string): string[] {
  const lines = csv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const symbols: string[] = [];

  for (const line of lines) {
    const cols = line.split(",");
    const firstCol = (cols[0] || "").replace(/"/g, "").trim().toUpperCase();
    if (/^[A-Z0-9]{2,8}$/.test(firstCol) && firstCol !== "CODE" && firstCol !== "KODE") {
      symbols.push(firstCol);
      continue;
    }

    const regexMatch = line.match(/\b([A-Z0-9]{2,8})\b/);
    if (regexMatch) {
      symbols.push(regexMatch[1]);
    }
  }

  return normalizeTickerSymbols(symbols);
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

async function fetchFromYahooEndpoint(baseUrl: string, ticker: string, period: string, interval: string): Promise<CandleData[]> {
  const now = Math.floor(Date.now() / 1000);
  const periodSec = getPeriodSeconds(period);
  const period1 = now - periodSec;

  const response = await axiosClient.get(`${baseUrl}/${ticker}`, {
    params: {
      period1,
      period2: now,
      interval,
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

  return candles;
}

export async function fetchHistoricalData(ticker: string, period: string = "6mo", interval: string = "1d", retries: number = MAX_RETRIES): Promise<CandleData[]> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      requestCount++;
      const baseUrl = getYahooUrl();
      const candles = await fetchFromYahooEndpoint(baseUrl, ticker, period, interval);

      logger.debug(MODULE, `Fetched ${candles.length} candles for ${ticker} (${interval})`);
      _fetchSummary.success++;
      _consecutive429Count = Math.max(0, _consecutive429Count - 1); // cool down on success
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
        _consecutive429Count++;
        // Moderate backoff: 8-15s per attempt, no death spiral
        const backoff = 8000 + attempt * 3000 + Math.random() * 4000;
        logger.warn(MODULE, `Rate limited on ${ticker}. Retrying in ${Math.round(backoff / 1000)}s (attempt ${attempt}/${retries}, consecutive429: ${_consecutive429Count})`);

        if (attempt === retries) {
          const alternateUrl = getYahooUrl() === YAHOO_CHART_URL ? YAHOO_CHART_URL_2 : YAHOO_CHART_URL;
          try {
            const fallbackCandles = await fetchFromYahooEndpoint(alternateUrl, ticker, period, interval);
            if (fallbackCandles.length > 0) {
              logger.debug(MODULE, `Last-chance alternate endpoint succeeded for ${ticker} (${fallbackCandles.length} candles)`);
              _fetchSummary.success++;
              return fallbackCandles;
            }
          } catch {
            // continue to mark as failed
          }

          if (!_fetchSummary.rateLimited.includes(ticker)) {
            _fetchSummary.rateLimited.push(ticker);
          }
          _fetchSummary.failed++;
          return [];
        }

        await delay(backoff);
      } else if (attempt < retries) {
        const backoff = attempt * 1000 + Math.random() * 700;
        logger.warn(MODULE, `Error fetching ${ticker}: ${error.message}. Retrying in ${backoff}ms (attempt ${attempt}/${retries})`);
        await delay(backoff);
      } else {
        const alternateUrl = getYahooUrl() === YAHOO_CHART_URL ? YAHOO_CHART_URL_2 : YAHOO_CHART_URL;
        try {
          const fallbackCandles = await fetchFromYahooEndpoint(alternateUrl, ticker, period, interval);
          if (fallbackCandles.length > 0) {
            logger.debug(MODULE, `Last-chance alternate endpoint succeeded for ${ticker} (${fallbackCandles.length} candles)`);
            _fetchSummary.success++;
            return fallbackCandles;
          }
        } catch {
          // continue to final failure handling
        }

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
      // Base delay + capped penalty from 429s (prevents death spiral)
      const perRequestDelay = INTER_REQUEST_DELAY_MIN_MS + Math.random() * Math.max(0, INTER_REQUEST_DELAY_MAX_MS - INTER_REQUEST_DELAY_MIN_MS);
      const rawPenalty = _consecutive429Count > 0 ? Math.min(_consecutive429Count * 1000, MAX_RATE_LIMIT_PENALTY_MS) : 0;
      await delay(perRequestDelay + rawPenalty);
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
  const requestedBatchSize = config.batch.size;
  const requestedConcurrency = config.batch.concurrencyLimit;

  let batchSize = requestedBatchSize;
  let concurrencyLimit = requestedConcurrency;

  const adaptiveEnabled = process.env.ADAPTIVE_BATCHING !== "false";
  let dynamicBatchDelayMin = BATCH_DELAY_MIN_MS;
  let dynamicBatchDelayMax = BATCH_DELAY_MAX_MS;

  if (adaptiveEnabled) {
    // Simpler adaptive: just ensure sane defaults
    batchSize = Math.min(batchSize, 15);
    concurrencyLimit = 1; // Always sequential to avoid rate limits

    if (interval === "1h") {
      batchSize = Math.min(batchSize, 10);
    }

    batchSize = Math.max(5, batchSize);
  }

  const allResults: TickerData[] = [];

  // resetFetchSummary() is now called by SignalService at the start of the entire scan process
  logger.info(MODULE, `Starting fetch for ${tickers.length} tickers (interval: ${interval}, period: ${period}, batchSize: ${batchSize}, concurrency: ${concurrencyLimit}, adaptive: ${adaptiveEnabled ? "on" : "off"})`);

  for (let i = 0; i < tickers.length; i += batchSize) {
    const batch = tickers.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(tickers.length / batchSize);

    logger.info(MODULE, `Processing batch ${batchNum}/${totalBatches} (${batch.length} tickers)`);

    // Reset consecutive 429 counter each batch to prevent death spiral
    _consecutive429Count = Math.max(0, Math.floor(_consecutive429Count / 2));

    const batchResults = await processBatch(batch, interval, period, concurrencyLimit);
    allResults.push(...batchResults);

    // Pause between batches
    if (i + batchSize < tickers.length) {
      const batchDelay = dynamicBatchDelayMin + Math.random() * Math.max(0, dynamicBatchDelayMax - dynamicBatchDelayMin);
      logger.info(MODULE, `Batch ${batchNum}/${totalBatches} done. Waiting ${Math.round(batchDelay / 1000)}s before next batch...`);
      await delay(batchDelay);
    }
  }

  logger.info(MODULE, `Finished fetching. Got data for ${allResults.length}/${tickers.length} tickers.`);

  return allResults;
}

/**
 * Parse IDX JSON API response: { data: [{ Code, Name, ListingBoard, ... }] }
 */
function parseTickersFromIdxJson(data: any): string[] {
  if (!data || !Array.isArray(data.data)) return [];
  const tickers: string[] = [];
  let excludedCount = 0;

  for (const item of data.data) {
    const code = String(item.Code || "")
      .trim()
      .toUpperCase();
    const board = String(item.ListingBoard || "")
      .trim()
      .toLowerCase();

    if (!code || code.length < 2 || code.length > 8) continue;
    if (!/^[A-Z0-9]+$/.test(code)) continue;

    // Skip stocks on excluded boards (e.g., Watchlist = suspended/problematic)
    if (EXCLUDED_BOARDS.includes(board)) {
      excludedCount++;
      continue;
    }

    tickers.push(`${code}.JK`);
  }

  if (excludedCount > 0) {
    logger.info(MODULE, `Filtered out ${excludedCount} stocks on excluded boards (${EXCLUDED_BOARDS.join(", ")}).`);
  }

  return Array.from(new Set(tickers));
}

/**
 * Fetch all IDX-listed stock tickers from idx.co.id API.
 * Falls back to local tickers_full.json if API fails.
 */
export async function updateTickerList(): Promise<string[]> {
  try {
    logger.info(MODULE, `Fetching ticker universe from IDX API: ${IDX_STOCK_LIST_URL}`);
    const response = await axiosClient.get(IDX_STOCK_LIST_URL, {
      headers: {
        "User-Agent": getRandomUserAgent(),
        Accept: "application/json,text/html,*/*",
        "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8",
        Referer: "https://www.idx.co.id/",
      },
      timeout: 30000,
    });

    let tickers: string[] = [];
    const data = response.data;

    // IDX API returns JSON: { recordsTotal, data: [...] }
    if (data && typeof data === "object" && Array.isArray(data.data)) {
      tickers = parseTickersFromIdxJson(data);
      logger.info(MODULE, `IDX API returned ${data.recordsTotal || data.data.length} total, parsed ${tickers.length} valid tickers.`);
    } else {
      // Fallback: try HTML/CSV parsing
      const contentType = String(response.headers["content-type"] || "").toLowerCase();
      const raw = typeof data === "string" ? data : JSON.stringify(data || "");
      if (contentType.includes("csv") || /,/.test(raw.slice(0, 1000))) {
        tickers = parseTickersFromCsv(raw);
      } else {
        tickers = parseTickersFromHtml(raw);
      }
    }

    if (tickers.length < MIN_REMOTE_TICKER_THRESHOLD) {
      logger.warn(MODULE, `Remote ticker fetch returned only ${tickers.length} symbols (<${MIN_REMOTE_TICKER_THRESHOLD}). Will fallback to static ticker list.`);
      return [];
    }

    logger.info(MODULE, `Remote ticker universe loaded: ${tickers.length} ticker(s).`);
    return tickers;
  } catch (error: any) {
    logger.warn(MODULE, `Failed to auto-update tickers from IDX API: ${error.message}`);
    // Fallback to local full list
    try {
      const fs = await import("fs");
      const path = await import("path");
      const fullListPath = path.resolve(process.cwd(), "src/config/tickers_full.json");
      if (fs.existsSync(fullListPath)) {
        const localTickers = JSON.parse(fs.readFileSync(fullListPath, "utf-8"));
        if (Array.isArray(localTickers) && localTickers.length > 0) {
          logger.info(MODULE, `Loaded ${localTickers.length} tickers from local tickers_full.json fallback.`);
          return localTickers;
        }
      }
    } catch (fsError: any) {
      logger.warn(MODULE, `Failed to load local tickers_full.json fallback: ${fsError.message}`);
    }
    return [];
  }
}

export default {
  fetchHistoricalData,
  fetchAllTickers,
  updateTickerList,
};
