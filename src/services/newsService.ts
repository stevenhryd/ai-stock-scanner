import { GoogleGenerativeAI } from "@google/generative-ai";
import Parser from "rss-parser";
import logger from "../utils/logger.js";
import config from "../config/index.js";

const MODULE = "NewsService";
const parser = new Parser();

export interface AISentiment {
  score: number; // -10 to 10
  summary: string;
}

/**
 * Fetch latest news headlines from Google News RSS for a specific ID stock ticker.
 */
export async function fetchStockNews(ticker: string, maxItems: number = 5): Promise<string[]> {
  try {
    const symbolCode = ticker.replace(".JK", "");
    // Search query for Google News Indonesia
    const query = encodeURIComponent(`"saham ${symbolCode}" OR "${symbolCode}" IDX`);
    const feedUrl = `https://news.google.com/rss/search?q=${query}&hl=id&gl=ID&ceid=ID:id`;

    // Use timeout and user-agent
    const feed = await parser.parseURL(feedUrl);

    const headlines = feed.items.slice(0, maxItems).map((item) => `${item.title} (${item.pubDate})`);

    if (headlines.length === 0) {
      logger.debug(MODULE, `No news found for ${ticker}`);
    } else {
      logger.debug(MODULE, `Found ${headlines.length} news items for ${ticker}`);
    }

    return headlines;
  } catch (error: any) {
    logger.warn(MODULE, `Failed to fetch news for ${ticker}: ${error.message}`);
    return [];
  }
}

/**
 * Analyze news headlines using Google Gemini API directly and return a sentiment score & summary.
 */
export async function analyzeSentimentWithGemini(ticker: string, newsHeadlines: string[]): Promise<AISentiment | null> {
  const apiKey = config.ai.geminiApiKey;
  if (!apiKey) {
    logger.warn(MODULE, "Gemini API Key missing! Cannot perform AI Sentiment Analysis.");
    return null;
  }

  if (!newsHeadlines || newsHeadlines.length === 0) {
    return { score: 0, summary: "Tidak ada berita terbaru." };
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" }); // or gemini-2.5-flash if preferred, wait, stick to gemini-1.5-flash for speed or gemini-2.0-flash / gemini-1.5-flash

    // The prompt format needs to enforce strict JSON output so we can parse it reliably
    const prompt = `Anda adalah seorang asisten ahli Analisa Saham Indonesia.
Tugas Anda adalah menilai sentimen dari beberapa judul berita terbaru terkait saham dengan kode ${ticker.replace(".JK", "")}.
Berikut daftar beritanya:
${newsHeadlines.map((h, i) => `${i + 1}. ${h}`).join("\n")}

Instruksi:
1. Berikan "score" (angka dari -10 sampai 10), di mana -10 = sangat berisiko/negatif, 0 = netral, dan 10 = sangat bullish/positif.
2. Buat "summary" singkat (maksimal 2 kalimat) menyimpulkan sentimen keseluruhan dalam bahasa Indonesia yang menarik dan to-the-point untuk dibaca trader.

PENTING: Output HARUS berbentuk murni JSON dengan format persis seperti ini tanpa blok kode markdown atau teks tambahan apapun:
{
  "score": <angka>,
  "summary": "<kalimat summary>"
}
`;

    const result = await model.generateContent(prompt);
    const textResp = result.response.text().trim();

    // Strip possible markdown code blocks if the model still adds them
    const cleanJsonText = textResp.replace(/```(json)?|```/g, "").trim();
    const parsed = JSON.parse(cleanJsonText);

    return {
      score: typeof parsed.score === "number" ? parsed.score : parseInt(parsed.score, 10) || 0,
      summary: parsed.summary || "Summary tidak tersedia.",
    };
  } catch (error: any) {
    logger.warn(MODULE, `Gemini analysis failed for ${ticker}: ${error.message}`);
    return null;
  }
}

/**
 * Main function: Gets news & analyzes sentiment in one go.
 */
export async function getNewsSentiment(ticker: string): Promise<AISentiment | null> {
  const headlines = await fetchStockNews(ticker);
  if (headlines.length > 0) {
    return await analyzeSentimentWithGemini(ticker, headlines);
  }
  return { score: 0, summary: "Tidak ada berita spesifik terbaru akhir-akhir ini." };
}
