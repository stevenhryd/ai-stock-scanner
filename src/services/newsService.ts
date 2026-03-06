/**
 * News Service
 *
 * Fetches news from Yahoo Finance search API (direct HTTP via axios).
 * Performs simple keyword-based sentiment analysis without external AI APIs.
 */

import axios from "axios";
import logger from "../utils/logger.js";

const MODULE = "NewsService";

const YAHOO_SEARCH_URL = "https://query2.finance.yahoo.com/v1/finance/search";
const YAHOO_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

// ─── Sentiment Keywords ────────────────────────────────────────────────────

const POSITIVE_KEYWORDS = [
  // English - specific financial terms
  "profit",
  "dividend",
  "record revenue",
  "partnership",
  "upgrade",
  "outperform",
  "bullish",
  "acquisition",
  "beat estimate",
  "exceeds expectation",
  "surge",
  "rally",
  "upside",
  "strong earnings",
  "record high",
  // Indonesian - specific
  "laba bersih",
  "naik signifikan",
  "dividen",
  "ekspansi",
  "akuisisi",
  "rekor",
  "melonjak",
  "menguat",
  "prospek cerah",
  "pendapatan naik",
  "untung besar",
];

const NEGATIVE_KEYWORDS = [
  // English - specific financial terms
  "net loss",
  "lawsuit",
  "debt default",
  "bankruptcy",
  "fraud",
  "downgrade",
  "underperform",
  "bearish",
  "default",
  "miss estimate",
  "profit warning",
  "crash",
  "plunge",
  "suspend",
  // Indonesian - specific
  "rugi bersih",
  "utang macet",
  "gagal bayar",
  "pailit",
  "penipuan",
  "anjlok",
  "suspensi",
  "defisit",
  "merosot tajam",
];

// ─── Types ─────────────────────────────────────────────────────────────────

export interface NewsSentiment {
  /** Sentiment score: -10 (very negative) to +10 (very positive), 0 = neutral */
  score: number;
  /** Short summary of sentiment analysis */
  summary: string;
  /** Number of news articles analyzed */
  newsCount: number;
  /** Positive keyword hits */
  positiveHits: string[];
  /** Negative keyword hits */
  negativeHits: string[];
}

// ─── News Fetching ─────────────────────────────────────────────────────────

/**
 * Fetch news headlines for a stock ticker using Yahoo Finance.
 *
 * @param ticker - Stock ticker (e.g., "BBCA.JK")
 * @param maxItems - Maximum number of news items to fetch
 * @returns Array of news headline strings
 */
export async function fetchYahooNews(ticker: string, maxItems: number = 10): Promise<string[]> {
  try {
    const response = await axios.get(YAHOO_SEARCH_URL, {
      params: { q: ticker, newsCount: maxItems, quotesCount: 0 },
      headers: YAHOO_HEADERS,
      timeout: 10000,
    });

    const news = response.data?.news;
    if (!Array.isArray(news) || news.length === 0) {
      logger.debug(MODULE, `No news found for ${ticker}`);
      return [];
    }

    const headlines = news.map((item: any) => item.title || "").filter((h: string) => h.length > 0);

    logger.debug(MODULE, `Found ${headlines.length} news items for ${ticker}`);
    return headlines;
  } catch (error: any) {
    logger.warn(MODULE, `Failed to fetch news for ${ticker}: ${error.message}`);
    return [];
  }
}

// ─── Sentiment Analysis ────────────────────────────────────────────────────

/**
 * Simple keyword-based sentiment analysis on news headlines.
 *
 * Scans each headline for positive and negative keywords.
 * Computes a score from -10 to +10 based on the ratio of hits.
 *
 * @param headlines - Array of news headline strings
 * @returns Sentiment analysis result
 */
