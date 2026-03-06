/**
 * Signal Service
 *
 * Orchestrates the full signal generation pipeline using TradingView data:
 *   1. Fetch 1D + 4H indicators from TradingView Scanner API (batch)
 *   2. Filter to bullish stocks (1D trend filter)
 *   3. Check 4H entry triggers (breakout, volume, RSI, MACD, ADX)
 *   4. Fetch news sentiment from Yahoo Finance (keyword-based)
 *   5. Score and rank signals
 *   6. Position sizing and return top 5
 */

import fs from "fs";
import path from "path";
import config from "../config/index.js";
import { fetchAllTickerAnalysis, resetFetchSummary, TradingViewIndicators } from "./dataService.js";
import { analyzeDaily, analyze4H, DailyAnalysis, FourHourAnalysis, checkSellCondition, SellSignal } from "./indicatorService.js";
import { calculateScore, rankSignals, ScoredSignal } from "./scoringService.js";
import { calculatePositionSize } from "../utils/riskManagement.js";
import { getNewsSentiment, NewsSentiment } from "./newsService.js";
import { sendMessage } from "../telegram/telegramService.js";
import { fetchTradingViewBatch } from "./dataService.js";
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
  newsSentiment?: NewsSentiment;
}

/**
 * Get the list of tickers to scan from config files.
 */
export function getTickerList(): string[] {
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

      return uniqueTickers;
    } catch {
      // Try next path
    }
  }

  logger.error(MODULE, "Could not find tickers.json in any expected location!");
  return [];
}

/**
 * Get the full ticker universe for scanning.
 * Tries to load tickers_full.json first (800+ IDX tickers), falls back to tickers.json.
 */
function getFullTickerList(): string[] {
  const fullListPaths = [path.resolve(process.cwd(), "src/config/tickers_full.json"), path.resolve(__dirname, "../config/tickers_full.json")];

  for (const fullPath of fullListPaths) {
    try {
      const raw = fs.readFileSync(fullPath, "utf-8");
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
      const uniqueTickers = Array.from(new Set(normalized.filter((item) => validTickerRegex.test(item))));

      if (uniqueTickers.length > 100) {
        logger.info(MODULE, `Loaded full ticker list: ${uniqueTickers.length} tickers from ${fullPath}`);
        return uniqueTickers;
      }
    } catch {
      // Try next path
    }
  }

  // Fallback to standard tickers.json
  logger.warn(MODULE, "Full ticker list not found, falling back to tickers.json");
  return getTickerList();
}

/**
 * Run the full signal generation pipeline.
 * Returns the top buy signals (max 5).
 */
