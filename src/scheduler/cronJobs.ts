/**
 * Advanced Scheduler
 *
 * Schedules 4 specific jobs with exact timezones:
 *   1️⃣ 06:30 WIB: Full Scan & Ranking (pagi sebelum market buka 09:00, selesai ~07:30-08:00)
 *   2️⃣ 12:05 WIB: Midday Hold/Exit Check (cek sinyal pagi)
 *   3️⃣ 15:40 WIB: Exit / Momentum Check
 *   4️⃣ 06:15 WIB: Reset Daily Counter & Watchlist (sebelum scan pagi)
 */

import cron from "node-cron";
import config from "../config/index.js";
import { generateSignals, checkExitSignals, getTickerList } from "../services/signalService.js";
import { fetchAllTickers, getFetchSummary } from "../services/dataService.js";
import { analyze4H } from "../services/indicatorService.js";
import { sendDailySummary, sendExitSignal, sendMessage } from "../telegram/telegramService.js";
import { getWatchlist, addWatchlistStock, addWatchlistPosition, getActivePositions, closePosition, isPositionClosed, resetDailyState, getTodayState } from "./dailyStateService.js";
import logger from "../utils/logger.js";

const MODULE = "Scheduler";
const TIMEZONE = "Asia/Jakarta";

let job1630: cron.ScheduledTask | null = null;
let job1205: cron.ScheduledTask | null = null;
let job1540: cron.ScheduledTask | null = null;
let job1615: cron.ScheduledTask | null = null;

// ==========================================
// 1️⃣ 06:30 WIB — FULL SCAN (PAGI SEBELUM MARKET BUKA)
// ==========================================
async function runMorningScan(): Promise<void> {
  const startedAt = Date.now();

  logger.info(MODULE, "🚀 ============================================");
  logger.info(MODULE, "🚀  [06:30] Starting full scan (pre-market)...");
  logger.info(MODULE, "🚀 ============================================");

  try {
    await sendMessage(`⏳ *[06:30] Full Scan Dimulai*\n\nScanner mulai memproses ticker sekarang.\nProses berjalan pagi hari agar selesai sebelum market buka (09:00 WIB).`);

    const signals = await generateSignals();
    const durationMin = ((Date.now() - startedAt) / 60000).toFixed(1);

    // Add generated signals to today's watchlist with full position data
    signals.forEach((signal) => {
      addWatchlistStock(signal.ticker);
      addWatchlistPosition(signal.ticker, signal.entry, signal.stopLoss, signal.takeProfit, signal.score);
    });

    logger.info(MODULE, `[06:30] Scan completed. Found ${signals.length} signal(s).`);

    // Kirim notifikasi jika ada ticker yang gagal diambil datanya
    const summary = getFetchSummary();
    if (summary.failed > 0) {
      const parts: string[] = [];
      if (summary.rateLimited.length > 0) parts.push(`⏳ *Rate limited (${summary.rateLimited.length}):* ${summary.rateLimited.map((t) => t.replace(".JK", "")).join(", ")}`);
      if (summary.notFound.length > 0) parts.push(`❓ *Tidak ditemukan (${summary.notFound.length}):* ${summary.notFound.map((t) => t.replace(".JK", "")).join(", ")}`);
      if (summary.otherErrors.length > 0) parts.push(`💥 *Error lain (${summary.otherErrors.length}):* ${summary.otherErrors.map((t) => t.replace(".JK", "")).join(", ")}`);
      await sendMessage(`⚠️ *Peringatan Data Fetch*\n\n` + `Berhasil: ${summary.success} ticker\nGagal: ${summary.failed} ticker\n\n` + parts.join("\n") + `\n\n_Ticker yang gagal tidak ikut di-scan._`);
    }

    if (signals.length > 0) {
      await sendDailySummary(signals);
      await sendMessage(`✅ *Full Scan Selesai*\n\nDurasi proses: ${durationMin} menit.\nSignal terkirim: ${signals.length}\n\n_Sinyal akan dicek ulang pada 12:05 dan 15:40 WIB._`);
    } else {
      const date = new Date().toLocaleDateString("id-ID", {
        timeZone: "Asia/Jakarta",
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      });
      await sendMessage(
        `🔍 *AI STOCK SIGNAL SCANNER*\n📅 ${date}\n\n` +
          `📊 *Full Scan Selesai* (${durationMin} menit)\n\n` +
          `❌ Tidak ada saham yang memenuhi kriteria sinyal BUY hari ini.\n\n` +
          `_Sistem tetap berjalan dan akan melakukan re-check pada pukul 12:05 WIB._`,
      );
    }
  } catch (error: any) {
    logger.error(MODULE, `Morning scan failed: ${error.message}`);
    await sendMessage(`⚠️ *Full Scan Gagal*\n\nError: ${error.message}\n\n_Sistem tetap berjalan._`);
  }
}

