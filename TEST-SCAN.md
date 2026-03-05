# 🧪 Test Scan Commands

## Quick Start

### 1. Test Scan dengan ts-node (fastest, recommended)

```bash
npm run test-scan
```

- Build TypeScript
- Jalankan scan langsung dengan ts-node
- Tampilkan hasil di console

**Output:**

```
╔════════════════════════════════════════════════╗
║   TEST SCAN - LOCAL DEVELOPMENT               ║
╚════════════════════════════════════════════════╝

📊 Ticker list loaded: 750 tickers
🎯 Scan universe: idx
📈 Top tickers limit: 300
✅ Pre-screen enabled: true

🚀 Starting full scan...

⏱️  Duration: 45.3 minutes

📊 Fetch Summary:
   ✅ Success: 298 ticker
   ❌ Failed:  2 ticker
   ⏳ Rate Limited: 1

🎯 Buy Signals Generated: 3

   1. BBRI
      Score: 87/100
      Entry: Rp 4,250
      SL: Rp 4,100 | TP: Rp 5,000
      ...
```

### 2. Test Scan dengan built dist (slower, untuk production preview)

```bash
npm run test-scan-build
```

- Build TypeScript ke dist/
- Jalankan compiled JavaScript
- Lebih lambat but production-like

### 3. Manual Scan (via main entry point)

```bash
npm run scan
```

- Jalankan dev mode dengan `--scan` flag
- Sama dengan `npm run dev -- --scan`
- Include Telegram bot initialization & logging

### 4. Full Dev Mode (dengan scheduler)

```bash
npm run dev
```

- Jalankan dengan cron scheduler
- Scan otomatis at 16:30 WIB, 12:05 WIB, etc.
- Jalankan full bot

---

## Environment Setup

Pastikan `.env` ada di root dengan minimal:

```env
# Required (dummy values ok untuk test lokal)
TELEGRAM_BOT_TOKEN=dummy
TELEGRAM_CHAT_ID=1

# Optional
GEMINI_API_KEY=your_key

# Scan settings
SCAN_UNIVERSE=idx
TOP_TICKERS_LIMIT=300
ENABLE_VOLUME_PRESCREEN=true

# Rate limiting (tuned default)
YAHOO_MAX_RETRIES=2
```

---

## Troubleshooting

### Jika `npm run test-scan` error "Module not found"

```bash
npm install
npm run build
npm run test-scan
```

### Jika rate limited banyak

```env
# Naikkan delay antar request
INTER_REQUEST_DELAY_MIN_MS=5000
INTER_REQUEST_DELAY_MAX_MS=10000
BATCH_DELAY_MIN_MS=20000
BATCH_DELAY_MAX_MS=30000
```

### Jika ingin scan dengan ticker list lebih kecil (lebih cepat)

```env
TOP_TICKERS_LIMIT=100    # Default: 300
QUOTE_BATCH_SIZE=30      # Default: 50
```

### Jika ingin skip pre-screening (test raw chart fetch)

```env
ENABLE_VOLUME_PRESCREEN=false
MAX_TICKERS_TO_SCAN=50   # Batasi manual
```

---

## What to Expect

### Duration

- **Pre-screening**: 2-3 minutes (500+ tickers → 300)
- **Daily chart scan**: 30-45 minutes (300 tickers × 1D)
- **4H scan** (if bullish found): 15-30 minutes
- **Total**: 45-75 minutes

### Rate Limiting

- Yahoo rate limits ~60-80 requests per minute
- Old system (100 tickers): 30-40% failed
- New system (300 top tickers): **0-5% failed** expected

### Output

- **CSV/JSON logs**: Check `dailyState.json`
- **Console output**: Real-time with emojis 📊
- **Telegram**: If TELEGRAM credentials set (disabled in dry run)

---

## Performance Tips

1. **First run** lebih lambat (pre-screening perlu fetch 700+ quotes)
2. **Repeat runs** untuk same day: caching di memory
3. **Avoid peak hours**: 09:00-15:00 WIB (market hours) → Yahoo rate limit
4. **Best time**: 16:30+ WIB (after market close)
