/**
 * Signal Service
 *
 * Orchestrates the full signal generation pipeline:
 *   1. Fetch daily data → analyze 1D trend
 *   2. Filter to bullish stocks only
 *   3. Fetch 4H data → check entry triggers
 *   4. Score and rank signals
 *   5. Return top 5 buy signals
 */

import fs from "fs";
import path from "path";
import config from "../config/index.js";
import { fetchAllTickers, updateTickerList, resetFetchSummary } from "./dataService.js";
import { analyzeDaily, analyze4H, DailyAnalysis, FourHourAnalysis, checkSellCondition, SellSignal } from "./indicatorService.js";
import { calculateScore, rankSignals, ScoredSignal } from "./scoringService.js";
import { calculatePositionSize, PositionSizing } from "../utils/riskManagement.js";
import { getNewsSentiment, AISentiment } from "./newsService.js";
import logger from "../utils/logger.js";

const MODULE = "SignalService";

export interface BuySignal {
  ticker: string;
  score: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  lotSize: number;
  shares: number;
  positionSize: number;
  riskAmount: number;
  dailyAnalysis: DailyAnalysis;
  fourHourAnalysis: FourHourAnalysis;
  breakdown: ScoredSignal["breakdown"];
  timestamp: Date;
  aiSentiment?: AISentiment;
}

const SCAN_UNIVERSE_MODE = (process.env.SCAN_UNIVERSE || "static").toLowerCase();
const MAX_TICKERS_TO_SCAN = Math.max(0, parseInt(process.env.MAX_TICKERS_TO_SCAN || "0", 10));

/**
 * Get the list of tickers to scan.
 */
export function getTickerList(): string[] {
  // Try multiple locations: project root config, src config, and dist config
  const possiblePaths = [path.resolve(process.cwd(), "src/config/tickers.json"), path.resolve(__dirname, "../config/tickers.json"), path.resolve(process.cwd(), "tickers.json")];

  for (const tickerPath of possiblePaths) {
    try {
      const raw = fs.readFileSync(tickerPath, "utf-8");
      logger.info(MODULE, `Loaded tickers from: ${tickerPath}`);

      const parsed = JSON.parse(raw) as string[];
      const normalized = parsed
        .map((item) =>
          String(item || "")
            .trim()
            .toUpperCase(),
        )
        .filter((item) => item.length > 0)
        .map((item) => (item.endsWith(".JK") ? item : `${item}.JK`));

      const validTickerRegex = /^[A-Z0-9]{2,8}\.JK$/;
      const validTickers = normalized.filter((item) => validTickerRegex.test(item));
      const uniqueTickers = Array.from(new Set(validTickers));

      const invalidCount = normalized.length - validTickers.length;
      const duplicateCount = validTickers.length - uniqueTickers.length;

      if (invalidCount > 0) {
        logger.warn(MODULE, `Filtered ${invalidCount} invalid ticker format(s).`);
      }

      if (duplicateCount > 0) {
        logger.warn(MODULE, `Removed ${duplicateCount} duplicate ticker(s).`);
      }

      return uniqueTickers;
    } catch {
      // Try next path
    }
  }

  logger.error(MODULE, "Could not find tickers.json in any expected location!");
  return [];
}

async function getTickerListForScan(): Promise<string[]> {
  const staticTickers = getTickerList();

  let scanTickers = staticTickers;
  if (SCAN_UNIVERSE_MODE === "all" || SCAN_UNIVERSE_MODE === "idx") {
    const remoteTickers = await updateTickerList();
    if (remoteTickers.length > 0) {
      scanTickers = remoteTickers;
    } else {
      logger.warn(MODULE, "Using static tickers because remote universe could not be loaded.");
    }
  }

  if (MAX_TICKERS_TO_SCAN > 0 && scanTickers.length > MAX_TICKERS_TO_SCAN) {
    logger.warn(MODULE, `Applying MAX_TICKERS_TO_SCAN=${MAX_TICKERS_TO_SCAN} (from ${scanTickers.length} available).`);
    scanTickers = scanTickers.slice(0, MAX_TICKERS_TO_SCAN);
  }

  logger.info(MODULE, `Scan universe mode: ${SCAN_UNIVERSE_MODE}. Effective tickers: ${scanTickers.length}`);
  return scanTickers;
}

/**
 * Run the full signal generation pipeline.
 * Returns the top buy signals (max 5).
 */