// ==========================================
// 2️⃣ 12:05 WIB — MIDDAY HOLD/EXIT CHECK
// ==========================================
async function runMiddayCheck(): Promise<void> {
  logger.info(MODULE, "⏰ [12:05] Running midday hold/exit check on morning signals...");

  const activePositions = getActivePositions();
  const state = getTodayState();

  if (activePositions.length === 0) {
    logger.info(MODULE, "[12:05] Tidak ada posisi aktif yang perlu dicek.");
    await sendMessage(`⏰ *[12:05] Midday Check Selesai*\n\n` + `📋 Tidak ada posisi aktif dari sinyal pagi.\n\n` + `_Sistem tetap berjalan. Exit check berikutnya pukul 15:40 WIB._`);
    return;
  }

  try {
    const tickers = activePositions.map((p) => p.ticker);
    logger.info(MODULE, `[12:05] Checking ${tickers.length} active position(s): ${tickers.map((t) => t.replace(".JK", "")).join(", ")}`);

    // Fetch current prices
    const dataList = await fetchAllTickers(tickers, "1h", "1mo");

    const holdList: string[] = [];
    const slHitList: { ticker: string; entry: number; sl: number; current: number }[] = [];
    const tpHitList: { ticker: string; entry: number; tp: number; current: number }[] = [];
    const technicalExitList: { ticker: string; reason: string; current: number }[] = [];

    for (const pos of activePositions) {
      const tickerData = dataList.find((d) => d.ticker === pos.ticker);
      if (!tickerData || tickerData.candles.length === 0) {
        holdList.push(pos.ticker); // can't check, assume hold
        continue;
      }

      const currentPrice = tickerData.candles[tickerData.candles.length - 1].close;

      // Check SL hit
      if (currentPrice <= pos.stopLoss) {
        slHitList.push({ ticker: pos.ticker, entry: pos.entry, sl: pos.stopLoss, current: currentPrice });
        closePosition(pos.ticker, "hit_sl");
        continue;
      }

      // Check TP hit
      if (currentPrice >= pos.takeProfit) {
        tpHitList.push({ ticker: pos.ticker, entry: pos.entry, tp: pos.takeProfit, current: currentPrice });
        closePosition(pos.ticker, "hit_tp");
        continue;
      }

      // Technical exit check (RSI, SMA breakdown)
      const fourHourCandles = tickerData.candles.filter((_, i) => i % 4 === 3 || i === tickerData.candles.length - 1);
      const analysis = analyze4H(fourHourCandles);
      if (analysis) {
        const { checkSellCondition } = await import("../services/indicatorService.js");
        const sell = checkSellCondition(analysis);
        if (sell.shouldSell) {
          technicalExitList.push({ ticker: pos.ticker, reason: sell.reason, current: currentPrice });
          // Don't auto-close on technical — just warn. User decides.
          continue;
        }
      }

      // All good — HOLD
      const pnlPct = (((currentPrice - pos.entry) / pos.entry) * 100).toFixed(2);
      holdList.push(`${pos.ticker} (${Number(pnlPct) >= 0 ? "+" : ""}${pnlPct}%)`);
    }

    // Send SL hit notifications
    for (const sl of slHitList) {
      const lossPct = (((sl.current - sl.entry) / sl.entry) * 100).toFixed(2);
      await sendMessage(
        `🛑 *STOP LOSS HIT*\n\n` +
          `🏷 *Stock:* \`${sl.ticker.replace(".JK", "")}\`\n` +
          `💰 Entry: ${formatRupiahSimple(sl.entry)}\n` +
          `🛑 SL: ${formatRupiahSimple(sl.sl)}\n` +
          `📉 Harga Sekarang: ${formatRupiahSimple(sl.current)} (${lossPct}%)\n\n` +
          `_Posisi dihapus dari watchlist. Tidak ada notif lagi untuk saham ini hari ini._`,
      );
      await new Promise((res) => setTimeout(res, 1000));
    }

    // Send TP hit notifications
    for (const tp of tpHitList) {
      const profitPct = (((tp.current - tp.entry) / tp.entry) * 100).toFixed(2);
      await sendMessage(
        `🎯 *TAKE PROFIT HIT*\n\n` +
          `🏷 *Stock:* \`${tp.ticker.replace(".JK", "")}\`\n` +
          `💰 Entry: ${formatRupiahSimple(tp.entry)}\n` +
          `🎯 TP: ${formatRupiahSimple(tp.tp)}\n` +
          `📈 Harga Sekarang: ${formatRupiahSimple(tp.current)} (+${profitPct}%)\n\n` +
          `🎉 _Selamat! Target tercapai. Posisi dihapus dari watchlist._`,
      );
      await new Promise((res) => setTimeout(res, 1000));
    }

    // Build summary
    const holdText = holdList.length > 0 ? holdList.map((t) => `✅ ${typeof t === "string" && t.includes("(") ? t.replace(".JK", "") : String(t).replace(".JK", "")}`).join("\n") : "_Tidak ada_";

    const warnText = technicalExitList.length > 0 ? technicalExitList.map((e) => `⚠️ ${e.ticker.replace(".JK", "")} — ${e.reason} (Rp ${e.current.toLocaleString("id-ID")})`).join("\n") : "_Tidak ada_";

    const closedText: string[] = [];
    if (slHitList.length > 0) closedText.push(...slHitList.map((s) => `🛑 ${s.ticker.replace(".JK", "")} — SL Hit`));
    if (tpHitList.length > 0) closedText.push(...tpHitList.map((t) => `🎯 ${t.ticker.replace(".JK", "")} — TP Hit`));

    await sendMessage(
      `⏰ *[12:05] Midday Hold/Exit Check*\n\n` +
        `📊 Diperiksa: ${activePositions.length} posisi aktif\n\n` +
        `💎 *HOLD (Masih Kuat):*\n${holdText}\n\n` +
        `⚠️ *PERHATIAN (Teknikal Melemah):*\n${warnText}\n\n` +
        (closedText.length > 0 ? `🚫 *DITUTUP OTOMATIS:*\n${closedText.join("\n")}\n\n` : "") +
        `📋 Sinyal hari ini: ${state.buySignalsSent}/${config.signal.maxPerDay}\n\n` +
        `_Exit check akhir pukul 15:40 WIB._`,
    );

    logger.info(MODULE, `[12:05] Midday done. Hold: ${holdList.length}, SL: ${slHitList.length}, TP: ${tpHitList.length}, Warn: ${technicalExitList.length}`);
  } catch (error: any) {
    logger.error(MODULE, `Midday check failed: ${error.message}`);
    await sendMessage(`⚠️ *[12:05] Midday Check Gagal*\n\nError: ${error.message}\n\n_Sistem tetap berjalan._`);
  }
}

