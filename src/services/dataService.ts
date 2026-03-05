/**
 * Data Service
 *
 * Responsible for fetching historical stock data from Yahoo Finance.
 * Uses the Yahoo Finance chart API directly via axios for reliability.
 * Supports batched fetching with concurrency limiting and retry logic.
 */

import axios from "axios";
import fs from "fs";
import path from "path";
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

const MAX_RETRIES = Math.max(1, parseInt(process.env.YAHOO_MAX_RETRIES || "2", 10));
const REQUEST_TIMEOUT_MS = Math.max(5000, parseInt(process.env.YAHOO_REQUEST_TIMEOUT_MS || "15000", 10));
const INTER_REQUEST_DELAY_MIN_MS = Math.max(100, parseInt(process.env.INTER_REQUEST_DELAY_MIN_MS || "6000", 10));
const INTER_REQUEST_DELAY_MAX_MS = Math.max(INTER_REQUEST_DELAY_MIN_MS, parseInt(process.env.INTER_REQUEST_DELAY_MAX_MS || "10000", 10));
const BATCH_DELAY_MIN_MS = Math.max(200, parseInt(process.env.BATCH_DELAY_MIN_MS || "10000", 10));
const BATCH_DELAY_MAX_MS = Math.max(BATCH_DELAY_MIN_MS, parseInt(process.env.BATCH_DELAY_MAX_MS || "18000", 10));
// Max penalty cap per request from accumulated 429s (prevents death spiral)
const MAX_RATE_LIMIT_PENALTY_MS = Math.max(5000, parseInt(process.env.MAX_RATE_LIMIT_PENALTY_MS || "15000", 10));
const TOP_TICKERS_LIMIT = Math.max(50, parseInt(process.env.TOP_TICKERS_LIMIT || "300", 10));
const QUOTE_BATCH_SIZE = Math.max(10, parseInt(process.env.QUOTE_BATCH_SIZE || "30", 10));
const YAHOO_QUOTE_URL = "https://query1.finance.yahoo.com/v7/finance/quote";
const YAHOO_QUOTE_URL_2 = "https://query2.finance.yahoo.com/v7/finance/quote";
const IDX_STOCK_LIST_URL = process.env.IDX_STOCK_LIST_URL || "https://www.idx.co.id/primary/StockData/GetSecuritiesStock?start=0&length=9999&code=&sector=&board=&language=id";
const MIN_REMOTE_TICKER_THRESHOLD = Math.max(50, parseInt(process.env.MIN_REMOTE_TICKER_THRESHOLD || "200", 10));
const EXCLUDED_BOARDS = (process.env.EXCLUDED_BOARDS || "Watchlist").split(",").map((b) => b.trim().toLowerCase());

/**
 * Make a Yahoo Finance API request using a fresh connection each time.
 * Using axios.create() or persistent clients causes Yahoo to fingerprint and block.
 */
async function yahooGet(url: string, params: Record<string, any>, extraHeaders?: Record<string, string>) {
  return axios.get(url, {
    params,
    headers: {
      ...getYahooAuthHeaders(),
      ...extraHeaders,
    },
    timeout: REQUEST_TIMEOUT_MS,
    // Fresh agent per request — no connection reuse
    httpAgent: new http.Agent({ keepAlive: false }),
    httpsAgent: new https.Agent({ keepAlive: false }),
  });
}

function getRandomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function getYahooUrl(): string {
  // Alternate between query1 and query2 to spread load
  return requestCount % 2 === 0 ? YAHOO_CHART_URL : YAHOO_CHART_URL_2;
}

// ─── Yahoo Finance Cookie + Crumb Authentication ───────────────────────
// Yahoo Finance requires a crumb token (obtained via cookies) for all API calls.
// Without it, requests are rejected with 429/401 immediately.

let _yahooCrumb: string | null = null;
let _yahooCookies: string = "";
let _crumbFetchedAt: number = 0;
const CRUMB_MAX_AGE_MS = 30 * 60 * 1000; // Refresh crumb every 30 minutes

/**
 * Obtain Yahoo Finance authentication cookies and crumb token.
 * Flow:
 *   1. GET https://fc.yahoo.com/ → receives Set-Cookie headers
 *   2. Use cookies to GET https://query2.finance.yahoo.com/v1/test/getcrumb → returns crumb string
 */
