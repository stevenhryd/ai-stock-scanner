/**
 * Daily State Service
 *
 * Manages the daily state (signal counter and watchlist) in a persistent JSON file.
 * This ensures that if the server restarts, limits and tracking are not reset.
 */

import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';

const MODULE = 'DailyStateService';
const STATE_FILE_PATH = path.resolve(process.cwd(), 'dailyState.json');

export interface DailyState {
  date: string;          // Format: YYYY-MM-DD
  buySignalsSent: number;
  watchlist: string[];
}

/**
 * Get current date string in Asia/Jakarta timezone.
 */
function getTodayDateString(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
}

/**
 * Get the default empty state for today.
 */
function getDefaultState(): DailyState {
  return {
    date: getTodayDateString(),
    buySignalsSent: 0,
    watchlist: [],
  };
}

/**
 * Save state to JSON file.
 */
function saveState(state: DailyState): void {
  try {
    fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(state, null, 2), 'utf-8');
  } catch (error: any) {
    logger.error(MODULE, `Failed to save daily state: ${error.message}`);
  }
}

/**
 * Get today's state. If the date has changed, it auto-resets the state.
 */
export function getTodayState(): DailyState {
  try {
    if (fs.existsSync(STATE_FILE_PATH)) {
      const raw = fs.readFileSync(STATE_FILE_PATH, 'utf-8');
      const state: DailyState = JSON.parse(raw);
      
      const today = getTodayDateString();
      if (state.date !== today) {
        logger.info(MODULE, `Date changed from ${state.date} to ${today}. Auto-resetting state.`);
        const newState = getDefaultState();
        saveState(newState);
        return newState;
      }
      
      return state;
    }
  } catch (error: any) {
    logger.error(MODULE, `Error reading daily state: ${error.message}. Returning default.`);
  }

  // If file doesn't exist or corrupted, create new
  const defaultState = getDefaultState();
  saveState(defaultState);
  return defaultState;
}

/**
 * Increment the daily buy signal counter.
 */
export function incrementBuyCounter(): void {
  const state = getTodayState();
  state.buySignalsSent += 1;
  saveState(state);
  logger.debug(MODULE, `Buy counter incremented to: ${state.buySignalsSent}`);
}

/**
 * Add a ticker to the daily watchlist.
 * Only adds if not already present.
 */
export function addWatchlistStock(ticker: string): void {
  const state = getTodayState();
  if (!state.watchlist.includes(ticker)) {
    state.watchlist.push(ticker);
    saveState(state);
    logger.debug(MODULE, `Added ${ticker} to watchlist.`);
  }
}

/**
 * Get the current watchlist array.
 */
export function getWatchlist(): string[] {
  return getTodayState().watchlist;
}

/**
 * Remove a stock from the watchlist (useful if an exit signal is hit).
 */
export function removeWatchlistStock(ticker: string): void {
  const state = getTodayState();
  state.watchlist = state.watchlist.filter((t) => t !== ticker);
  saveState(state);
  logger.debug(MODULE, `Removed ${ticker} from watchlist.`);
}

/**
 * Manually reset the daily counter. Called by cron at 00:00 WIB.
 */
export function resetDailyState(): void {
  const newState = getDefaultState();
  saveState(newState);
  logger.info(MODULE, '[00:00] Daily state reset successfully.');
}

export default {
  getTodayState,
  incrementBuyCounter,
  addWatchlistStock,
  getWatchlist,
  removeWatchlistStock,
  resetDailyState,
};