/** Simple rupiah formatter for inline use */
function formatRupiahSimple(amount: number): string {
  return `Rp ${amount.toLocaleString("id-ID")}`;
}

// ==========================================
// 3️⃣ 15:40 WIB — EXIT / MOMENTUM CHECK
// ==========================================
async function runExitCheck(): Promise<void> {
  logger.info(MODULE, "🛑 [15:40] Running end-of-day exit check...");

  const activePositions = getActivePositions();
  const state = getTodayState();

  if (activePositions.length === 0) {
    logger.info(MODULE, "[15:40] Tidak ada posisi aktif.");
    await sendMessage(
      `🛑 *[15:40] Exit Check Selesai*\n\n` +
        `📋 Tidak ada posisi aktif yang perlu dipantau.\n` +
        `📊 Sinyal terkirim hari ini: ${state.buySignalsSent}/${config.signal.maxPerDay}\n` +
        (state.closedPositions.length > 0 ? `🚫 Ditutup hari ini: ${state.closedPositions.length} posisi\n` : "") +
        `\n_Sampai besok! 👋_`,
    );
    return;
  }

  try {
    const tickers = activePositions.map((p) => p.ticker);
    const dataList = await fetchAllTickers(tickers, "1h", "1mo");

    const holdList: string[] = [];
    const slHitList: { ticker: string; entry: number; sl: number; current: number }[] = [];
    const tpHitList: { ticker: string; entry: number; tp: number; current: number }[] = [];
    const exitList: { ticker: string; reason: string; current: number }[] = [];

    for (const pos of activePositions) {
      const tickerData = dataList.find((d) => d.ticker === pos.ticker);
      if (!tickerData || tickerData.candles.length === 0) {
        holdList.push(pos.ticker);
        continue;
      }

      const currentPrice = tickerData.candles[tickerData.candles.length - 1].close;

      // Check SL hit
      if (currentPrice <= pos.stopLoss) {
        slHitList.push({ ticker: pos.ticker, entry: pos.entry, sl: pos.stopLoss, current: currentPrice });
        closePosition(pos.ticker, "hit_sl");
        continue;
      }

      // Check TP hit
      if (currentPrice >= pos.takeProfit) {
        tpHitList.push({ ticker: pos.ticker, entry: pos.entry, tp: pos.takeProfit, current: currentPrice });
        closePosition(pos.ticker, "hit_tp");
        continue;
      }

      // Technical exit check
      const fourHourCandles = tickerData.candles.filter((_, i) => i % 4 === 3 || i === tickerData.candles.length - 1);
      const analysis = analyze4H(fourHourCandles);
      if (analysis) {
        const { checkSellCondition } = await import("../services/indicatorService.js");
        const sell = checkSellCondition(analysis);
        if (sell.shouldSell) {
          exitList.push({ ticker: pos.ticker, reason: sell.reason, current: currentPrice });
          closePosition(pos.ticker, "exited");
          continue;
        }
      }

      // Still holding
      const pnlPct = (((currentPrice - pos.entry) / pos.entry) * 100).toFixed(2);
      holdList.push(`${pos.ticker} (${Number(pnlPct) >= 0 ? "+" : ""}${pnlPct}%)`);
    }

    // Send SL hit notifications
    for (const sl of slHitList) {
      const lossPct = (((sl.current - sl.entry) / sl.entry) * 100).toFixed(2);
      await sendMessage(
        `🛑 *STOP LOSS HIT*\n\n` +
          `🏷 *Stock:* \`${sl.ticker.replace(".JK", "")}\`\n` +
          `💰 Entry: ${formatRupiahSimple(sl.entry)}\n` +
          `🛑 SL: ${formatRupiahSimple(sl.sl)}\n` +
          `📉 Harga Sekarang: ${formatRupiahSimple(sl.current)} (${lossPct}%)\n\n` +
          `_Posisi ditutup otomatis._`,
      );
      await new Promise((res) => setTimeout(res, 1000));
    }

    // Send TP hit notifications
    for (const tp of tpHitList) {
      const profitPct = (((tp.current - tp.entry) / tp.entry) * 100).toFixed(2);
      await sendMessage(
        `🎯 *TAKE PROFIT HIT*\n\n` +
          `🏷 *Stock:* \`${tp.ticker.replace(".JK", "")}\`\n` +
          `💰 Entry: ${formatRupiahSimple(tp.entry)}\n` +
          `🎯 TP: ${formatRupiahSimple(tp.tp)}\n` +
          `📈 Harga Sekarang: ${formatRupiahSimple(tp.current)} (+${profitPct}%)\n\n` +
          `🎉 _Target tercapai! Posisi ditutup._`,
      );
      await new Promise((res) => setTimeout(res, 1000));
    }

    // Send technical exit notifications
    for (const ex of exitList) {
      await sendExitSignal(ex.ticker, ex.reason, ex.current);
      await new Promise((res) => setTimeout(res, 1000));
    }

    // End of day summary
    const holdText = holdList.length > 0 ? holdList.map((t) => `✅ ${typeof t === "string" && t.includes("(") ? t.replace(".JK", "") : String(t).replace(".JK", "")}`).join("\n") : "_Semua posisi sudah ditutup_";

    const closedToday = state.closedPositions.length + slHitList.length + tpHitList.length + exitList.length;

    await sendMessage(
      `📊 *[15:40] End of Day Summary*\n\n` + `💎 *Masih HOLD:*\n${holdText}\n\n` + `📈 Posisi ditutup hari ini: ${closedToday}\n` + `📋 Sinyal terkirim: ${state.buySignalsSent}/${config.signal.maxPerDay}\n\n` + `_Good work today! 👋_`,
    );
  } catch (error: any) {
    logger.error(MODULE, `Exit check failed: ${error.message}`);
    await sendMessage(`⚠️ *[15:40] Exit Check Gagal*\n\nError: ${error.message}\n\n_Sistem tetap berjalan._`);
  }
}

