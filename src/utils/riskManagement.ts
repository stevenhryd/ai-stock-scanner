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

import config from '../config/index.js';

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
 * Calculate take profit price using a risk-reward ratio.
 * @param entryPrice - Entry price per share
 * @param stopLoss - Stop loss price
 * @param rrRatio - Risk-reward ratio (default 2 means 1:2)
 */
export function calculateTakeProfit(
  entryPrice: number,
  stopLoss: number,
  rrRatio: number = 2
): number {
  const riskPerShare = entryPrice - stopLoss;
  return Math.round(entryPrice + riskPerShare * rrRatio);
}

/**
 * Calculate full position sizing for a trade.
 * @param entryPrice - Entry price per share
 * @param capital - Total capital (default from config)
 * @param riskPct - Risk per trade percentage (default from config)
 * @param slPct - Stop loss percentage (default from config)
 */
export function calculatePositionSize(
  entryPrice: number,
  capital?: number,
  riskPct?: number,
  slPct?: number
): PositionSizing {
  const totalCapital = capital ?? config.capital.amount;
  const riskPerTrade = riskPct ?? config.capital.riskPerTrade;
  const stopLossPct = slPct ?? config.capital.stopLossPct;

  // Maximum amount willing to lose on this trade
  const riskAmount = totalCapital * riskPerTrade;

  // Position size: riskAmount / stopLossPct
  const positionSize = riskAmount / stopLossPct;

  // Number of shares (rounded down to lot = 100 shares)
  const rawShares = Math.floor(positionSize / entryPrice);
  const lotSize = Math.floor(rawShares / 100);
  const shares = lotSize * 100;

  // Calculate SL and TP
  const stopLoss = calculateStopLoss(entryPrice, stopLossPct);
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
  calculateTakeProfit,
};
