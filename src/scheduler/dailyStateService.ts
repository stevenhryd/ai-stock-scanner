/**
 * Daily State Service
 *
 * Manages the daily state (signal counter and watchlist) in a persistent JSON file.
 * This ensures that if the server restarts, limits and tracking are not reset.
 *
 * The watchlist now stores full position data (entry, SL, TP) per stock,
 * allowing automatic SL/TP detection and removal.
 */

import fs from "fs";
import path from "path";
import logger from "../utils/logger.js";

const MODULE = "DailyStateService";
const STATE_FILE_PATH = path.resolve(process.cwd(), "dailyState.json");
const POSITIONS_FILE_PATH = path.resolve(process.cwd(), "positions.json");

/** Position data stored per watched stock */
export interface WatchlistPosition {
  ticker: string;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  score: number;
  addedAt: string; // ISO timestamp
  status: "active" | "hit_sl" | "hit_tp" | "exited";
  closedAt?: string; // ISO timestamp when closed
  closeReason?: string;
  daysSinceEntry?: number; // auto-calculated
}

export interface DailyState {
  date: string; // Format: YYYY-MM-DD
  buySignalsSent: number;
  watchlist: string[]; // kept for backward compat (ticker list)
  positions: WatchlistPosition[]; // kept for backward compat — use positionsFile instead
  closedPositions: WatchlistPosition[]; // positions closed TODAY only
}

/** Persistent positions file — survives daily resets */
export interface PositionsFile {
  activePositions: WatchlistPosition[];
  closedHistory: WatchlistPosition[]; // full history of all closed positions
}

/**
 * Get current date string in Asia/Jakarta timezone.
 */
function getTodayDateString(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jakarta" });
}

/**
 * Get the default empty state for today.
 */
function getDefaultState(): DailyState {
  return {
    date: getTodayDateString(),
    buySignalsSent: 0,
    watchlist: [],
    positions: [],
    closedPositions: [],
  };
}

/**
 * Save state to JSON file.
 */
function saveState(state: DailyState): void {
  try {
    fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(state, null, 2), "utf-8");
  } catch (error: any) {
    logger.error(MODULE, `Failed to save daily state: ${error.message}`);
  }
}

/**
 * Load persistent positions file.
 */
function loadPositionsFile(): PositionsFile {
  try {
    if (fs.existsSync(POSITIONS_FILE_PATH)) {
      const raw = fs.readFileSync(POSITIONS_FILE_PATH, "utf-8");
      const data = JSON.parse(raw) as PositionsFile;
      if (!data.activePositions) data.activePositions = [];
      if (!data.closedHistory) data.closedHistory = [];
      // Calculate daysSinceEntry for each active position
      const now = new Date();
      for (const pos of data.activePositions) {
        const addedDate = new Date(pos.addedAt);
        pos.daysSinceEntry = Math.floor((now.getTime() - addedDate.getTime()) / (1000 * 60 * 60 * 24));
      }
      return data;
    }
  } catch (error: any) {
    logger.error(MODULE, `Error reading positions file: ${error.message}`);
  }
  return { activePositions: [], closedHistory: [] };
}

/**
 * Save persistent positions file.
 */
function savePositionsFile(data: PositionsFile): void {
  try {
    fs.writeFileSync(POSITIONS_FILE_PATH, JSON.stringify(data, null, 2), "utf-8");
  } catch (error: any) {
    logger.error(MODULE, `Failed to save positions file: ${error.message}`);
  }
}

/**
 * Get today's state. If the date has changed, it auto-resets the state.
 */