// ==========================================
// 4️⃣ 06:15 WIB — RESET DAILY STATE
// ==========================================
async function runDailyReset(): Promise<void> {
  logger.info(MODULE, "🔄 [06:15] Running daily state reset...");

  // Get active positions BEFORE reset for notification
  const carriedPositions = getActivePositions();

  resetDailyState();

  // Notify about carried-over positions
  if (carriedPositions.length > 0) {
    const lines = carriedPositions.map((p) => {
      const daysSince = p.daysSinceEntry ?? 0;
      return `📌 ${p.ticker.replace(".JK", "")} — Entry: ${formatRupiahSimple(p.entry)} | SL: ${formatRupiahSimple(p.stopLoss)} | TP: ${formatRupiahSimple(p.takeProfit)} (Hari ke-${daysSince + 1})`;
    });
    await sendMessage(
      `🔄 *[06:15] Daily Reset*\n\n` + `📊 Counter harian direset.\n` + `📌 *${carriedPositions.length} posisi aktif dibawa ke hari berikutnya:*\n\n` + lines.join("\n") + `\n\n_Posisi tetap dipantau sampai SL/TP tercapai atau exit manual._`,
    );
  } else {
    await sendMessage(`🔄 *[06:15] Daily Reset*\n\nCounter harian direset. Tidak ada posisi aktif.\n\n_Scan dimulai 06:30 WIB. 👋_`);
  }
}

