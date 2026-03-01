/**
 * Telegram Service
 *
 * Handles formatting and sending trading signals to Telegram.
 * Uses dailyStateService to enforce limits.
 */

import TelegramBot from 'node-telegram-bot-api';
import config from '../config/index.js';
import { BuySignal } from '../services/signalService.js';
import { getTodayState, incrementBuyCounter } from '../scheduler/dailyStateService.js';
import logger from '../utils/logger.js';

const MODULE = 'TelegramService';

let bot: TelegramBot | null = null;

/**
 * Initialize the Telegram bot instance.
 */
export function initBot(): void {
  if (!config.telegram.botToken) {
    logger.warn(MODULE, 'Telegram bot token not configured. Messages will be logged only.');
    return;
  }

  bot = new TelegramBot(config.telegram.botToken, { polling: false });
  logger.info(MODULE, '✅ Telegram bot initialized.');
}

/**
 * Get remaining signals for today from persistent daily state.
 */
export function getRemainingSignals(): number {
  const state = getTodayState();
  return Math.max(0, config.signal.maxPerDay - state.buySignalsSent);
}

/**
 * Format a number as Indonesian Rupiah.
 */
function formatRupiah(amount: number): string {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

/**
 * Format a buy signal into a Telegram message.
 */
export function formatBuyMessage(signal: BuySignal): string {
  const timestamp = signal.timestamp.toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

  return `📈 *SWING BUY SIGNAL*

🏷 *Stock:* \`${signal.ticker.replace('.JK', '')}\` (${signal.ticker})
⭐ *Score:* ${signal.score}/100
💰 *Entry:* ${formatRupiah(signal.entry)}
🛑 *Stop Loss:* ${formatRupiah(signal.stopLoss)}
🎯 *Take Profit:* ${formatRupiah(signal.takeProfit)}
📊 *Timeframe:* 4H
📈 *Trend 1D:* ✅ Bullish

📦 *Position Sizing:*
├ Modal: ${formatRupiah(config.capital.amount)}
├ Risk: ${formatRupiah(signal.riskAmount)} (${(config.capital.riskPerTrade * 100).toFixed(0)}%)
├ Lot Size: ${signal.lotSize} lot (${signal.shares} lembar)
└ Position: ${formatRupiah(signal.positionSize)}

📋 *Score Breakdown:*
├ Breakout: ${signal.breakdown.breakoutScore}/100 (30%)
├ Volume: ${signal.breakdown.volumeScore}/100 (20%)
├ RSI: ${signal.breakdown.rsiScore}/100 (15%)
├ Trend: ${signal.breakdown.trendScore}/100 (20%)
└ Volatility: ${signal.breakdown.volatilityScore}/100 (15%)

⏰ *Time:* ${timestamp} WIB

⚠️ _Disclaimer: Sinyal ini bukan saran investasi. Lakukan riset sendiri sebelum mengambil keputusan._`;
}

/**
 * Format an exit (sell) signal message.
 */
export function formatExitMessage(ticker: string, reason: string, currentPrice: number): string {
  const timestamp = new Date().toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
  });

  return `🔴 *EXIT WARNING*

🏷 *Stock:* \`${ticker.replace('.JK', '')}\` (${ticker})
💰 *Current Price:* ${formatRupiah(currentPrice)}
⚠️ *Reason:* ${reason}

Disarankan untuk melepas posisi atau memindahkan Stop Loss (Trailing Stop) untuk melindungi modal.

⏰ *Time:* ${timestamp} WIB`;
}

/**
 * Format a daily summary header message.
 */
export function formatSummaryHeader(signalCount: number): string {
  const date = new Date().toLocaleDateString('id-ID', {
    timeZone: 'Asia/Jakarta',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  return `🔔 *AI STOCK SIGNAL SCANNER*
📅 ${date}
📊 Total sinyal baru: ${signalCount}

${'─'.repeat(30)}`;
}

/**
 * Send a single buy signal via Telegram and track it in state.
 */
export async function sendSignal(signal: BuySignal): Promise<boolean> {
  const remaining = getRemainingSignals();
  if (remaining <= 0) {
    logger.warn(MODULE, `Daily signal limit reached (${config.signal.maxPerDay}). Skipping ${signal.ticker}.`);
    return false;
  }

  const message = formatBuyMessage(signal);

  if (!bot || !config.telegram.chatId) {
    logger.info(MODULE, '📩 [DRY RUN] Would send signal:');
    console.log(message);
    incrementBuyCounter();
    return true;
  }

  try {
    await bot.sendMessage(config.telegram.chatId, message, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });
    incrementBuyCounter();
    const state = getTodayState();
    logger.info(MODULE, `📩 Signal sent for ${signal.ticker} (${state.buySignalsSent}/${config.signal.maxPerDay} today)`);
    return true;
  } catch (error: any) {
    logger.error(MODULE, `Failed to send signal for ${signal.ticker}: ${error.message}`);
    return false;
  }
}

/**
 * Send an exit signal. (Exit signals do NOT count against daily limits).
 */
export async function sendExitSignal(ticker: string, reason: string, currentPrice: number): Promise<boolean> {
  const message = formatExitMessage(ticker, reason, currentPrice);

  if (!bot || !config.telegram.chatId) {
    logger.info(MODULE, '📩 [DRY RUN] Would send EXIT signal:');
    console.log(message);
    return true;
  }

  try {
    await bot.sendMessage(config.telegram.chatId, message, { parse_mode: 'Markdown' });
    logger.info(MODULE, `📩 EXIT Signal sent for ${ticker}`);
    return true;
  } catch (error: any) {
    logger.error(MODULE, `Failed to send EXIT signal for ${ticker}: ${error.message}`);
    return false;
  }
}

/**
 * Send a batch of new buy signals.
 */
export async function sendDailySummary(signals: BuySignal[]): Promise<void> {
  if (signals.length === 0) {
    logger.info(MODULE, 'No new signals to send.');
    
    // Only send empty report once per day for the morning scan usually,
    // if we wanted to we could add it here but it's often noisy.
    return;
  }

  // Determine how many we can actually send
  const remaining = getRemainingSignals();
  const sendableSignals = signals.slice(0, remaining);

  if (sendableSignals.length === 0) {
    logger.warn(MODULE, 'Daily limit already hit. Ignoring batch.');
    return;
  }

  // Send header
  const header = formatSummaryHeader(sendableSignals.length);
  if (bot && config.telegram.chatId) {
    try {
      await bot.sendMessage(config.telegram.chatId, header, { parse_mode: 'Markdown' });
    } catch (error: any) {
      logger.error(MODULE, `Failed to send header: ${error.message}`);
    }
  } else {
    console.log(header);
  }

  // Send each signal with a small delay to avoid rate limits
  for (const signal of sendableSignals) {
    await sendSignal(signal);
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  logger.info(MODULE, `✅ Batch sending complete. Sent ${sendableSignals.length} signal(s).`);
}

/**
 * Send a custom text message.
 */
export async function sendMessage(text: string): Promise<void> {
  if (!bot || !config.telegram.chatId) {
    logger.info(MODULE, `📩 [DRY RUN] ${text}`);
    return;
  }

  try {
    await bot.sendMessage(config.telegram.chatId, text, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });
  } catch (error: any) {
    logger.error(MODULE, `Failed to send message: ${error.message}`);
  }
}

export default {
  initBot,
  getRemainingSignals,
  formatBuyMessage,
  formatExitMessage,
  sendSignal,
  sendExitSignal,
  sendDailySummary,
  sendMessage,
};