export async function generateSignals(): Promise<BuySignal[]> {
  resetFetchSummary();

  const tickerList = getFullTickerList();
  logger.info(MODULE, `Starting signal scan for ${tickerList.length} IDX tickers...`);

  // ── Notify Telegram ──────────────────────────────────────────────────
  try {
    const now = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
    await sendMessage(`📊 *Scan Dimulai*\n📅 ${now}\n\n` + `🏦 Exchange: IDX\n` + `📈 Total ticker: ${tickerList.length}\n` + `📊 Data source: TradingView (1D + 4H)\n` + `📰 Berita: Yahoo Finance\n\n` + `⏳ Sedang mengambil data...`);
  } catch {
    // Non-critical
  }

  // ── Step 1: Fetch all indicators from TradingView (1D + 4H) ─────────
  logger.info(MODULE, "📊 Step 1: Fetching TradingView indicators (1D + 4H)...");
  const allAnalyses = await fetchAllTickerAnalysis(tickerList);

  // ── Step 2: Filter bullish stocks using 1D data ──────────────────────
  logger.info(MODULE, "📈 Step 2: Filtering bullish stocks (1D trend)...");
  const bullishStocks: {
    ticker: string;
    dailyAnalysis: DailyAnalysis;
    fourHourIndicators: TradingViewIndicators;
  }[] = [];

  // Minimum price (Rp) — exclude penny stocks which are volatile and unreliable
  const MIN_PRICE = 100;
  // Minimum average daily volume — exclude illiquid stocks
  const MIN_AVG_VOLUME = 500_000;

  for (const { ticker, daily, fourHour } of allAnalyses) {
    if (!daily || !fourHour) continue;

    // Liquidity gate: skip penny stocks and illiquid tickers
    if (daily.close < MIN_PRICE) {
      logger.debug(MODULE, `❌ ${ticker} — Price too low (Rp ${daily.close} < ${MIN_PRICE})`);
      continue;
    }
    if (daily.avgVolume20 > 0 && daily.avgVolume20 < MIN_AVG_VOLUME) {
      logger.debug(MODULE, `❌ ${ticker} — Avg volume too low (${Math.round(daily.avgVolume20).toLocaleString()} < ${MIN_AVG_VOLUME.toLocaleString()})`);
      continue;
    }

    const dailyResult = analyzeDaily(daily);
    if (!dailyResult || !dailyResult.isBullish) continue;

    bullishStocks.push({
      ticker,
      dailyAnalysis: dailyResult,
      fourHourIndicators: fourHour,
    });

    logger.debug(MODULE, `✅ ${ticker} — 1D BULLISH (RSI: ${daily.rsi.toFixed(1)}, Close: ${daily.close})`);
  }

  logger.info(MODULE, `📈 ${bullishStocks.length}/${allAnalyses.length} stocks passed 1D trend filter.`);

  if (bullishStocks.length === 0) {
    logger.info(MODULE, "No bullish stocks found. Skipping 4H analysis.");
    return [];
  }

  // ── Step 3: Analyze 4H data and check buy triggers ──────────────────
  logger.info(MODULE, "🧠 Step 3: Analyzing 4H entry triggers...");
  const MIN_SIGNAL_SCORE = 70;

  const candidates: {
    ticker: string;
    dailyAnalysis: DailyAnalysis;
    fourHourAnalysis: FourHourAnalysis;
  }[] = [];

  for (const { ticker, dailyAnalysis, fourHourIndicators } of bullishStocks) {
    const analysis4H = analyze4H(fourHourIndicators);
    if (!analysis4H) continue;

    // ── Scoring-based filter — count passing conditions ───────────────
    let passCount = 0;
    let totalChecks = 0;
    const reasons: string[] = [];

    // 1. Breakout (close > SMA20 or EMA20) — important
    totalChecks++;
    if (analysis4H.breakoutDetected) {
      passCount++;
    } else {
      reasons.push("no breakout");
    }

    // 2. Volume spike (>1.2x avg)
    totalChecks++;
    if (analysis4H.volumeSpike) {
      passCount++;
    } else {
      reasons.push(`vol ${analysis4H.volumeMultiple.toFixed(1)}x`);
    }

    // 3. RSI in range (45-80)
    totalChecks++;
    if (analysis4H.rsiInRange) {
      passCount++;
    } else {
      reasons.push(`RSI ${analysis4H.rsi.toFixed(1)}`);
    }

    // 4. MACD bullish
    totalChecks++;
    if (analysis4H.macdBullish) {
      passCount++;
    } else {
      reasons.push("MACD bearish");
    }

    // 5. TradingView recommendation > 0 (neutral-to-buy, not sell)
    totalChecks++;
    if (analysis4H.recommendAll > 0) {
      passCount++;
    } else {
      reasons.push(`TVRec ${analysis4H.recommendAll.toFixed(2)}`);
    }

    // Must pass at least 4 of 5 conditions
    if (passCount < 4) {
      logger.debug(MODULE, `❌ ${ticker} — ${passCount}/${totalChecks} conditions (${reasons.join(", ")})`);
      continue;
    }

    candidates.push({ ticker, dailyAnalysis, fourHourAnalysis: analysis4H });

    logger.info(MODULE, `🎯 ${ticker} — 4H BUY (${passCount}/${totalChecks}) RSI: ${analysis4H.rsi.toFixed(1)} | ADX: ${analysis4H.adx.toFixed(1)} | MACD: ${analysis4H.macdBullish ? "✅" : "❌"} | TV Rec: ${analysis4H.recommendAll.toFixed(2)}`);
  }

  logger.info(MODULE, `Found ${candidates.length} candidates passing filters.`);

  if (candidates.length === 0) {
    return [];
  }

  // ── Step 4: Fetch news sentiment from Yahoo Finance ─────────────────
  logger.info(MODULE, `📰 Step 4: Fetching Yahoo Finance news for ${candidates.length} candidate(s)...`);

  const sentimentMap = new Map<string, NewsSentiment>();
  for (const { ticker } of candidates) {
    try {
      const sentiment = await getNewsSentiment(ticker);
      if (sentiment) {
        sentimentMap.set(ticker, sentiment);
        logger.info(MODULE, `📰 ${ticker} — Sentiment: ${sentiment.score > 0 ? "+" : ""}${sentiment.score}/10 | ${sentiment.summary}`);
      }
    } catch (err: any) {
      logger.warn(MODULE, `⚠️ News fetch failed for ${ticker}: ${err.message}`);
    }
    // Small delay between Yahoo requests
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // ── Step 5: Score and rank ──────────────────────────────────────────
  logger.info(MODULE, "🏆 Step 5: Scoring and ranking signals...");

  const scoredSignals: ScoredSignal[] = [];
  for (const { ticker, dailyAnalysis, fourHourAnalysis } of candidates) {
    const sentiment = sentimentMap.get(ticker);
    const scored = calculateScore(ticker, dailyAnalysis, fourHourAnalysis, sentiment);

    if (scored.score < MIN_SIGNAL_SCORE) {
      logger.debug(MODULE, `❌ ${ticker} — Score too low (${scored.score} < ${MIN_SIGNAL_SCORE})`);
      continue;
    }

    scoredSignals.push(scored);
  }

  const topSignals = rankSignals(scoredSignals, config.signal.maxPerDay);

  // ── Step 6: Convert to BuySignal with position sizing ───────────────
  const buySignals: BuySignal[] = topSignals.map((signal) => {
    const entryPrice = signal.fourHourAnalysis.close;
    const position = calculatePositionSize(entryPrice, undefined, undefined, undefined, signal.fourHourAnalysis.atr);

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
      newsSentiment: signal.newsSentiment,
    };
  });

  logger.info(MODULE, `✨ Generated ${buySignals.length} buy signal(s).`);
  return buySignals;
}

/**
 * Check sell/exit conditions for a list of tickers.
 * Uses TradingView 4H data to check technical exit signals.
 */
export async function checkExitSignals(watchTickers: string[]): Promise<{ ticker: string; sell: SellSignal; currentPrice: number }[]> {
  if (watchTickers.length === 0) return [];

  logger.info(MODULE, `Checking exit signals for ${watchTickers.length} watched positions...`);
  const exitSignals: { ticker: string; sell: SellSignal; currentPrice: number }[] = [];

  // Fetch 4H data from TradingView
  const fourHourMap = await fetchTradingViewBatch(watchTickers, "4H");

  for (const ticker of watchTickers) {
    const indicators = fourHourMap.get(ticker);
    if (!indicators) continue;

    const analysis = analyze4H(indicators);
    if (!analysis) continue;

    const sell = checkSellCondition(analysis);
    if (sell.shouldSell) {
      exitSignals.push({
        ticker,
        sell: { shouldSell: true, reason: sell.reason },
        currentPrice: analysis.close,
      });
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
