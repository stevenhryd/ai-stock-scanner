/**
 * Data Service
 *
 * Fetches technical analysis data from TradingView Scanner API.
 * TradingView provides RSI, MACD, EMA, SMA, volume, and recommendation summaries
 * for IDX exchange stocks across multiple timeframes (4H, 1D).
 */

import axios from "axios";
import logger from "../utils/logger.js";

const MODULE = "DataService";

const TRADINGVIEW_SCAN_URL = "https://scanner.tradingview.com/indonesia/scan";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface TradingViewIndicators {
  close: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  /** RSI(14) */
  rsi: number;
  /** MACD line */
  macdLine: number;
  /** MACD signal */
  macdSignal: number;
  /** MACD histogram */
  macdHist: number;
  /** EMA 20 */
  ema20: number;
  /** EMA 50 */
  ema50: number;
  /** SMA 20 */
  sma20: number;
  /** SMA 50 */
  sma50: number;
  /** Average Volume (20) */
  avgVolume20: number;
  /** ADX(14) */
  adx: number;
  /** ATR(14) */
  atr: number;
  /** TradingView overall recommendation: -1 (SELL) to 1 (BUY), 0 = NEUTRAL */
  recommendAll: number;
  /** TradingView MA recommendation */
  recommendMA: number;
  /** TradingView oscillator recommendation */
  recommendOsc: number;
}

export interface MultiTimeframeAnalysis {
  ticker: string;
  daily: TradingViewIndicators | null;
  fourHour: TradingViewIndicators | null;
}

export interface FetchSummary {
  success: number;
  failed: number;
  rateLimited: string[];
  notFound: string[];
  otherErrors: string[];
}

// ─── Fetch Summary Tracking ────────────────────────────────────────────────

let _fetchSummary: FetchSummary = {
  success: 0,
  failed: 0,
  rateLimited: [],
  notFound: [],
  otherErrors: [],
};

export function resetFetchSummary(): void {
  _fetchSummary = { success: 0, failed: 0, rateLimited: [], notFound: [], otherErrors: [] };
}

export function getFetchSummary(): FetchSummary {
  return { ..._fetchSummary };
}

// ─── TradingView Scanner API Fields ────────────────────────────────────────

/**
 * The column fields we request from TradingView scanner.
 * These correspond to TradingView's internal field names.
 */
const TV_COLUMNS_DAILY = ["close", "open", "high", "low", "volume", "RSI", "MACD.macd", "MACD.signal", "EMA20", "EMA50", "SMA20", "SMA50", "average_volume_30d_calc", "ADX", "ATR", "Recommend.All", "Recommend.MA", "Recommend.Other"];

/**
 * For 4H timeframe, TradingView uses the |240 suffix on column names.
 */
const TV_COLUMNS_4H = TV_COLUMNS_DAILY.map((col) => `${col}|240`);

/**
 * Convert ticker from BBCA.JK format to IDX:BBCA for TradingView.
 */
function toTradingViewSymbol(ticker: string): string {
  const code = ticker.replace(".JK", "").toUpperCase();
  return `IDX:${code}`;
}

/**
 * Convert TradingView symbol IDX:BBCA back to BBCA.JK format.
 */
function fromTradingViewSymbol(tvSymbol: string): string {
  const code = tvSymbol.replace("IDX:", "");
  return `${code}.JK`;
}

/**
 * Parse row data from TradingView scanner response into indicator values.
 */
function parseIndicatorRow(data: (number | null)[]): TradingViewIndicators {
  const macdLine = data[6] ?? 0;
  const macdSignal = data[7] ?? 0;
  return {
    close: data[0] ?? 0,
    open: data[1] ?? 0,
    high: data[2] ?? 0,
    low: data[3] ?? 0,
    volume: data[4] ?? 0,
    rsi: data[5] ?? 0,
    macdLine,
    macdSignal,
    macdHist: macdLine - macdSignal,
    ema20: data[8] ?? 0,
    ema50: data[9] ?? 0,
    sma20: data[10] ?? 0,
    sma50: data[11] ?? 0,
    avgVolume20: data[12] ?? 0,
    adx: data[13] ?? 0,
    atr: data[14] ?? 0,
    recommendAll: data[15] ?? 0,
    recommendMA: data[16] ?? 0,
    recommendOsc: data[17] ?? 0,
  };
}

// ─── Core Fetch Functions ──────────────────────────────────────────────────

/**
 * Fetch indicators from TradingView Scanner API for a batch of tickers.
 *
 * TradingView scanner API accepts POST requests and can handle
 * many tickers at once (batch request).
 *
 * @param tickers - Array of tickers in BBCA.JK format
 * @param interval - Timeframe: "1D" or "4H"
 * @returns Map of ticker -> indicators
 */