export function analyzeKeywordSentiment(headlines: string[]): NewsSentiment {
  if (headlines.length === 0) {
    return {
      score: 0,
      summary: "Tidak ada berita terbaru.",
      newsCount: 0,
      positiveHits: [],
      negativeHits: [],
    };
  }

  const positiveHits: string[] = [];
  const negativeHits: string[] = [];
  let positiveCount = 0;
  let negativeCount = 0;

  for (const headline of headlines) {
    const lower = headline.toLowerCase();

    for (const keyword of POSITIVE_KEYWORDS) {
      // Use word boundary for single-word keywords, exact match for phrases
      const isPhrase = keyword.includes(" ");
      const matched = isPhrase ? lower.includes(keyword.toLowerCase()) : new RegExp(`\\b${keyword.toLowerCase()}\\b`).test(lower);
      if (matched) {
        positiveCount++;
        if (!positiveHits.includes(keyword)) {
          positiveHits.push(keyword);
        }
      }
    }

    for (const keyword of NEGATIVE_KEYWORDS) {
      const isPhrase = keyword.includes(" ");
      const matched = isPhrase ? lower.includes(keyword.toLowerCase()) : new RegExp(`\\b${keyword.toLowerCase()}\\b`).test(lower);
      if (matched) {
        negativeCount++;
        if (!negativeHits.includes(keyword)) {
          negativeHits.push(keyword);
        }
      }
    }
  }

  // Calculate score: scale to -10 to +10
  // Require at least 2 unique keyword hits to give a strong signal
  const totalHits = positiveCount + negativeCount;
  const uniquePositive = positiveHits.length;
  const uniqueNegative = negativeHits.length;
  let score = 0;

  if (totalHits > 0) {
    // Net sentiment ratio: (positive - negative) / total, scaled to -10..+10
    const rawScore = Math.round(((positiveCount - negativeCount) / totalHits) * 10);
    // Cap score based on unique keyword diversity
    // Single keyword match caps at ±5, 2+ different keywords can go up to ±10
    const uniqueCount = Math.max(uniquePositive, uniqueNegative);
    const maxScore = uniqueCount >= 3 ? 10 : uniqueCount >= 2 ? 7 : 5;
    score = Math.max(-maxScore, Math.min(maxScore, rawScore));
  }

  // Clamp to range
  score = Math.max(-10, Math.min(10, score));

  // Generate summary
  let summary: string;
  if (score > 3) {
    summary = `Sentimen positif: ditemukan kata kunci ${positiveHits.join(", ")} dalam ${headlines.length} berita.`;
  } else if (score < -3) {
    summary = `Sentimen negatif: ditemukan kata kunci ${negativeHits.join(", ")} dalam ${headlines.length} berita.`;
  } else if (totalHits > 0) {
    summary = `Sentimen netral/campuran dari ${headlines.length} berita.`;
  } else {
    summary = `Tidak ada kata kunci sentimen ditemukan dalam ${headlines.length} berita.`;
  }

  return {
    score,
    summary,
    newsCount: headlines.length,
    positiveHits,
    negativeHits,
  };
}

// ─── Main Function ─────────────────────────────────────────────────────────

/**
 * Fetch news from Yahoo Finance and analyze sentiment for a ticker.
 *
 * @param ticker - Stock ticker (e.g., "BBCA.JK")
 * @returns Sentiment analysis result, or null on failure
 */
export async function getNewsSentiment(ticker: string): Promise<NewsSentiment | null> {
  try {
    const headlines = await fetchYahooNews(ticker);
    const sentiment = analyzeKeywordSentiment(headlines);

    if (sentiment.newsCount > 0) {
      logger.debug(MODULE, `${ticker} — Sentiment: ${sentiment.score > 0 ? "+" : ""}${sentiment.score}/10 | ${sentiment.summary}`);
    }

    return sentiment;
  } catch (error: any) {
    logger.warn(MODULE, `News sentiment failed for ${ticker}: ${error.message}`);
    return null;
  }
}

export default {
  fetchYahooNews,
  analyzeKeywordSentiment,
  getNewsSentiment,
};
