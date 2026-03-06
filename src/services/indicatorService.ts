/**
 * Indicator Service
 *
 * Analyzes TradingView indicator data for 1D (trend filter) and 4H (entry trigger).
 * TradingView already computes RSI, MACD, SMA, EMA, ADX, ATR — this service
 * applies the trading logic on top of those pre-computed values.
 */

import { TradingViewIndicators } from "./dataService.js";
import logger from "../utils/logger.js";

const MODULE = "IndicatorService";

// ─── Daily (1D) Analysis ────────────────────────────────────────────────────

export interface DailyAnalysis {
  isBullish: boolean;
  close: number;
  sma20: number;
  sma50: number;
  ema20: number;
  ema50: number;
  rsi: number;
  /** TradingView recommendation summary: -1 (SELL) to 1 (BUY) */
  recommendAll: number;
}

/**
 * Analyze daily (1D) TradingView indicators for trend filter.
 *
 * Bullish conditions (at least 2 of 3 must be true):
 *   1. Close > SMA20 (price above short-term average)
 *   2. EMA20 > EMA50 (moving average uptrend)
 *   3. RSI > 45 (not oversold)
 * Plus: TradingView overall recommendation must be neutral or better (>= 0)
 */
export function analyzeDaily(indicators: TradingViewIndicators): DailyAnalysis | null {
  if (indicators.close <= 0 || indicators.sma20 <= 0) {
    logger.debug(MODULE, "Insufficient daily indicator data");
    return null;
  }

  const cond1 = indicators.close > indicators.sma20;
  const cond2 = indicators.ema20 > 0 && indicators.ema50 > 0 && indicators.ema20 > indicators.ema50;
  const cond3 = indicators.rsi > 45;
  const condCount = (cond1 ? 1 : 0) + (cond2 ? 1 : 0) + (cond3 ? 1 : 0);

  // At least 2 of 3 conditions, and TradingView overall rec not sell
  const isBullish = condCount >= 2 && indicators.recommendAll >= 0;

  return {
    isBullish,
    close: indicators.close,
    sma20: indicators.sma20,
    sma50: indicators.sma50,
    ema20: indicators.ema20,
    ema50: indicators.ema50,
    rsi: indicators.rsi,
    recommendAll: indicators.recommendAll,
  };
}

// ─── 4H Analysis ────────────────────────────────────────────────────────────

export interface FourHourAnalysis {
  /** Whether current close breaks above recent resistance */
  breakoutDetected: boolean;
  /** Whether volume exceeds 1.5x average */
  volumeSpike: boolean;
  /** Whether RSI is in the sweet spot (55–70) */
  rsiInRange: boolean;
  close: number;
  open: number;
  high: number;
  low: number;
  avgVolume20: number;
  currentVolume: number;
  rsi: number;
  sma20: number;
  ema20: number;
  /** Volume as multiple of 20-period average */
  volumeMultiple: number;
  /** Whether candle is bullish (close > open) */
  isBullishCandle: boolean;
  /** Whether MACD line is above signal line */
  macdBullish: boolean;
  /** MACD histogram value */
  macdHist: number;
  /** ADX value (>=25 is strong trend) */
  adx: number;
  /** ATR(14) for dynamic SL sizing */
  atr: number;
  /** TradingView recommendation: -1 (SELL) to 1 (BUY) */
  recommendAll: number;
  recommendMA: number;
  recommendOsc: number;
}

/**
 * Analyze 4H TradingView indicators for entry trigger.
 *
 * BUY trigger conditions (relaxed for higher signal count):
 *   1. Close > SMA20 OR Close > EMA20 (above short-term average)
 *   2. Volume > 1.2x average volume (relaxed from 1.5x)
 *   3. RSI between 45–80 (wider range)
 */
export function analyze4H(indicators: TradingViewIndicators): FourHourAnalysis | null {
  if (indicators.close <= 0) {
    logger.debug(MODULE, "No valid 4H data");
    return null;
  }

  // Breakout: close above SMA20 OR EMA20
  const breakoutDetected = (indicators.sma20 > 0 && indicators.close > indicators.sma20) || (indicators.ema20 > 0 && indicators.close > indicators.ema20);

  // Volume spike: current volume > 1.2x average (relaxed)
  const volumeMultiple = indicators.avgVolume20 > 0 ? indicators.volume / indicators.avgVolume20 : 0;
  const volumeSpike = volumeMultiple > 1.2;

  // RSI range (wider)
  const rsiInRange = indicators.rsi >= 45 && indicators.rsi <= 80;

  // MACD bullish: MACD line > signal line
  const macdBullish = indicators.macdLine > indicators.macdSignal;

  // Bullish candle
  const isBullishCandle = indicators.close > indicators.open;

  return {
    breakoutDetected,
    volumeSpike,
    rsiInRange,
    close: indicators.close,
    open: indicators.open,
    high: indicators.high,
    low: indicators.low,
    avgVolume20: indicators.avgVolume20,
    currentVolume: indicators.volume,
    rsi: indicators.rsi,
    sma20: indicators.sma20,
    ema20: indicators.ema20,
    volumeMultiple,
    isBullishCandle,
    macdBullish,
    macdHist: indicators.macdHist,
    adx: indicators.adx,
    atr: indicators.atr,
    recommendAll: indicators.recommendAll,
    recommendMA: indicators.recommendMA,
    recommendOsc: indicators.recommendOsc,
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
  if (analysis.sma20 > 0 && analysis.close < analysis.sma20) {
    return { shouldSell: true, reason: "Close below SMA20 (4H)" };
  }
  if (analysis.rsi < 45) {
    return { shouldSell: true, reason: "RSI below 45" };
  }
  return { shouldSell: false, reason: "" };
}

export default {
  analyzeDaily,
  analyze4H,
  checkSellCondition,
};
