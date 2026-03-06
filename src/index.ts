/**
 * AI Stock Signal Scanner — Main Entry Point
 *
 * Initializes all services and starts the scheduler.
 * Supports manual scan via command-line argument: `--scan`
 */

import config from "./config/index.js";
import { initBot, sendMessage } from "./telegram/telegramService.js";
import { startScheduler, stopScheduler, triggerManualScan } from "./scheduler/cronJobs.js";
import { getTickerList } from "./services/signalService.js";
import logger from "./utils/logger.js";

const MODULE = "Main";

async function main(): Promise<void> {
  logger.info(MODULE, "");
  logger.info(MODULE, "╔══════════════════════════════════════════════╗");
  logger.info(MODULE, "║   AI STOCK SIGNAL SCANNER - INDONESIA 🇮🇩    ║");
  logger.info(MODULE, "╚══════════════════════════════════════════════╝");
  logger.info(MODULE, "");

  // ── Display configuration ────────────────────────────────────────────
  const tickers = getTickerList();
  logger.info(MODULE, `📊 Configuration:`);
  logger.info(MODULE, `   Tickers to scan: ${tickers.length}`);
  logger.info(MODULE, `   Capital: Rp ${config.capital.amount.toLocaleString("id-ID")}`);
  logger.info(MODULE, `   Risk per trade: ${(config.capital.riskPerTrade * 100).toFixed(0)}%`);
  logger.info(MODULE, `   Stop loss: ${(config.capital.stopLossPct * 100).toFixed(0)}%`);
  logger.info(MODULE, `   Max signals/day: ${config.signal.maxPerDay}`);
  logger.info(MODULE, `   Batch size: ${config.batch.size}`);
  logger.info(MODULE, `   Concurrency: ${config.batch.concurrencyLimit}`);
  logger.info(MODULE, `   Telegram: ${config.telegram.botToken ? "✅ Configured" : "⚠️  Not configured (dry run mode)"}`);
  logger.info(MODULE, "");

  // ── Initialize Telegram bot ──────────────────────────────────────────
  initBot();

  // ── Check for manual scan argument ───────────────────────────────────
  const args = process.argv.slice(2);
  if (args.includes("--scan")) {
    logger.info(MODULE, "🔧 Manual scan mode activated.");
    await triggerManualScan();
    logger.info(MODULE, "✅ Manual scan complete. Exiting.");
    process.exit(0);
  }

  // ── Start scheduler ──────────────────────────────────────────────────
  startScheduler();

  // ── Send startup notification ────────────────────────────────────────
  await sendMessage(
    `🟢 *AI Stock Signal Scanner Started*\n\n` +
      `📊 Scanning ${tickers.length} saham IDX\n` +
      `💰 Modal: Rp ${config.capital.amount.toLocaleString("id-ID")}\n` +
      `📊 Data: TradingView (1D + 4H)\n` +
      `📰 News: Yahoo Finance\n` +
      `📅 Daily scan: 08:00 WIB\n\n` +
      `_Bot siap beroperasi._`,
  );

  logger.info(MODULE, "✅ System is running. Waiting for scheduled scans...");
  logger.info(MODULE, "   Press Ctrl+C to stop.");

  // ── Graceful shutdown ────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    logger.info(MODULE, `\n🛑 Received ${signal}. Shutting down gracefully...`);
    stopScheduler();
    await sendMessage("🔴 *AI Stock Signal Scanner Stopped*");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Keep the process alive
  process.stdin.resume();
}

main().catch((error) => {
  logger.error(MODULE, `Fatal error: ${error.message}`);
  console.error(error);
  process.exit(1);
});
