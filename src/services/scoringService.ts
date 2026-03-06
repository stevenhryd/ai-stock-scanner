/**
 * Scoring Service
 *
 * Assigns a score from 0–100 to each stock signal based on weighted criteria:
 *   - TradingView recommendation: 30%  (overall buy/sell summary — strongest predictor)
 *   - 1D trend alignment:         20%
 *   - Volume spike:               15%
 *   - ADX trend strength:         15%
 *   - RSI strength:               10%
 *   - News sentiment:             10%
 */

import { DailyAnalysis, FourHourAnalysis } from "./indicatorService.js";
import { NewsSentiment } from "./newsService.js";
import logger from "../utils/logger.js";

const MODULE = "ScoringService";

export interface ScoredSignal {
  ticker: string;
  score: number;
  breakdown: {
    recommendScore: number;
    volumeScore: number;
    rsiScore: number;
    trendScore: number;
    adxScore: number;
    sentimentScore: number;
  };
  dailyAnalysis: DailyAnalysis;
  fourHourAnalysis: FourHourAnalysis;
  newsSentiment?: NewsSentiment;
}

/**
 * Score TradingView recommendation (0–100).
 * recommendAll ranges from -1 (strong sell) to +1 (strong buy).
 * Heavily rewards strong buy signals (>0.3) and penalizes sell signals.
 */
function scoreRecommendation(recommendAll: number): number {
  if (recommendAll >= 0.5) return 100; // Strong Buy
  if (recommendAll >= 0.3) return 90; // Buy
  if (recommendAll >= 0.1) return 75; // Weak Buy
  if (recommendAll >= 0) return 60; // Neutral
  if (recommendAll >= -0.1) return 40; // Weak Sell
  return 20; // Sell
}

/**
 * Score volume spike (0–100).
 * 1.5x avg → ~50, 3x+ avg → 100
 */
function scoreVolume(volumeMultiple: number): number {
  if (volumeMultiple < 1) return 0;
  if (volumeMultiple < 1.5) return (volumeMultiple / 1.5) * 50;
  return Math.min(100, 50 + ((volumeMultiple - 1.5) / 1.5) * 50);
}

/**
 * Score RSI strength (0–100).
 * Sweet spot: 50–65 (strong momentum without overbought risk)
 * Still good: 45–80 range
 */
function scoreRSI(rsi: number): number {
  if (rsi >= 50 && rsi <= 65) return 100;
  if (rsi > 65 && rsi <= 75) return 80;
  if (rsi >= 45 && rsi < 50) return 70;
  if (rsi > 75 && rsi <= 80) return 50;
  return 20;
}

/**
 * Score 1D trend alignment (0–100).
 * Full score if all bullish conditions are strongly met.
 */
function scoreTrend(daily: DailyAnalysis): number {
  if (!daily.isBullish) return 0;

  let score = 0;

  // Close above SMA20 — bonus for larger gap (0-40 points)
  if (daily.sma20 > 0) {
    const pctAbove = ((daily.close - daily.sma20) / daily.sma20) * 100;
    score += Math.max(0, Math.min(40, pctAbove * 10));
  }

  // EMA20 above EMA50 — trend alignment (0-30 points)
  if (daily.ema50 > 0 && daily.ema20 > 0) {
    const pctAbove = ((daily.ema20 - daily.ema50) / daily.ema50) * 100;
    score += Math.max(0, Math.min(30, pctAbove * 10));
  }

  // RSI strength on daily (0-30 points)
  if (daily.rsi >= 55 && daily.rsi <= 70) {
    score += 30;
  } else if (daily.rsi >= 50 && daily.rsi < 55) {
    score += 20;
  } else if (daily.rsi >= 45 && daily.rsi < 50) {
    score += 10;
  }

  return Math.min(100, score);
}

/**
 * Score ADX trend strength (0–100).
 * Strong trend (ADX >= 25) gives confidence. Moderate trend (20+) acceptable.
 */
function scoreADX(adx: number): number {
  if (adx >= 40) return 100;
  if (adx >= 30) return 90;
  if (adx >= 25) return 75;
  if (adx >= 20) return 55;
  if (adx >= 15) return 35;
  return 10;
}

/**
 * Score news sentiment (0–100).
 * Maps -10..+10 sentiment to 0..100.
 * Neutral (no news) is counted as slightly positive (55).
 */
function scoreSentiment(sentiment: NewsSentiment | undefined): number {
  if (!sentiment || sentiment.newsCount === 0) return 55;
  return Math.round(Math.max(0, Math.min(100, (sentiment.score + 10) * 5)));
}

/**
 * Calculate the composite score for a signal.
 */
export function calculateScore(ticker: string, daily: DailyAnalysis, fourHour: FourHourAnalysis, sentiment?: NewsSentiment): ScoredSignal {
  const recommendScore = scoreRecommendation(fourHour.recommendAll);
  const volumeScore = scoreVolume(fourHour.volumeMultiple);
  const rsiScore = scoreRSI(fourHour.rsi);
  const trendScore = scoreTrend(daily);
  const adxScore = scoreADX(fourHour.adx);
  const sentimentScore = scoreSentiment(sentiment);

  // Confluence bonus: when ALL core indicators align, boost score
  const coreAligned = recommendScore >= 75 && trendScore >= 70 && volumeScore >= 50 && adxScore >= 55;
  const confluenceBonus = coreAligned ? 5 : 0;

  // Weighted composite:
  // Recommend 35% / Trend 20% / Volume 15% / ADX 15% / RSI 10% / Sentiment 5%
  const score = Math.min(100, Math.round(recommendScore * 0.35 + trendScore * 0.2 + volumeScore * 0.15 + adxScore * 0.15 + rsiScore * 0.1 + sentimentScore * 0.05 + confluenceBonus));

  logger.debug(MODULE, `${ticker} — Score: ${score} (REC:${recommendScore} TREND:${Math.round(trendScore)} VOL:${Math.round(volumeScore)} ADX:${adxScore} RSI:${rsiScore} SENT:${sentimentScore}${confluenceBonus ? " +CONF" : ""})`);

  return {
    ticker,
    score,
    breakdown: {
      recommendScore: Math.round(recommendScore),
      volumeScore: Math.round(volumeScore),
      rsiScore: Math.round(rsiScore),
      trendScore: Math.round(trendScore),
      adxScore: Math.round(adxScore),
      sentimentScore: Math.round(sentimentScore),
    },
    dailyAnalysis: daily,
    fourHourAnalysis: fourHour,
    newsSentiment: sentiment,
  };
}

/**
 * Rank scored signals descending by score and return top N.
 */
export function rankSignals(signals: ScoredSignal[], topN: number = 5): ScoredSignal[] {
  return signals.sort((a, b) => b.score - a.score).slice(0, topN);
}

export default {
  calculateScore,
  rankSignals,
};
