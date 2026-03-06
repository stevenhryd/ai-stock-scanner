/**
 * Test Scan Script
 *
 * Jalankan full scan lokal dan tampilkan hasil detail
 * Run: npm run build && npx ts-node test-scan.ts
 */

import dotenv from "dotenv";
import path from "path";
import { generateSignals, getTickerList } from "./src/services/signalService.js";
import { getFetchSummary } from "./src/services/dataService.js";
import logger from "./src/utils/logger.js";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const MODULE = "TestScan";

async function runTestScan(): Promise<void> {
  console.log("\n");
  console.log("╔════════════════════════════════════════════════╗");
  console.log("║   TEST SCAN - TradingView + Yahoo Finance     ║");
  console.log("╚════════════════════════════════════════════════╝");
  console.log("\n");

  const startTime = Date.now();

  try {
    const tickers = getTickerList();
    logger.info(MODULE, `📊 Ticker list: ${tickers.length} tickers`);
    logger.info(MODULE, `🏦 Exchange: IDX`);
    logger.info(MODULE, `📊 Data: TradingView (1D + 4H)`);
    logger.info(MODULE, `📰 News: Yahoo Finance`);
    logger.info(MODULE, "");
    logger.info(MODULE, "🚀 Starting full scan...");
    logger.info(MODULE, "");

    const signals = await generateSignals();
    const summary = getFetchSummary();

    const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
    const durationMin = (Number(durationSec) / 60).toFixed(1);

    console.log("\n╔═ SCAN RESULTS ═════════════════════════════════╗\n");

    console.log(`⏱️  Duration: ${durationMin} minutes (${durationSec}s)\n`);

    console.log(`📊 Fetch Summary:`);
    console.log(`   ✅ Success: ${summary.success} ticker`);
    console.log(`   ❌ Failed:  ${summary.failed} ticker`);
    if (summary.rateLimited.length > 0) {
      console.log(`   ⏳ Rate Limited: ${summary.rateLimited.length}`);
    }
    if (summary.notFound.length > 0) {
      console.log(`   ❓ Not Found: ${summary.notFound.length}`);
    }
    console.log("");

    console.log(`🎯 Buy Signals Generated: ${signals.length}`);
    if (signals.length > 0) {
      console.log("");
      signals.forEach((sig, idx) => {
        const ticker = sig.ticker.replace(".JK", "");
        console.log(`   ${idx + 1}. ${ticker}`);
        console.log(`      Score: ${sig.score}/100`);
        console.log(`      Entry: Rp ${sig.entry.toLocaleString("id-ID")}`);
        console.log(`      SL: Rp ${sig.stopLoss.toLocaleString("id-ID")} | TP: Rp ${sig.takeProfit.toLocaleString("id-ID")}`);
        console.log(`      Position: ${sig.shares} shares (Rp ${sig.positionSize.toLocaleString("id-ID")})`);
        console.log(`      RSI: ${sig.fourHourAnalysis.rsi.toFixed(1)} | ADX: ${sig.fourHourAnalysis.adx.toFixed(1)} | TV Rec: ${sig.fourHourAnalysis.recommendAll.toFixed(2)}`);
        if (sig.newsSentiment && sig.newsSentiment.newsCount > 0) {
          console.log(`      News Sentiment: ${sig.newsSentiment.score > 0 ? "+" : ""}${sig.newsSentiment.score}/10 — ${sig.newsSentiment.summary}`);
        }
        console.log("");
      });
    } else {
      console.log("   ❌ Tidak ada saham yang memenuhi kriteria BUY hari ini\n");
    }

    console.log("╚═══════════════════════════════════════════════╝\n");

    process.exit(0);
  } catch (error: any) {
    logger.error(MODULE, `Scan failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  }
}

runTestScan();