export async function fetchTradingViewBatch(tickers: string[], interval: string = "1D"): Promise<Map<string, TradingViewIndicators>> {
  const results = new Map<string, TradingViewIndicators>();

  if (tickers.length === 0) return results;

  const tvSymbols = tickers.map(toTradingViewSymbol);
  const columns = interval === "4H" || interval === "4h" ? TV_COLUMNS_4H : TV_COLUMNS_DAILY;

  const payload = {
    symbols: {
      tickers: tvSymbols,
    },
    columns,
  };

  try {
    const response = await axios.post(TRADINGVIEW_SCAN_URL, payload, {
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      timeout: 30000,
    });

    const data = response.data?.data;
    if (!Array.isArray(data)) {
      logger.warn(MODULE, `TradingView returned unexpected format for interval ${interval}`);
      return results;
    }

    for (const row of data) {
      const tvSymbol: string = row.s;
      const values: (number | null)[] = row.d;
      const ticker = fromTradingViewSymbol(tvSymbol);

      if (!values || values.length < TV_COLUMNS_DAILY.length) {
        logger.debug(MODULE, `Incomplete data for ${ticker} (${interval})`);
        continue;
      }

      const indicators = parseIndicatorRow(values);

      // Validate: skip if critical fields are zero/null
      if (indicators.close <= 0) {
        logger.debug(MODULE, `Invalid close price for ${ticker}: ${indicators.close}`);
        continue;
      }

      results.set(ticker, indicators);
    }

    logger.info(MODULE, `TradingView ${interval}: got data for ${results.size}/${tickers.length} tickers`);
  } catch (error: any) {
    const status = error.response?.status;
    if (status === 429) {
      logger.warn(MODULE, `TradingView rate limited (429) for ${interval} batch`);
      for (const t of tickers) {
        if (!_fetchSummary.rateLimited.includes(t)) _fetchSummary.rateLimited.push(t);
      }
    } else {
      logger.error(MODULE, `TradingView fetch error (${interval}): ${error.message}`);
      for (const t of tickers) {
        if (!_fetchSummary.otherErrors.includes(t)) _fetchSummary.otherErrors.push(t);
      }
    }
    _fetchSummary.failed += tickers.length;
  }

  return results;
}

/**
 * Fetch both 1D and 4H indicators for all tickers.
 * Splits into batches of 500 to stay within API limits.
 *
 * @param tickers - Full list of tickers to scan
 * @returns Array of multi-timeframe analyses
 */
export async function fetchAllTickerAnalysis(tickers: string[]): Promise<MultiTimeframeAnalysis[]> {
  const BATCH_SIZE = 500;
  const BATCH_DELAY_MS = 2000;

  logger.info(MODULE, `Fetching TradingView data for ${tickers.length} tickers (1D + 4H)...`);

  // ── Fetch Daily (1D) data ────────────────────────────────────────────
  const dailyMap = new Map<string, TradingViewIndicators>();
  for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
    const batch = tickers.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(tickers.length / BATCH_SIZE);

    logger.info(MODULE, `Daily batch ${batchNum}/${totalBatches} (${batch.length} tickers)`);
    const batchResults = await fetchTradingViewBatch(batch, "1D");
    for (const [ticker, indicators] of batchResults) {
      dailyMap.set(ticker, indicators);
      _fetchSummary.success++;
    }

    // Track failed tickers
    for (const t of batch) {
      if (!batchResults.has(t)) {
        _fetchSummary.failed++;
        if (!_fetchSummary.notFound.includes(t) && !_fetchSummary.rateLimited.includes(t) && !_fetchSummary.otherErrors.includes(t)) {
          _fetchSummary.notFound.push(t);
        }
      }
    }

    if (i + BATCH_SIZE < tickers.length) {
      await delay(BATCH_DELAY_MS);
    }
  }

  // ── Fetch 4H data only for tickers that have daily data ──────────────
  const tickersWithDaily = tickers.filter((t) => dailyMap.has(t));
  const fourHourMap = new Map<string, TradingViewIndicators>();

  logger.info(MODULE, `Fetching 4H data for ${tickersWithDaily.length} tickers with valid daily data...`);

  for (let i = 0; i < tickersWithDaily.length; i += BATCH_SIZE) {
    const batch = tickersWithDaily.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(tickersWithDaily.length / BATCH_SIZE);

    logger.info(MODULE, `4H batch ${batchNum}/${totalBatches} (${batch.length} tickers)`);
    const batchResults = await fetchTradingViewBatch(batch, "4H");
    for (const [ticker, indicators] of batchResults) {
      fourHourMap.set(ticker, indicators);
    }

    if (i + BATCH_SIZE < tickersWithDaily.length) {
      await delay(BATCH_DELAY_MS);
    }
  }

  // ── Combine results ──────────────────────────────────────────────────
  const results: MultiTimeframeAnalysis[] = [];
  for (const ticker of tickers) {
    results.push({
      ticker,
      daily: dailyMap.get(ticker) ?? null,
      fourHour: fourHourMap.get(ticker) ?? null,
    });
  }

  logger.info(MODULE, `Fetch complete: ${dailyMap.size} daily, ${fourHourMap.size} 4H out of ${tickers.length} total`);

  return results;
}

// ─── Utilities ─────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default {
  fetchTradingViewBatch,
  fetchAllTickerAnalysis,
  resetFetchSummary,
  getFetchSummary,
};
