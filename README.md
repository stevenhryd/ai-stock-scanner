# AI Stock Signal Scanner Indonesia 🇮🇩

Sistem scanner saham otomatis yang menganalisa seluruh saham yang terdaftar di Bursa Efek Indonesia (BEI) menggunakan analisa teknikal, lalu mengirimkan maksimal 5 sinyal BUY terbaik per hari ke Telegram.

## Fitur Utama

- 📊 **Dual Timeframe Analysis** — Filter trend 1D + entry trigger 4H
- 🏆 **Scoring System** — Ranking 0–100 berdasarkan 5 faktor
- 📈 **Breakout Detection** — Deteksi breakout high 5 candle + volume spike
- 💰 **Risk Management** — Auto kalkulasi lot size, SL, dan TP
- 📲 **Telegram Notification** — Kirim sinyal otomatis via bot Telegram
- ⏰ **Scheduled Scanning** — Scan otomatis setiap hari kerja
- 🚀 **Batch Processing** — Efisien scan 800+ saham dengan concurrency limit

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Setup Environment

```bash
cp .env.example .env
```

Edit `.env` dan isi konfigurasi:

```env
TELEGRAM_BOT_TOKEN=your_token
TELEGRAM_CHAT_ID=your_chat_id
CAPITAL_AMOUNT=3000000
RISK_PER_TRADE=0.02
STOP_LOSS_PCT=0.03
MAX_SIGNALS_PER_DAY=5
```

### 3. Build & Run

```bash
# Development mode (dengan ts-node)
npm run dev

# Production build
npm run build
npm run start

# Manual scan sekali jalan
npm run start -- --scan
```

## Setup Telegram Bot

1. Buka Telegram, cari **@BotFather**
2. Kirim `/newbot` dan ikuti instruksi
3. Salin **Bot Token** yang diberikan
4. Untuk mendapatkan **Chat ID**:
   - Tambahkan bot ke group atau kirim pesan ke bot
   - Buka `https://api.telegram.org/bot<TOKEN>/getUpdates`
   - Cari `"chat":{"id":` untuk mendapatkan chat ID
5. Paste token dan chat ID ke file `.env`

## Cara Kerja

### Strategy Logic

```
1D Trend Filter          4H Entry Trigger
─────────────────        ─────────────────
Close > SMA20     →      Break high 5 candle
SMA20 > SMA50     →      Volume > 1.5x avg
RSI > 50          →      RSI 55–70
```

### Scoring System

| Faktor             | Bobot |
|--------------------|-------|
| Breakout Strength  | 30%   |
| Volume Spike       | 20%   |
| RSI Strength       | 15%   |
| 1D Trend Alignment | 20%   |
| Volatility Quality | 15%   |

### Schedule (Asia/Jakarta)

| Job | Waktu | Keterangan |
|---|---|---|
| **08:45 WIB** | Full Scan | Pagi hari cek full trend 1D + trigger 4H. Top 5 dikirim & masuk Watchlist. |
| **12:05 WIB** | 4H Re-Check | Siang hari re-check trigger 4H untuk saham potensial di luar Watchlist. |
| **15:40 WIB** | Exit Check | Sore hari evaluasi Watchlist. Jika jebol support/RSI drop, kirim **EXIT WARNING**. |
| **00:00 WIB** | Reset State | Reset counter batas sinyal & bersihkan Watchlist harian. |

*Sinyal BUY dibatasi maksimal 5 per hari (terkontrol via `dailyState.json`), namun sinyal EXIT tidak dibatasi.*

## Deploy ke Railway

1. Push code ke GitHub repository
2. Buka [railway.app](https://railway.app) dan buat project baru
3. Connect repository GitHub
4. Set environment variables di Railway dashboard:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
   - `CAPITAL_AMOUNT`
   - Dll (lihat `.env.example`)
5. Railway akan auto-detect `Procfile` dan deploy

## Struktur Project

```
src/
├── config/
│   ├── index.ts          # Konfigurasi dari .env
│   └── tickers.json      # Daftar ticker saham BEI
├── services/
│   ├── dataService.ts     # Fetch data Yahoo Finance
│   ├── indicatorService.ts # Kalkulasi SMA, EMA, RSI
│   ├── signalService.ts   # Orchestrasi pipeline sinyal
│   └── scoringService.ts  # Scoring & ranking
├── telegram/
│   └── telegramService.ts # Kirim & format pesan Telegram
├── scheduler/
│   ├── cronJobs.ts          # Core cron job scheduling (08:45, 12:05, dsb)
│   └── dailyStateService.ts # Persistent storage untuk limit & watchlist
├── utils/
│   ├── logger.ts          # Console logger
│   └── riskManagement.ts  # Position sizing & risk calc
└── index.ts               # Entry point
```

## Risk Management

Kalkulasi otomatis berdasarkan:
- **Modal**: Rp 3.000.000 (default, bisa diubah)
- **Risk per trade**: 2%
- **Stop Loss**: 3%
- **Risk-Reward**: 1:2

## Menambahkan Ticker Baru

Edit file `src/config/tickers.json` dan tambahkan ticker dengan format `KODE.JK`:

```json
["BBRI.JK", "BBCA.JK", "TICKER_BARU.JK"]
```

## License

MIT
