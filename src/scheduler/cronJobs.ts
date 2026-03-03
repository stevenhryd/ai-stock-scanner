/**
 * Advanced Scheduler
 *
 * Schedules 4 specific jobs with exact timezones:
 *   1️⃣ 08:45 WIB: Full Scan & Ranking
 *   2️⃣ 12:05 WIB: 4H Re-Check (Watchlist)
 *   3️⃣ 15:40 WIB: Exit / Momentum Check
 *   4️⃣ 00:00 WIB: Reset Daily Counter & Watchlist
 */

import cron from "node-cron";
import config from "../config/index.js";
import { generateSignals, checkExitSignals, getTickerList } from "../services/signalService.js";
import { fetchAllTickers, getFetchSummary } from "../services/dataService.js";
import { analyze4H } from "../services/indicatorService.js";
import { sendDailySummary, sendExitSignal, sendMessage } from "../telegram/telegramService.js";
import { getWatchlist, addWatchlistStock, resetDailyState, getTodayState } from "./dailyStateService.js";
import logger from "../utils/logger.js";

const MODULE = "Scheduler";
const TIMEZONE = "Asia/Jakarta";

let job0845: cron.ScheduledTask | null = null;
let job1205: cron.ScheduledTask | null = null;
let job1540: cron.ScheduledTask | null = null;
let job0000: cron.ScheduledTask | null = null;

// ==========================================
// 1️⃣ 08:45 WIB — FULL SCAN
// ==========================================
async function runMorningScan(): Promise<void> {
  logger.info(MODULE, "🚀 ============================================");
  logger.info(MODULE, "🚀  [08:45] Starting full morning scan...");
  logger.info(MODULE, "🚀 ============================================");

  try {
    const signals = await generateSignals();

    // Add generated signals to today's watchlist
    signals.forEach((signal) => addWatchlistStock(signal.ticker));

    logger.info(MODULE, `[08:45] Scan completed. Found ${signals.length} signal(s).`);

    // Kirim notifikasi jika ada ticker yang gagal diambil datanya
    const summary = getFetchSummary();
    if (summary.failed > 0) {
      const parts: string[] = [];
      if (summary.rateLimited.length > 0) parts.push(`⏳ *Rate limited (${summary.rateLimited.length}):* ${summary.rateLimited.map((t) => t.replace(".JK", "")).join(", ")}`);
      if (summary.notFound.length > 0) parts.push(`❓ *Tidak ditemukan (${summary.notFound.length}):* ${summary.notFound.map((t) => t.replace(".JK", "")).join(", ")}`);
      if (summary.otherErrors.length > 0) parts.push(`💥 *Error lain (${summary.otherErrors.length}):* ${summary.otherErrors.map((t) => t.replace(".JK", "")).join(", ")}`);
      await sendMessage(`⚠️ *[08:45] Peringatan Data Fetch*\n\n` + `Berhasil: ${summary.success} ticker\nGagal: ${summary.failed} ticker\n\n` + parts.join("\n") + `\n\n_Ticker yang gagal tidak ikut di-scan. Cek koneksi VPS ke Yahoo Finance._`);
    }

    if (signals.length > 0) {
      await sendDailySummary(signals);
    } else {
      const date = new Date().toLocaleDateString("id-ID", {
        timeZone: "Asia/Jakarta",
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      });
      await sendMessage(
        `🔍 *AI STOCK SIGNAL SCANNER*\n📅 ${date}\n\n` + `📊 *[08:45] Full Scan Selesai*\n\n` + `❌ Tidak ada saham yang memenuhi kriteria sinyal BUY hari ini.\n\n` + `_Sistem tetap berjalan dan akan melakukan re-check pada pukul 12:05 WIB._`,
      );
    }
  } catch (error: any) {
    logger.error(MODULE, `Morning scan failed: ${error.message}`);
    await sendMessage(`⚠️ *[08:45] Morning Scan Gagal*\n\nError: ${error.message}\n\n_Sistem tetap berjalan._`);
  }
}

// ==========================================
// 2️⃣ 12:05 WIB — 4H RE-CHECK
// ==========================================
async function runMiddayCheck(): Promise<void> {
  logger.info(MODULE, "⏰ [12:05] Running midday 4H re-check...");

  const state = getTodayState();

  if (state.buySignalsSent >= config.signal.maxPerDay) {
    logger.info(MODULE, "[12:05] Daily BUY limit reached. Skipping midday check.");
    await sendMessage(
      `⏰ *[12:05] Midday Re-Check*\n\n` + `✅ Batas sinyal harian sudah tercapai (${state.buySignalsSent}/${config.signal.maxPerDay} sinyal terkirim).\n\n` + `_Tidak ada sinyal tambahan yang dikirim. Pantau exit check pukul 15:40 WIB._`,
    );
    return;
  }

  try {
    // Generate new signals to see if any new stocks broke out
    const signals = await generateSignals();

    // Filter out stocks already in watchlist
    const newSignals = signals.filter((s) => !state.watchlist.includes(s.ticker));

    if (newSignals.length > 0) {
      newSignals.forEach((signal) => addWatchlistStock(signal.ticker));
      logger.info(MODULE, `[12:05] Found ${newSignals.length} NEW signal(s).`);
      await sendDailySummary(newSignals);
    } else {
      logger.info(MODULE, "[12:05] No new signals found during re-check.");

      // Kirim notifikasi jika ada ticker yang gagal
      const summary = getFetchSummary();
      const errorInfo = summary.failed > 0 ? `\n⚠️ Gagal fetch: ${summary.failed} ticker (rate limit: ${summary.rateLimited.length}, error: ${summary.otherErrors.length})` : "";

      await sendMessage(
        `⏰ *[12:05] Midday Re-Check Selesai*\n\n` +
          `❌ Tidak ada sinyal baru yang ditemukan.\n` +
          `📋 Sinyal hari ini: ${state.buySignalsSent}/${config.signal.maxPerDay}\n` +
          `👀 Watchlist aktif: ${state.watchlist.length > 0 ? state.watchlist.map((t) => t.replace(".JK", "")).join(", ") : "Kosong"}` +
          errorInfo +
          `\n\n_Pantau exit check pukul 15:40 WIB._`,
      );
    }
  } catch (error: any) {
    logger.error(MODULE, `Midday check failed: ${error.message}`);
    await sendMessage(`⚠️ *[12:05] Midday Check Gagal*\n\nError: ${error.message}\n\n_Sistem tetap berjalan._`);
  }
}