export async function generateSignals(): Promise<BuySignal[]> {
  resetFetchSummary();
  const tickerList = await getTickerListForScan();
  logger.info(MODULE, `Starting signal scan for ${tickerList.length} tickers...`);

  // ── Step 1: Fetch daily data and filter bullish stocks ───────────────
  logger.info(MODULE, "📊 Step 1: Fetching daily (1D) data...");
  const dailyDataList = await fetchAllTickers(tickerList, "1d", "6mo");

  const bullishStocks: { ticker: string; dailyAnalysis: DailyAnalysis }[] = [];

  for (const { ticker, candles } of dailyDataList) {
    const daily = analyzeDaily(candles);
    if (daily && daily.isBullish) {
      bullishStocks.push({ ticker, dailyAnalysis: daily });
      logger.info(MODULE, `✅ ${ticker} — 1D BULLISH (RSI: ${daily.rsi.toFixed(1)}, Close: ${daily.close})`);
    }
  }

  logger.info(MODULE, `📈 ${bullishStocks.length}/${dailyDataList.length} stocks passed 1D trend filter.`);

  if (bullishStocks.length === 0) {
    logger.info(MODULE, "No bullish stocks found. Skipping 4H analysis.");
    return [];
  }

  // ── Step 2: Fetch 4H data for bullish stocks ────────────────────────
  logger.info(MODULE, "� Cooldown for 15s to reset Yahoo rate limits before 4H scan...");
  await new Promise((resolve) => setTimeout(resolve, 15000));

  logger.info(MODULE, "�📊 Step 2: Fetching 4H data for bullish stocks...");
  const bullishTickers = bullishStocks.map((s) => s.ticker);

  // Yahoo Finance uses '1h' interval — we'll fetch hourly and treat it as 4H proxy
  // (Yahoo doesn't support 4h interval natively, so we use 1h with 1mo period)
  const fourHourDataList = await fetchAllTickers(bullishTickers, "1h", "1mo");

  // ── Step 3: Analyze 4H data and check buy triggers ──────────────────
  logger.info(MODULE, "🧠 Step 3: Analyzing 4H entry triggers...");
  const scoredSignals: ScoredSignal[] = [];

  // Hard quality gates — must ALL pass before scoring
  const MIN_BREAKOUT_STRENGTH = 1.0; // at least 1% above 5-candle high
  const MIN_ADX = 20; // minimum trend strength
  const MIN_SIGNAL_SCORE = 70; // minimum composite score to send

  for (const { ticker, candles } of fourHourDataList) {
    // Simulate 4H by taking every 4th candle from 1H data
    const fourHourCandles = candles.filter((_, i) => i % 4 === 3 || i === candles.length - 1);

    const analysis4H = analyze4H(fourHourCandles);
    if (!analysis4H) continue;

    // ── Hard filter gate ────────────────────────────────────────────────
    // 1. Classic 4H breakout / volume / RSI checks
    if (!analysis4H.breakoutDetected || !analysis4H.volumeSpike || !analysis4H.rsiInRange) {
      logger.debug(MODULE, `❌ ${ticker} — No 4H buy trigger (BO/Vol/RSI)`);
      continue;
    }
    // 2. Breakout candle must be bullish (close > open) — avoid shooting-star breakouts
    if (!analysis4H.isBullishCandle) {
      logger.debug(MODULE, `❌ ${ticker} — Breakout candle not bullish (possible reversal bar)`);
      continue;
    }
    // 3. Minimum breakout strength to avoid thin/false breakouts
    if (analysis4H.breakoutStrength < MIN_BREAKOUT_STRENGTH) {
      logger.debug(MODULE, `❌ ${ticker} — Breakout too weak (${analysis4H.breakoutStrength.toFixed(2)}% < ${MIN_BREAKOUT_STRENGTH}%)`);
      continue;
    }
    // 4. MACD must be bullish (momentum confirmation)
    if (!analysis4H.macdBullish) {
      logger.debug(MODULE, `❌ ${ticker} — MACD not bullish (no momentum confirmation)`);
      continue;
    }
    // 5. ADX must indicate a real trend (no choppy market entries)
    if (analysis4H.adx < MIN_ADX) {
      logger.debug(MODULE, `❌ ${ticker} — ADX too low (${analysis4H.adx.toFixed(1)} < ${MIN_ADX}) — choppy market`);
      continue;
    }
    // ── End hard filter gate ────────────────────────────────────────────

    // Get the daily analysis for this ticker
    const dailyData = bullishStocks.find((s) => s.ticker === ticker);
    if (!dailyData) continue;

    // Score the signal
    const scored = calculateScore(ticker, dailyData.dailyAnalysis, analysis4H);

    // Enforce minimum composite score
    if (scored.score < MIN_SIGNAL_SCORE) {
      logger.debug(MODULE, `❌ ${ticker} — Score too low (${scored.score} < ${MIN_SIGNAL_SCORE})`);
      continue;
    }

    scoredSignals.push(scored);

    logger.info(MODULE, `🎯 ${ticker} — BUY TRIGGER HIT! Score: ${scored.score} | BO: ${analysis4H.breakoutStrength.toFixed(2)}% | ADX: ${analysis4H.adx.toFixed(1)} | MACD: ✅`);
  }

  // ── Step 4: Rank and return top signals ─────────────────────────────
  logger.info(MODULE, `🏆 Step 4: Ranking ${scoredSignals.length} signals...`);
  const topSignals = rankSignals(scoredSignals, config.signal.maxPerDay);

  // Convert to BuySignal with position sizing (ATR-based dynamic stop loss)
  const buySignals: BuySignal[] = topSignals.map((signal) => {
    const entryPrice = signal.fourHourAnalysis.close;
    const position = calculatePositionSize(
      entryPrice,
      undefined,
      undefined,
      undefined,
      signal.fourHourAnalysis.atr, // pass ATR for dynamic SL
    );

    return {
      ticker: signal.ticker,
      score: signal.score,
      entry: entryPrice,
      stopLoss: position.stopLoss,
      takeProfit: position.takeProfit,
      lotSize: position.lotSize,
      shares: position.shares,
      positionSize: position.positionSize,
      riskAmount: position.riskAmount,
      dailyAnalysis: signal.dailyAnalysis,
      fourHourAnalysis: signal.fourHourAnalysis,
      breakdown: signal.breakdown,
      timestamp: new Date(),
    };
  });

  // ── Step 5: AI News Sentiment Analysis (only for top signals) ───────
  if (config.ai.geminiApiKey && buySignals.length > 0) {
    logger.info(MODULE, `🤖 Step 5: Running AI News Sentiment for ${buySignals.length} signal(s)...`);
    for (const signal of buySignals) {
      try {
        const sentiment = await getNewsSentiment(signal.ticker);
        if (sentiment) {
          signal.aiSentiment = sentiment;
          // Adjust final score: add up to ±5 points based on AI sentiment (-10..+10 → -5..+5)
          const aiBonus = Math.round(sentiment.score * 0.5);
          signal.score = Math.max(0, Math.min(100, signal.score + aiBonus));
          logger.info(MODULE, `🤖 ${signal.ticker} — AI Sentiment: ${sentiment.score > 0 ? "+" : ""}${sentiment.score}/10 | Adjusted Score: ${signal.score} | ${sentiment.summary}`);
        }
      } catch (err: any) {
        logger.warn(MODULE, `⚠️ AI Sentiment failed for ${signal.ticker}: ${err.message}`);
      }
    }
  } else if (!config.ai.geminiApiKey) {
    logger.info(MODULE, "⏭️ Skipping AI Sentiment (GEMINI_API_KEY not set).");
  }

  logger.info(MODULE, `✨ Generated ${buySignals.length} buy signal(s).`);

  return buySignals;
}

/**
 * Check sell/exit conditions for a list of tickers
 * (for monitoring existing positions).
 */
export async function checkExitSignals(watchTickers: string[]): Promise<{ ticker: string; sell: SellSignal }[]> {
  if (watchTickers.length === 0) return [];

  logger.info(MODULE, `Checking exit signals for ${watchTickers.length} watched positions...`);
  const exitSignals: { ticker: string; sell: SellSignal }[] = [];

  const dataList = await fetchAllTickers(watchTickers, "1h", "1mo");

  for (const { ticker, candles } of dataList) {
    const fourHourCandles = candles.filter((_, i) => i % 4 === 3 || i === candles.length - 1);
    const analysis = analyze4H(fourHourCandles);
    if (!analysis) continue;

    const sell = checkSellCondition(analysis);
    if (sell.shouldSell) {
      exitSignals.push({ ticker, sell: { shouldSell: true, reason: sell.reason } });
      logger.warn(MODULE, `🔴 ${ticker} — EXIT SIGNAL: ${sell.reason}`);
    }
  }

  return exitSignals;
}

export default {
  getTickerList,
  generateSignals,
  checkExitSignals,
};