async function refreshYahooCrumb(): Promise<boolean> {
  const ua = getRandomUserAgent();

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      logger.info(MODULE, `🔑 Fetching Yahoo crumb (attempt ${attempt}/3)...`);

      // Step 1: Get cookies from fc.yahoo.com
      const cookieResponse = await axios.get("https://fc.yahoo.com/", {
        headers: { "User-Agent": ua },
        maxRedirects: 5,
        timeout: 15000,
        validateStatus: () => true, // Accept any status
      });

      // Extract Set-Cookie headers
      const setCookieHeaders = cookieResponse.headers["set-cookie"];
      if (!setCookieHeaders || setCookieHeaders.length === 0) {
        logger.warn(MODULE, `No cookies received (attempt ${attempt})`);
        if (attempt < 3) {
          await delay(3000);
          continue;
        }
        return false;
      }

      // Parse cookie name=value pairs
      const cookies = setCookieHeaders
        .map((c: string) => c.split(";")[0].trim())
        .filter((c: string) => c.length > 0)
        .join("; ");

      // Step 2: Get crumb using cookies
      const crumbResponse = await axios.get("https://query2.finance.yahoo.com/v1/test/getcrumb", {
        headers: {
          "User-Agent": ua,
          Cookie: cookies,
          Accept: "text/plain",
        },
        timeout: 15000,
      });

      const crumb = String(crumbResponse.data || "").trim();
      if (!crumb || crumb.length < 5) {
        logger.warn(MODULE, `Invalid crumb received: "${crumb}" (attempt ${attempt})`);
        if (attempt < 3) {
          await delay(3000);
          continue;
        }
        return false;
      }

      _yahooCrumb = crumb;
      _yahooCookies = cookies;
      _crumbFetchedAt = Date.now();

      logger.info(MODULE, `✅ Yahoo crumb obtained successfully (${crumb.substring(0, 8)}...)`);
      return true;
    } catch (error: any) {
      logger.warn(MODULE, `Crumb fetch failed (attempt ${attempt}): ${error.message}`);
      if (attempt < 3) await delay(5000);
    }
  }

  logger.error(MODULE, "❌ Could not obtain Yahoo crumb after 3 attempts.");
  return false;
}

/**
 * Ensure we have a valid crumb. Refreshes if expired or not yet fetched.
 */
async function ensureCrumb(): Promise<void> {
  const age = Date.now() - _crumbFetchedAt;
  if (!_yahooCrumb || age > CRUMB_MAX_AGE_MS) {
    await refreshYahooCrumb();
  }
}

/**
 * Public function to initialize Yahoo session before scanning.
 * Call this once at the start of a scan to pre-authenticate.
 * Non-blocking: crumb is optional for chart endpoint (uses range= param).
 */
export async function initYahooSession(): Promise<boolean> {
  logger.info(MODULE, "Initializing Yahoo Finance session...");
  const ok = await refreshYahooCrumb();
  if (!ok) {
    logger.warn(MODULE, "⚠️ Crumb not available. Chart endpoint will still work with range= param. Quote pre-screen may be limited.");
  }
  return ok;
}

/**
 * Probe Yahoo rate limit status by making a single lightweight request.
 * Returns true if Yahoo is responding normally, false if rate-limited.
 * If rate-limited, waits and retries up to maxRetries times.
 */
export async function probeRateLimit(maxRetries: number = 3): Promise<boolean> {
  const testTicker = "BBRI.JK";
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios.get(`${YAHOO_CHART_URL}/${testTicker}`, {
        params: { range: "5d", interval: "1d" },
        headers: { "User-Agent": getRandomUserAgent(), Accept: "application/json" },
        timeout: 10000,
        httpAgent: new http.Agent({ keepAlive: false }),
        httpsAgent: new https.Agent({ keepAlive: false }),
      });
      if (response.data?.chart?.result?.[0]) {
        logger.info(MODULE, `✅ Rate limit probe OK (attempt ${attempt})`);
        return true;
      }
    } catch (error: any) {
      const status = error.response?.status;
      if (status === 429) {
        const waitSec = attempt * 60;
        logger.warn(MODULE, `⚠️ Rate limit probe: 429 (attempt ${attempt}/${maxRetries}). Waiting ${waitSec}s...`);
        await delay(waitSec * 1000);
      } else {
        logger.warn(MODULE, `Rate limit probe error: ${status || error.message}`);
        return true; // Non-429 error means we're not rate-limited
      }
    }
  }
  logger.error(MODULE, `❌ Yahoo is still rate-limiting after ${maxRetries} probes. Scan may have limited results.`);
  return false;
}