// ==========================================
// 3️⃣ 15:40 WIB — EXIT / MOMENTUM CHECK
// ==========================================
async function runExitCheck(): Promise<void> {
  logger.info(MODULE, "🛑 [15:40] Running exit/momentum check on watchlist...");

  const watchlist = getWatchlist();
  if (watchlist.length === 0) {
    logger.info(MODULE, "[15:40] Watchlist empty. Nothing to check.");
    await sendMessage(
      `🛑 *[15:40] Exit Check Selesai*\n\n` +
        `📋 Watchlist hari ini kosong — tidak ada posisi yang dipantau.\n` +
        `📊 Sinyal terkirim hari ini: ${getTodayState().buySignalsSent}/${config.signal.maxPerDay}\n\n` +
        `_Sistem tetap berjalan. Sampai besok! 👋_`,
    );
    return;
  }

  try {
    const exitSignals = await checkExitSignals(watchlist);

    if (exitSignals.length > 0) {
      logger.warn(MODULE, `[15:40] Found ${exitSignals.length} EXIT condition(s).`);
      for (const exit of exitSignals) {
        // Find current price (proxy from latest data)
        const currentData = await fetchAllTickers([exit.ticker], "1h", "1mo");
        const candles = currentData[0]?.candles || [];
        const currentPrice = candles[candles.length - 1]?.close || 0;

        await sendExitSignal(exit.ticker, exit.sell.reason, currentPrice);
        // Small delay to prevent rate limits
        await new Promise((res) => setTimeout(res, 1000));
      }
    } else {
      logger.info(MODULE, "[15:40] All watchlist stocks holding strong. No exits.");
    }

    // Optional daily summary message
    await sendMessage(`📊 *End of Day Summary*\n\nWatchlist hari ini: ${watchlist.length} saham.\nExit signals: ${exitSignals.length}.\nSinyal Terkirim: ${getTodayState().buySignalsSent}/${config.signal.maxPerDay}\n\n_Good work today!_`);
  } catch (error: any) {
    logger.error(MODULE, `Exit check failed: ${error.message}`);
  }
}

// ==========================================
// 4️⃣ 00:00 WIB — RESET DAILY STATE
// ==========================================
function runDailyReset(): void {
  logger.info(MODULE, "🔄 [00:00] Running daily state reset...");
  resetDailyState();
}

/**
 * Start all scheduled cron jobs explicitly in Asia/Jakarta timezone.
 */
export function startScheduler(): void {
  logger.info(MODULE, `📅 Starting advanced scheduler (Timezone: ${TIMEZONE})...`);

  // 1️⃣ 08:45 WIB (Mon-Fri)
  job0845 = cron.schedule("45 8 * * 1-5", runMorningScan, { timezone: TIMEZONE });
  logger.info(MODULE, `   [08:45] Full Scan scheduled.`);

  // 2️⃣ 12:05 WIB (Mon-Fri)
  job1205 = cron.schedule("5 12 * * 1-5", runMiddayCheck, { timezone: TIMEZONE });
  logger.info(MODULE, `   [12:05] Midday Check scheduled.`);

  // 3️⃣ 15:40 WIB (Mon-Fri)
  job1540 = cron.schedule("40 15 * * 1-5", runExitCheck, { timezone: TIMEZONE });
  logger.info(MODULE, `   [15:40] Exit Check scheduled.`);

  // 4️⃣ 00:00 WIB (Every Day)
  job0000 = cron.schedule("0 0 * * *", runDailyReset, { timezone: TIMEZONE });
  logger.info(MODULE, `   [00:00] Daily Reset scheduled.`);

  logger.info(MODULE, "✅ All cron jobs active.");
}

/**
 * Stop all cron jobs.
 */
export function stopScheduler(): void {
  job0845?.stop();
  job1205?.stop();
  job1540?.stop();
  job0000?.stop();
  logger.info(MODULE, "🛑 Scheduler stopped.");
}

/**
 * Manually trigger scanning (useful for arbitrary testing).
 */
export async function triggerManualScan(): Promise<void> {
  logger.info(MODULE, "🔧 Manual scan triggered...");
  await runMorningScan();
}

export default {
  startScheduler,
  stopScheduler,
  triggerManualScan,
};
