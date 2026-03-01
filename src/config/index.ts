import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export interface AppConfig {
  telegram: {
    botToken: string;
    chatId: string;
  };
  capital: {
    amount: number;
    riskPerTrade: number;
    stopLossPct: number;
  };
  signal: {
    maxPerDay: number;
  };
  batch: {
    size: number;
    concurrencyLimit: number;
  };
  cron: {
    dailyScan: string;
    hourlyScan: string;
    dailyReset: string;
  };
}

function getEnvOrDefault(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

function getEnvRequired(key: string): string {
  const value = process.env[key];
  if (!value) {
    console.warn(`⚠️  Environment variable ${key} is not set. Using placeholder.`);
    return '';
  }
  return value;
}

const config: AppConfig = {
  telegram: {
    botToken: getEnvRequired('TELEGRAM_BOT_TOKEN'),
    chatId: getEnvRequired('TELEGRAM_CHAT_ID'),
  },
  capital: {
    amount: parseFloat(getEnvOrDefault('CAPITAL_AMOUNT', '3000000')),
    riskPerTrade: parseFloat(getEnvOrDefault('RISK_PER_TRADE', '0.02')),
    stopLossPct: parseFloat(getEnvOrDefault('STOP_LOSS_PCT', '0.03')),
  },
  signal: {
    maxPerDay: parseInt(getEnvOrDefault('MAX_SIGNALS_PER_DAY', '5'), 10),
  },
  batch: {
    size: parseInt(getEnvOrDefault('BATCH_SIZE', '50'), 10),
    concurrencyLimit: parseInt(getEnvOrDefault('CONCURRENCY_LIMIT', '5'), 10),
  },
  cron: {
    // 08:45 WIB = 01:45 UTC (WIB is UTC+7)
    dailyScan: '45 1 * * 1-5',
    // Every hour on weekdays
    hourlyScan: '0 * * * 1-5',
    // 00:00 WIB = 17:00 UTC previous day
    dailyReset: '0 17 * * *',
  },
};

export default config;