/**
 * Get auth headers + params for Yahoo requests.
 */
function getYahooAuthHeaders(): Record<string, string> {
  return {
    "User-Agent": getRandomUserAgent(),
    Accept: "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    Referer: "https://finance.yahoo.com/",
    Origin: "https://finance.yahoo.com",
    ...(_yahooCookies ? { Cookie: _yahooCookies } : {}),
  };
}

function getCrumbParam(): Record<string, string> {
  return _yahooCrumb ? { crumb: _yahooCrumb } : {};
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
  // Chart API with 'range' param does NOT need crumb — keep it simple.
  // Using cookies/crumb on chart requests can actually reduce rate limits (per-session throttling).
  const response = await axios.get(`${baseUrl}/${ticker}`, {
    params: {
      range: period,
      interval,
      includePrePost: false,
      events: "",
    },
    headers: {
      "User-Agent": getRandomUserAgent(),
      Accept: "application/json",
    },
    timeout: REQUEST_TIMEOUT_MS,
    httpAgent: new http.Agent({ keepAlive: false }),
    httpsAgent: new https.Agent({ keepAlive: false }),
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
  // FAIL FAST strategy: query1 and query2 share the same rate limit backend.
  // On 429, don't retry alternate endpoint — it wastes 30-60s and also fails.
  // Instead, skip immediately and let the retry queue at the end handle it.
  const url = getYahooUrl();

  try {
    requestCount++;
    const candles = await fetchFromYahooEndpoint(url, ticker, period, interval);

    logger.debug(MODULE, `Fetched ${candles.length} candles for ${ticker} (${interval})`);
    _fetchSummary.success++;
    _consecutive429Count = Math.max(0, _consecutive429Count - 1);
    return candles;
  } catch (error: any) {
    const statusCode = error.response?.status;

    if (statusCode === 404) {
      logger.warn(MODULE, `Ticker ${ticker} not found (404). Skipping.`);
      if (!_fetchSummary.notFound.includes(ticker)) _fetchSummary.notFound.push(ticker);
      _fetchSummary.failed++;
      return [];
    }

    if (statusCode === 429) {
      _consecutive429Count++;
      logger.warn(MODULE, `429 on ${ticker}. Queued for retry. (consecutive429: ${_consecutive429Count})`);
      if (!_fetchSummary.rateLimited.includes(ticker)) _fetchSummary.rateLimited.push(ticker);
      _fetchSummary.failed++;
      return [];
    }

    // Non-429 error: try alternate endpoint once
    const altUrl = url === YAHOO_CHART_URL ? YAHOO_CHART_URL_2 : YAHOO_CHART_URL;
    try {
      requestCount++;
      const candles = await fetchFromYahooEndpoint(altUrl, ticker, period, interval);
      logger.debug(MODULE, `Fetched ${candles.length} candles for ${ticker} via alternate (${interval})`);
      _fetchSummary.success++;
      return candles;
    } catch {
      logger.error(MODULE, `Failed to fetch ${ticker}: ${error.message}`);
      if (!_fetchSummary.otherErrors.includes(ticker)) _fetchSummary.otherErrors.push(ticker);
      _fetchSummary.failed++;
      return [];
    }
  }
}

/**
 * Process a batch of tickers with concurrency limiting.
 */
async function processBatch(tickers: string[], interval: string, period: string, concurrencyLimit: number): Promise<TickerData[]> {
  const results: TickerData[] = [];

  // Sequential processing — no concurrency to avoid rate limits
  for (const ticker of tickers) {
    const candles = await fetchHistoricalData(ticker, period, interval);
    if (candles.length > 0) {
      results.push({ ticker, candles });
      // Successful: moderate delay
      const perRequestDelay = INTER_REQUEST_DELAY_MIN_MS + Math.random() * (INTER_REQUEST_DELAY_MAX_MS - INTER_REQUEST_DELAY_MIN_MS);
      await delay(perRequestDelay);
    } else {
      // Failed (429 or error): shorter delay since fetchHistoricalData already returned fast
      // But add cooldown if many 429s to let Yahoo recover
      const cooldown = _consecutive429Count >= 3 ? 15000 + _consecutive429Count * 2000 : 3000;
      await delay(cooldown);
    }
  }

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

  if (adaptiveEnabled) {
    // Conservative batching to avoid Yahoo rate limits
    batchSize = Math.min(batchSize, 3); // Small batches to stay under Yahoo rate limits
    concurrencyLimit = 1; // Always sequential to avoid rate limits

    if (interval === "1h") {
      batchSize = Math.min(batchSize, 3);
    }

    batchSize = Math.max(2, batchSize);
  }

  const allResults: TickerData[] = [];

  _consecutive429Count = 0;

  logger.info(MODULE, `Starting fetch for ${tickers.length} tickers (interval: ${interval}, range: ${period}, batchSize: ${batchSize}, concurrency: ${concurrencyLimit}, adaptive: ${adaptiveEnabled ? "on" : "off"})`);

  for (let i = 0; i < tickers.length; i += batchSize) {
    const batch = tickers.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(tickers.length / batchSize);

    logger.info(MODULE, `Processing batch ${batchNum}/${totalBatches} (${batch.length} tickers) [success: ${_fetchSummary.success}, failed: ${_fetchSummary.failed}]`);

    // Reset 429 counter each batch — don't carry heat forward
    _consecutive429Count = 0;

    const batchResults = await processBatch(batch, interval, period, concurrencyLimit);
    allResults.push(...batchResults);

    // Fixed batch delay — no escalation spiral
    if (i + batchSize < tickers.length) {
      const batchDelay = BATCH_DELAY_MIN_MS + Math.random() * Math.max(0, BATCH_DELAY_MAX_MS - BATCH_DELAY_MIN_MS);
      logger.info(MODULE, `Batch ${batchNum}/${totalBatches} done. Waiting ${Math.round(batchDelay / 1000)}s...`);
      await delay(batchDelay);
    }
  }

  // ── Retry failed (rate-limited) tickers with longer delays ──
  const fetchedTickers = new Set(allResults.map((r) => r.ticker));
  const failedTickers = _fetchSummary.rateLimited.filter((t) => !fetchedTickers.has(t));
  if (failedTickers.length > 0) {
    const retryCount = Math.min(failedTickers.length, 50); // Cap retries
    const retryBatch = failedTickers.slice(0, retryCount);
    logger.info(MODULE, `🔄 Retrying ${retryBatch.length}/${failedTickers.length} rate-limited tickers after 45s cooldown...`);
    _consecutive429Count = 0;
    await delay(45000);

    for (const ticker of retryBatch) {
      const candles = await fetchHistoricalData(ticker, period, interval);
      if (candles.length > 0) {
        allResults.push({ ticker, candles });
        const idx = _fetchSummary.rateLimited.indexOf(ticker);
        if (idx !== -1) {
          _fetchSummary.rateLimited.splice(idx, 1);
          _fetchSummary.failed--;
          _fetchSummary.success++;
        }
        logger.info(MODULE, `✅ Retry succeeded for ${ticker} (${candles.length} candles)`);
      }
      // Longer delay between retries
      await delay(8000 + Math.random() * 5000);
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
    const response = await axios.get(IDX_STOCK_LIST_URL, {
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

/**
 * Fetch basic quote data (price, volume, marketCap) for multiple tickers
 * in a single API call. Yahoo Finance v7 quote endpoint supports up to ~100 symbols.
 */
export interface QuoteData {
  ticker: string;
  volume: number;
  averageVolume: number;
  marketCap: number;
  price: number;
}

async function fetchQuoteBatch(tickers: string[]): Promise<QuoteData[]> {
  const symbols = tickers.join(",");
  const results: QuoteData[] = [];

  // Try v7 quote API (crumb should already be initialized in initYahooSession)
  try {
    const response = await yahooGet(YAHOO_QUOTE_URL, {
      symbols,
      fields: "regularMarketVolume,averageDailyVolume3Month,marketCap,regularMarketPrice",
      ...getCrumbParam(),
    });

    const quotes = response.data?.quoteResponse?.result;
    if (Array.isArray(quotes)) {
      for (const q of quotes) {
        const ticker = q.symbol || "";
        if (!ticker) continue;
        results.push({
          ticker,
          volume: q.regularMarketVolume || 0,
          averageVolume: q.averageDailyVolume3Month || 0,
          marketCap: q.marketCap || 0,
          price: q.regularMarketPrice || 0,
        });
      }
      if (results.length > 0) return results;
    }
  } catch (error: any) {
    const statusCode = error.response?.status;
    if (statusCode === 429) {
      // Don't fall back to spark — same IP, same rate limit. Just throw to signal failure.
      throw new Error(`429_RATE_LIMITED`);
    }
    logger.warn(MODULE, `Quote batch error (${statusCode}). Trying spark fallback...`);
  }

  // Spark fallback — only used for non-429 errors (auth issues, timeouts, etc.)
  const sparkBatchSize = 20;
  for (let i = 0; i < tickers.length; i += sparkBatchSize) {
    const sparkBatch = tickers.slice(i, i + sparkBatchSize);
    try {
      const r = await yahooGet("https://query1.finance.yahoo.com/v8/finance/spark", {
        symbols: sparkBatch.join(","),
        range: "5d",
        interval: "1d",
      });
      const sparkResults = r.data?.spark?.result || [];
      for (const sr of sparkResults) {
        const meta = sr?.response?.[0]?.meta;
        if (meta) {
          results.push({
            ticker: meta.symbol || "",
            volume: meta.regularMarketVolume || 0,
            averageVolume: meta.averageDailyVolume3Month || 0,
            marketCap: 0,
            price: meta.regularMarketPrice || 0,
          });
        }
      }
    } catch (sparkErr: any) {
      logger.warn(MODULE, `Spark fallback batch failed: ${sparkErr.message}`);
    }
    if (i + sparkBatchSize < tickers.length) {
      await delay(3000 + Math.random() * 3000);
    }
  }

  return results;
}

/**
 * Pre-screen tickers by fetching volume data in batch, then return the top N
 * most actively traded tickers. Uses Yahoo batch quote API which is much more
 * efficient (50-100 tickers per API call vs 1 per call for chart data).
 *
 * @param allTickers - Full list of ticker symbols
 * @param topN - Number of top tickers to return (default: TOP_TICKERS_LIMIT)
 * @returns Sorted array of top tickers by volume
 */
// ─── Pre-screening Cache ───────────────────────────────────────────────
const PRESCREEN_CACHE_FILE = path.resolve(process.cwd(), "prescreenCache.json");
const PRESCREEN_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

interface PrescreenCache {
  timestamp: number;
  tickers: string[];
}

function loadPrescreenCache(): PrescreenCache | null {
  try {
    if (!fs.existsSync(PRESCREEN_CACHE_FILE)) return null;
    const raw = fs.readFileSync(PRESCREEN_CACHE_FILE, "utf-8");
    const cache: PrescreenCache = JSON.parse(raw);
    const age = Date.now() - cache.timestamp;
    if (age > PRESCREEN_CACHE_MAX_AGE_MS) {
      logger.info(MODULE, `Pre-screen cache expired (${Math.round(age / 3600000)}h old). Will re-fetch.`);
      return null;
    }
    logger.info(MODULE, `📋 Loaded pre-screen cache (${cache.tickers.length} tickers, ${Math.round(age / 60000)} min old)`);
    return cache;
  } catch {
    return null;
  }
}

function savePrescreenCache(tickers: string[]): void {
  try {
    const cache: PrescreenCache = { timestamp: Date.now(), tickers };
    fs.writeFileSync(PRESCREEN_CACHE_FILE, JSON.stringify(cache, null, 2));
    logger.info(MODULE, `💾 Saved pre-screen cache (${tickers.length} tickers)`);
  } catch (err: any) {
    logger.warn(MODULE, `Failed to save pre-screen cache: ${err.message}`);
  }
}

export async function getTopTickersByVolume(allTickers: string[], topN: number = TOP_TICKERS_LIMIT): Promise<string[]> {
  // ── Check cache first ──
  const cache = loadPrescreenCache();
  if (cache && cache.tickers.length >= Math.min(topN, 50)) {
    logger.info(MODULE, `✅ Using cached pre-screening results (${cache.tickers.length} tickers). Skipping API calls.`);
    return cache.tickers.slice(0, topN);
  }

  logger.info(MODULE, `📊 Pre-screening ${allTickers.length} tickers to find top ${topN} by volume...`);

  const allQuotes: QuoteData[] = [];
  const batchSize = QUOTE_BATCH_SIZE;
  const totalBatches = Math.ceil(allTickers.length / batchSize);
  let consecutive429Failures = 0;
  const MAX_CONSECUTIVE_429 = 3; // Abort after 3 consecutive 429s

  for (let i = 0; i < allTickers.length; i += batchSize) {
    const batch = allTickers.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;

    logger.info(MODULE, `Quote batch ${batchNum}/${totalBatches} (${batch.length} tickers) [got ${allQuotes.length} so far]`);

    try {
      const quotes = await fetchQuoteBatch(batch);
      allQuotes.push(...quotes);
      consecutive429Failures = 0; // Reset on success
    } catch (error: any) {
      if (error.message === "429_RATE_LIMITED") {
        consecutive429Failures++;
        logger.warn(MODULE, `Quote batch ${batchNum} rate-limited (429 streak: ${consecutive429Failures}/${MAX_CONSECUTIVE_429})`);
        if (consecutive429Failures >= MAX_CONSECUTIVE_429) {
          logger.warn(MODULE, `🛑 Aborting pre-screening after ${MAX_CONSECUTIVE_429} consecutive 429s. Yahoo IP is rate-limited.`);
          break;
        }
        // Wait longer between 429s
        await delay(30000 + consecutive429Failures * 15000);
        continue;
      }
      logger.warn(MODULE, `Quote batch ${batchNum} failed: ${error.message}`);
    }

    // Delay between quote batches
    if (i + batchSize < allTickers.length) {
      const quoteDelay = 10000 + Math.random() * 8000;
      await delay(quoteDelay);
    }
  }

  if (allQuotes.length === 0) {
    logger.warn(MODULE, "⚠️ Could not fetch any quote data. Checking for stale cache...");
    // Try loading even expired cache as last resort
    try {
      if (fs.existsSync(PRESCREEN_CACHE_FILE)) {
        const raw = fs.readFileSync(PRESCREEN_CACHE_FILE, "utf-8");
        const staleCache: PrescreenCache = JSON.parse(raw);
        if (staleCache.tickers.length > 0) {
          const ageH = Math.round((Date.now() - staleCache.timestamp) / 3600000);
          logger.info(MODULE, `📋 Using stale cache (${staleCache.tickers.length} tickers, ${ageH}h old) as fallback.`);
          return staleCache.tickers.slice(0, topN);
        }
      }
    } catch {}
    logger.warn(MODULE, "No cache available. Using original list (truncated).");
    return allTickers.slice(0, topN);
  }

  // Sort by composite score: 60% average volume (3mo) + 40% today's volume
  const scored = allQuotes
    .filter((q) => q.price > 50) // Filter penny stocks (< Rp 50)
    .map((q) => ({
      ticker: q.ticker,
      score: q.averageVolume * 0.6 + q.volume * 0.4,
      volume: q.volume,
      avgVolume: q.averageVolume,
      marketCap: q.marketCap,
    }))
    .sort((a, b) => b.score - a.score);

  const topTickers = scored.slice(0, topN).map((s) => s.ticker);

  // Save to cache for future scans
  if (topTickers.length >= 50) {
    savePrescreenCache(topTickers);
  }

  logger.info(MODULE, `✅ Pre-screening complete. Selected ${topTickers.length} tickers from ${allQuotes.length} quoted.`);
  if (topTickers.length > 0) {
    const topSample = topTickers
      .slice(0, 10)
      .map((t) => t.replace(".JK", ""))
      .join(", ");
    logger.info(MODULE, `Top 10: ${topSample}`);
  }

  return topTickers;
}

export default {
  fetchHistoricalData,
  fetchAllTickers,
  updateTickerList,
  getTopTickersByVolume,
  probeRateLimit,
};
