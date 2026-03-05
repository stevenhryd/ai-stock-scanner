const fs = require("fs");
let code = fs.readFileSync("src/telegram/telegramService.ts", "utf-8");

const replacement = `  const aiText = signal.aiSentiment 
    ? \`\\n\\n🤖 *AI News Sentiment:*\\n├ Score: \${signal.aiSentiment.score > 0 ? "+" : ""}\${signal.aiSentiment.score}/10\\n└ Insight: _\${signal.aiSentiment.summary}_\` 
    : \`\`;

  return \`📈 *SWING BUY SIGNAL*

🏷 *Stock:* \\\`\${signal.ticker.replace(".JK", "")}\\\` (\${signal.ticker})
⭐ *Final Score:* \${signal.score}/100
💰 *Entry:* \${formatRupiah(signal.entry)}
🛑 *Stop Loss:* \${formatRupiah(signal.stopLoss)} (-\${slPct}%)
🎯 *Take Profit:* \${formatRupiah(signal.takeProfit)} (+\${tpPct}%)
📊 *Timeframe:* 4H
📈 *Trend 1D:* ✅ Bullish

🔬 *Konfirmasi Teknikal:*
├ Breakout: +\${boVal}% ✅
├ RSI 4H: \${rsiVal} ✅
├ MACD: Bullish ✅
└ ADX: \${adxVal} (Trend Strength) ✅\${aiText}

📦 *Position Sizing:*
├ Modal: \${formatRupiah(config.capital.amount)}
├ Risk: \${formatRupiah(signal.riskAmount)} (\${(config.capital.riskPerTrade * 100).toFixed(0)}%)
├ Lot Size: \${signal.lotSize} lot (\${signal.shares} lembar)
└ Position: \${formatRupiah(signal.positionSize)}

⏰ *Time:* \${timestamp} WIB

⚠️ _Disclaimer: Sinyal ini bukan saran investasi. Lakukan analisa mandiri._\`;
}`;

// Use regex to replace everything inside the function from 'return `📈 *SWING BUY SIGNAL*' down to '};'
code = code.replace(/return `📈 \*SWING BUY SIGNAL\*[\s\S]*?mandiri\._`;\r?\n\}/, replacement);
fs.writeFileSync("src/telegram/telegramService.ts", code);
console.log("Patched telegramService.ts");
