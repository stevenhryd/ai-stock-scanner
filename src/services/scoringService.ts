/**
 * Scoring Service
 *
 * Assigns a score from 0–100 to each stock signal based on weighted criteria:
 *   - Breakout strength:  35%  (primary trigger — higher weight, false breakouts penalised)
 *   - Volume spike:       15%
 *   - RSI strength:       10%
 *   - 1D trend alignment: 20%
 *   - ADX trend strength: 10%  (NEW — weak trend = bad entry)
 *   - Volatility quality: 10%
 */

import { DailyAnalysis, FourHourAnalysis } from "./indicatorService.js";
import logger from "../utils/logger.js";

const MODULE = "ScoringService";

export interface ScoringMetrics {
  breakoutStrength: number; // percentage above 5-candle high
  volumeMultiple: number; // volume / avg volume
  rsi: number; // RSI value (4H)
  dailyAnalysis: DailyAnalysis; // 1D analysis result
  volatility: number; // stddev of closes
  close: number; // current close price
}

export interface ScoredSignal {
  ticker: string;
  score: number;
  breakdown: {
    breakoutScore: number;
    volumeScore: number;
    rsiScore: number;
    trendScore: number;
    adxScore: number;
    volatilityScore: number;
  };
  dailyAnalysis: DailyAnalysis;
  fourHourAnalysis: FourHourAnalysis;
}

/**
 * Score breakout strength (0–100). Higher breakout % = higher score.
 * Caps at 5% breakout for max score.
 * Penalises very weak breakouts (< 1%) with a sharper ramp.
 */
function scoreBreakout(breakoutStrength: number): number {
  if (breakoutStrength <= 0) return 0;
  if (breakoutStrength < 1.0) return Math.round((breakoutStrength / 1.0) * 30); // 0–30 for < 1%
  // Linear scale: 1% → 30, 5%+ → 100
  return Math.min(100, 30 + ((breakoutStrength - 1.0) / 4.0) * 70);
}

/**
 * Score volume spike (0–100).
 * 1.5x avg → ~50, 3x+ avg → 100
 */
function scoreVolume(volumeMultiple: number): number {
  if (volumeMultiple < 1) return 0;
  if (volumeMultiple < 1.5) return (volumeMultiple / 1.5) * 50;
  // 1.5x → 50, 3x → 100
  return Math.min(100, 50 + ((volumeMultiple - 1.5) / 1.5) * 50);
}

/**
 * Score RSI strength (0–100).
 * Perfect range is 55–65, still good at 65–70, weaker outside.
 */
function scoreRSI(rsi: number): number {
  if (rsi >= 55 && rsi <= 65) return 100;
  if (rsi > 65 && rsi <= 70) return 80;
  if (rsi > 50 && rsi < 55) return 60;
  if (rsi > 70 && rsi <= 75) return 40;
  return 20;
}

/**
 * Score 1D trend alignment (0–100).
 * Full score if all bullish conditions are strongly met.
 */
function scoreTrend(daily: DailyAnalysis): number {
  if (!daily.isBullish) return 0;

  let score = 0;

  // Close above SMA20 — bonus for larger gap
  const closeAboveSMA20 = daily.sma20 > 0 ? ((daily.close - daily.sma20) / daily.sma20) * 100 : 0;
  score += Math.min(40, closeAboveSMA20 * 10);

  // SMA20 above SMA50 — bonus for wider gap
  const sma20AboveSMA50 = daily.sma50 > 0 ? ((daily.sma20 - daily.sma50) / daily.sma50) * 100 : 0;
  score += Math.min(30, sma20AboveSMA50 * 10);

  // RSI strength on daily
  if (daily.rsi >= 55 && daily.rsi <= 70) {
    score += 30;
  } else if (daily.rsi > 50) {
    score += 15;
  }

  return Math.min(100, score);
}

/**
 * Score ADX trend strength (0–100).
 * Strong trend (ADX >= 25) required for reliable breakouts.
 */
function scoreADX(adx: number): number {
  if (adx >= 40) return 100;
  if (adx >= 30) return 80;
  if (adx >= 25) return 60;
  if (adx >= 20) return 40;
  return 0; // Choppy market — penalise heavily
}

/**
 * Score volatility quality (0–100).
 * Moderate volatility relative to price is preferred (2–5% of close).
 * Too low = no movement. Too high = risky.
 */
function scoreVolatility(volatility: number, close: number): number {
  if (close <= 0) return 0;
  const volPct = (volatility / close) * 100;

  if (volPct >= 2 && volPct <= 5) return 100;
  if (volPct >= 1 && volPct < 2) return 70;
  if (volPct > 5 && volPct <= 8) return 60;
  if (volPct < 1) return 30;
  return 20; // Very high volatility
}

/**
 * Calculate the composite score for a signal.
 */
export function calculateScore(ticker: string, daily: DailyAnalysis, fourHour: FourHourAnalysis): ScoredSignal {
  const breakoutScore = scoreBreakout(fourHour.breakoutStrength);
  const volumeScore = scoreVolume(fourHour.volumeMultiple);
  const rsiScore = scoreRSI(fourHour.rsi);
  const trendScore = scoreTrend(daily);
  const adxScore = scoreADX(fourHour.adx);
  const volatilityScore = scoreVolatility(fourHour.volatility, fourHour.close);

  // Weighted composite — Breakout 35% / Volume 15% / RSI 10% / Trend 20% / ADX 10% / Volatility 10%
  const score = Math.round(breakoutScore * 0.35 + volumeScore * 0.15 + rsiScore * 0.1 + trendScore * 0.2 + adxScore * 0.1 + volatilityScore * 0.1);

  logger.debug(MODULE, `${ticker} — Score: ${score} (BO:${breakoutScore.toFixed(0)} VOL:${volumeScore.toFixed(0)} RSI:${rsiScore.toFixed(0)} TREND:${trendScore.toFixed(0)} ADX:${adxScore.toFixed(0)} VLTY:${volatilityScore.toFixed(0)})`);

  return {
    ticker,
    score,
    breakdown: {
      breakoutScore: Math.round(breakoutScore),
      volumeScore: Math.round(volumeScore),
      rsiScore: Math.round(rsiScore),
      trendScore: Math.round(trendScore),
      adxScore: Math.round(adxScore),
      volatilityScore: Math.round(volatilityScore),
    },
    dailyAnalysis: daily,
    fourHourAnalysis: fourHour,
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
