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
import { fetchAllTickers, fetchHistoricalData, TickerData } from "./dataService.js";
import { analyzeDaily, analyze4H, DailyAnalysis, FourHourAnalysis, checkSellCondition, SellSignal } from "./indicatorService.js";
import { calculateScore, rankSignals, ScoredSignal } from "./scoringService.js";
import { calculatePositionSize, PositionSizing } from "../utils/riskManagement.js";
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
}

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
      return JSON.parse(raw) as string[];
    } catch {
      // Try next path
    }
  }

  logger.error(MODULE, "Could not find tickers.json in any expected location!");
  return [];
}

/**
 * Run the full signal generation pipeline.
 * Returns the top buy signals (max 5).
 */
export async function generateSignals(): Promise<BuySignal[]> {
  const tickerList = getTickerList();
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
  logger.info(MODULE, "📊 Step 2: Fetching 4H data for bullish stocks...");
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