/**
 * Start all scheduled cron jobs explicitly in Asia/Jakarta timezone.
 */
export function startScheduler(): void {
  logger.info(MODULE, `📅 Starting advanced scheduler (Timezone: ${TIMEZONE})...`);

  // 1️⃣ 06:30 WIB (Mon-Fri) — Full Scan pagi sebelum market buka
  job1630 = cron.schedule("30 6 * * 1-5", runMorningScan, { timezone: TIMEZONE });
  logger.info(MODULE, `   [06:30] Full Scan scheduled.`);

  // 2️⃣ 12:05 WIB (Mon-Fri) — Hold/Exit check sinyal pagi
  job1205 = cron.schedule("5 12 * * 1-5", runMiddayCheck, { timezone: TIMEZONE });
  logger.info(MODULE, `   [12:05] Midday Hold/Exit Check scheduled.`);

  // 3️⃣ 15:40 WIB (Mon-Fri)
  job1540 = cron.schedule("40 15 * * 1-5", runExitCheck, { timezone: TIMEZONE });
  logger.info(MODULE, `   [15:40] Exit Check scheduled.`);

  // 4️⃣ 06:15 WIB (Mon-Fri) — Reset sebelum scan pagi
  job1615 = cron.schedule("15 6 * * 1-5", runDailyReset, { timezone: TIMEZONE });
  logger.info(MODULE, `   [06:15] Daily Reset scheduled.`);

  logger.info(MODULE, "✅ All cron jobs active.");
}

/**
 * Stop all cron jobs.
 */
export function stopScheduler(): void {
  job1630?.stop();
  job1205?.stop();
  job1540?.stop();
  job1615?.stop();
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
