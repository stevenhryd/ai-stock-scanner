/**
 * Risk Management Utility
 *
 * Calculates position sizing, stop loss, and take profit levels
 * based on the user's capital and risk parameters.
 *
 * Defaults:
 *   - Modal: Rp 3.000.000
 *   - Risk per trade: 2%
 *   - Stop loss: 3%
 *   - Risk-Reward ratio: 1:2
 */

import config from "../config/index.js";

export interface PositionSizing {
  /** Maximum amount at risk per trade (Rp) */
  riskAmount: number;
  /** Recommended position size in Rp */
  positionSize: number;
  /** Recommended lot count (1 lot = 100 shares) */
  lotSize: number;
  /** Number of shares */
  shares: number;
  /** Stop loss price */
  stopLoss: number;
  /** Take profit price (R:R 1:2) */
  takeProfit: number;
}

/**
 * Calculate stop loss price.
 * @param entryPrice - Entry price per share
 * @param stopLossPct - Stop loss percentage (e.g., 0.03 for 3%)
 */
export function calculateStopLoss(entryPrice: number, stopLossPct?: number): number {
  const slPct = stopLossPct ?? config.capital.stopLossPct;
  return Math.round(entryPrice * (1 - slPct));
}

/**
 * Calculate ATR-based stop loss price.
 * Uses 1.5x ATR below entry for a volatility-adapted stop.
 * Falls back to percentage-based SL if ATR is zero or unavailable.
 * @param entryPrice - Entry price per share
 * @param atr - Average True Range (14-period)
 * @param multiplier - ATR multiplier (default 1.5)
 */
export function calculateATRStopLoss(entryPrice: number, atr: number, multiplier: number = 1.5): number {
  if (!atr || atr <= 0) return calculateStopLoss(entryPrice);
  return Math.round(entryPrice - atr * multiplier);
}

/**
 * Calculate take profit price using a risk-reward ratio.
 * @param entryPrice - Entry price per share
 * @param stopLoss - Stop loss price
 * @param rrRatio - Risk-reward ratio (default 2 means 1:2)
 */
export function calculateTakeProfit(entryPrice: number, stopLoss: number, rrRatio: number = 2): number {
  const riskPerShare = entryPrice - stopLoss;
  return Math.round(entryPrice + riskPerShare * rrRatio);
}

/**
 * Calculate full position sizing for a trade.
 * When `atr` is provided, uses ATR-based stop loss (1.5x ATR) which adapts to
 * real volatility instead of a fixed percentage.
 * @param entryPrice - Entry price per share
 * @param capital - Total capital (default from config)
 * @param riskPct - Risk per trade percentage (default from config)
 * @param slPct - Stop loss percentage fallback (default from config)
 * @param atr - Average True Range for dynamic SL (preferred over slPct when > 0)
 */
export function calculatePositionSize(entryPrice: number, capital?: number, riskPct?: number, slPct?: number, atr?: number): PositionSizing {
  const totalCapital = capital ?? config.capital.amount;
  const riskPerTrade = riskPct ?? config.capital.riskPerTrade;

  // Maximum amount willing to lose on this trade
  const riskAmount = totalCapital * riskPerTrade;

  // Choose stop loss method: ATR-based (dynamic) or percentage-based (fixed)
  let stopLoss: number;
  let effectiveSlPct: number;

  if (atr && atr > 0) {
    stopLoss = calculateATRStopLoss(entryPrice, atr);
    effectiveSlPct = (entryPrice - stopLoss) / entryPrice;
    // Guard: if ATR SL is tighter than 1% or wider than 6%, fall back to fixed SL
    if (effectiveSlPct < 0.01 || effectiveSlPct > 0.06) {
      const fallbackPct = slPct ?? config.capital.stopLossPct;
      stopLoss = calculateStopLoss(entryPrice, fallbackPct);
      effectiveSlPct = fallbackPct;
    }
  } else {
    const stopLossPct = slPct ?? config.capital.stopLossPct;
    stopLoss = calculateStopLoss(entryPrice, stopLossPct);
    effectiveSlPct = stopLossPct;
  }

  // Position size: riskAmount / stopLossPct
  const positionSize = riskAmount / effectiveSlPct;

  // Number of shares (rounded down to lot = 100 shares)
  const rawShares = Math.floor(positionSize / entryPrice);
  const lotSize = Math.floor(rawShares / 100);
  const shares = lotSize * 100;

  const takeProfit = calculateTakeProfit(entryPrice, stopLoss);

  return {
    riskAmount: Math.round(riskAmount),
    positionSize: Math.round(positionSize),
    lotSize,
    shares,
    stopLoss,
    takeProfit,
  };
}

export default {
  calculatePositionSize,
  calculateStopLoss,
  calculateATRStopLoss,
  calculateTakeProfit,
};
