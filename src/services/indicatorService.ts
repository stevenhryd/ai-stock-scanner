/**
 * Indicator Service
 *
 * Calculates technical indicators (SMA, EMA, RSI) and performs
 * timeframe-specific analysis for 1D (trend filter) and 4H (entry trigger).
 */

import { SMA, EMA, RSI } from 'technicalindicators';
import { CandleData } from './dataService.js';
import logger from '../utils/logger.js';

const MODULE = 'IndicatorService';

// ─── Indicator Calculation ─────────────────────────────────────────────────

/**
 * Calculate Simple Moving Average.
 */
export function calculateSMA(closes: number[], period: number): number[] {
  return SMA.calculate({ period, values: closes });
}

/**
 * Calculate Exponential Moving Average.
 */
export function calculateEMA(closes: number[], period: number): number[] {
  return EMA.calculate({ period, values: closes });
}

/**
 * Calculate Relative Strength Index.
 */
export function calculateRSI(closes: number[], period: number = 14): number[] {
  return RSI.calculate({ period, values: closes });
}

// ─── Daily (1D) Analysis ────────────────────────────────────────────────────

export interface DailyAnalysis {
  isBullish: boolean;
  close: number;
  sma20: number;
  sma50: number;
  rsi: number;
}

/**
 * Analyze daily (1D) candles for trend filter.
 *
 * Bullish conditions:
 *   1. Close > SMA20
 *   2. SMA20 > SMA50
 *   3. RSI > 50
 */
export function analyzeDaily(candles: CandleData[]): DailyAnalysis | null {
  if (candles.length < 50) {
    logger.warn(MODULE, 'Not enough daily candles for analysis (need 50+)');
    return null;
  }

  const closes = candles.map((c) => c.close);

  const sma20Values = calculateSMA(closes, 20);
  const sma50Values = calculateSMA(closes, 50);
  const rsiValues = calculateRSI(closes, 14);

  if (sma20Values.length === 0 || sma50Values.length === 0 || rsiValues.length === 0) {
    logger.warn(MODULE, 'Insufficient data to calculate indicators');
    return null;
  }

  const latestClose = closes[closes.length - 1];
  const latestSMA20 = sma20Values[sma20Values.length - 1];
  const latestSMA50 = sma50Values[sma50Values.length - 1];
  const latestRSI = rsiValues[rsiValues.length - 1];

  const isBullish =
    latestClose > latestSMA20 && latestSMA20 > latestSMA50 && latestRSI > 50;

  return {
    isBullish,
    close: latestClose,
    sma20: latestSMA20,
    sma50: latestSMA50,
    rsi: latestRSI,
  };
}

// ─── 4H Analysis ────────────────────────────────────────────────────────────

export interface FourHourAnalysis {
  breakoutDetected: boolean;
  volumeSpike: boolean;
  rsiInRange: boolean;
  close: number;
  high5: number;
  avgVolume20: number;
  currentVolume: number;
  rsi: number;
  sma20: number;
  /** Breakout percentage above 5-candle high */
  breakoutStrength: number;
  /** Volume as multiple of 20-candle average */
  volumeMultiple: number;
  /** Standard deviation of closes for volatility calculation */
  volatility: number;
}

/**
 * Analyze 4H candles for entry trigger.
 *
 * BUY trigger conditions:
 *   1. Break high of last 5 candles
 *   2. Volume > 1.5x average volume (20 candles)
 *   3. RSI between 55–70
 */
export function analyze4H(candles: CandleData[]): FourHourAnalysis | null {
  if (candles.length < 25) {
    logger.warn(MODULE, 'Not enough 4H candles for analysis (need 25+)');
    return null;
  }

  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const volumes = candles.map((c) => c.volume);

  const latestCandle = candles[candles.length - 1];

  // 1. High of last 5 candles (excluding current)
  const last5Highs = highs.slice(-6, -1);
  const high5 = Math.max(...last5Highs);
  const breakoutDetected = latestCandle.close > high5;
  const breakoutStrength =
    high5 > 0 ? ((latestCandle.close - high5) / high5) * 100 : 0;

  // 2. Volume spike: current volume > 1.5x average of last 20 candles
  const last20Volumes = volumes.slice(-21, -1);
  const avgVolume20 =
    last20Volumes.reduce((sum, v) => sum + v, 0) / last20Volumes.length;
  const volumeSpike = latestCandle.volume > avgVolume20 * 1.5;
  const volumeMultiple = avgVolume20 > 0 ? latestCandle.volume / avgVolume20 : 0;

  // 3. RSI between 55–70
  const rsiValues = calculateRSI(closes, 14);
  const latestRSI = rsiValues[rsiValues.length - 1] || 0;
  const rsiInRange = latestRSI >= 55 && latestRSI <= 70;

  // 4. SMA20 for exit signal
  const sma20Values = calculateSMA(closes, 20);
  const latestSMA20 = sma20Values[sma20Values.length - 1] || 0;

  // 5. Volatility (standard deviation of closes over last 20 candles)
  const last20Closes = closes.slice(-20);
  const mean = last20Closes.reduce((s, c) => s + c, 0) / last20Closes.length;
  const variance =
    last20Closes.reduce((s, c) => s + Math.pow(c - mean, 2), 0) / last20Closes.length;
  const volatility = Math.sqrt(variance);

  return {
    breakoutDetected,
    volumeSpike,
    rsiInRange,
    close: latestCandle.close,
    high5,
    avgVolume20,
    currentVolume: latestCandle.volume,
    rsi: latestRSI,
    sma20: latestSMA20,
    breakoutStrength: Math.max(0, breakoutStrength),
    volumeMultiple,
    volatility,
  };
}

// ─── Sell Signal Check ──────────────────────────────────────────────────────

export interface SellSignal {
  shouldSell: boolean;
  reason: string;
}

/**
 * Check for sell/exit conditions on 4H data.
 *
 * Sell triggers:
 *   1. Close < SMA20 (4H)
 *   2. RSI < 45
 */
export function checkSellCondition(analysis: FourHourAnalysis): SellSignal {
  if (analysis.close < analysis.sma20) {
    return { shouldSell: true, reason: 'Close below SMA20 (4H)' };
  }
  if (analysis.rsi < 45) {
    return { shouldSell: true, reason: 'RSI below 45' };
  }
  return { shouldSell: false, reason: '' };
}

export default {
  calculateSMA,
  calculateEMA,
  calculateRSI,
  analyzeDaily,
  analyze4H,
  checkSellCondition,
};