export function getTodayState(): DailyState {
  try {
    if (fs.existsSync(STATE_FILE_PATH)) {
      const raw = fs.readFileSync(STATE_FILE_PATH, "utf-8");
      const state = JSON.parse(raw) as DailyState;

      const today = getTodayDateString();
      if (state.date !== today) {
        logger.info(MODULE, `Date changed from ${state.date} to ${today}. Auto-resetting daily counters (positions preserved).`);
        // Rebuild watchlist from persistent active positions
        const posFile = loadPositionsFile();
        const activeTickerList = posFile.activePositions.filter((p) => p.status === "active").map((p) => p.ticker);
        const newState: DailyState = {
          date: today,
          buySignalsSent: 0,
          watchlist: activeTickerList,
          positions: [],
          closedPositions: [],
        };
        saveState(newState);
        return newState;
      }

      // Migrate old format: ensure positions & closedPositions exist
      if (!state.positions) state.positions = [];
      if (!state.closedPositions) state.closedPositions = [];

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
 * Add a full position to the persistent positions file (with entry, SL, TP).
 */
export function addWatchlistPosition(ticker: string, entry: number, stopLoss: number, takeProfit: number, score: number): void {
  const posFile = loadPositionsFile();
  // Don't add if already closed
  if (posFile.closedHistory.some((p) => p.ticker === ticker && isToday(p.closedAt))) {
    logger.debug(MODULE, `${ticker} already closed recently. Not re-adding.`);
    return;
  }
  // Don't add if already active
  if (posFile.activePositions.some((p) => p.ticker === ticker)) {
    logger.debug(MODULE, `${ticker} already in active positions.`);
    return;
  }
  const position: WatchlistPosition = {
    ticker,
    entry,
    stopLoss,
    takeProfit,
    score,
    addedAt: new Date().toISOString(),
    status: "active",
    daysSinceEntry: 0,
  };
  posFile.activePositions.push(position);
  savePositionsFile(posFile);

  // Also keep the daily state watchlist in sync
  const state = getTodayState();
  if (!state.watchlist.includes(ticker)) {
    state.watchlist.push(ticker);
    saveState(state);
  }
  logger.info(MODULE, `Added position: ${ticker} (Entry: ${entry}, SL: ${stopLoss}, TP: ${takeProfit})`);
}

/** Check if a date string is today */
function isToday(dateStr?: string): boolean {
  if (!dateStr) return false;
  const today = getTodayDateString();
  return dateStr.startsWith(today);
}

/**
 * Get all active positions from persistent file (survives daily resets).
 */
export function getActivePositions(): WatchlistPosition[] {
  const posFile = loadPositionsFile();
  return posFile.activePositions.filter((p) => p.status === "active");
}

/**
 * Close a position (SL hit, TP hit, or manual exit).
 * Moves it to closedHistory so it won't be checked again.
 */
export function closePosition(ticker: string, reason: "hit_sl" | "hit_tp" | "exited"): void {
  const posFile = loadPositionsFile();
  const posIndex = posFile.activePositions.findIndex((p) => p.ticker === ticker && p.status === "active");
  if (posIndex >= 0) {
    posFile.activePositions[posIndex].status = reason;
    posFile.activePositions[posIndex].closedAt = new Date().toISOString();
    posFile.activePositions[posIndex].closeReason = reason;
    posFile.closedHistory.push(posFile.activePositions[posIndex]);
    posFile.activePositions.splice(posIndex, 1);
  }
  savePositionsFile(posFile);

  // Also remove from daily watchlist
  const state = getTodayState();
  state.watchlist = state.watchlist.filter((t) => t !== ticker);
  if (!state.closedPositions.some((p) => p.ticker === ticker)) {
    const closed = posFile.closedHistory.find((p) => p.ticker === ticker);
    if (closed) state.closedPositions.push(closed);
  }
  saveState(state);
  logger.info(MODULE, `Closed position: ${ticker} (Reason: ${reason})`);
}

/**
 * Check if a ticker has already been closed (no more alerts).
 */
export function isPositionClosed(ticker: string): boolean {
  const posFile = loadPositionsFile();
  return posFile.closedHistory.some((p) => p.ticker === ticker);
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
 * Reset daily counters at 00:00 WIB.
 * IMPORTANT: Active positions are NOT reset — they persist in positions.json
 * until SL/TP is hit or manually exited.
 */
export function resetDailyState(): void {
  // Rebuild watchlist from active positions (carry over)
  const posFile = loadPositionsFile();
  const activeTickerList = posFile.activePositions.filter((p) => p.status === "active").map((p) => p.ticker);

  const newState: DailyState = {
    date: getTodayDateString(),
    buySignalsSent: 0,
    watchlist: activeTickerList, // carry over active tickers
    positions: [], // legacy field
    closedPositions: [], // reset — only tracks today's closings
  };
  saveState(newState);

  if (activeTickerList.length > 0) {
    logger.info(MODULE, `[00:00] Daily reset. Carried over ${activeTickerList.length} active position(s): ${activeTickerList.map((t) => t.replace(".JK", "")).join(", ")}`);
  } else {
    logger.info(MODULE, "[00:00] Daily state reset. No active positions to carry over.");
  }
}

export default {
  getTodayState,
  incrementBuyCounter,
  addWatchlistStock,
  addWatchlistPosition,
  getActivePositions,
  closePosition,
  isPositionClosed,
  getWatchlist,
  removeWatchlistStock,
  resetDailyState,
};
