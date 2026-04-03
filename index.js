const puppeteer = require("puppeteer-core");
const axios = require("axios");
let chromium;
try {
  chromium = require("@sparticuz/chromium-min");
} catch (e) {
  // Local environment might not have this
}

const WEBHOOK_URL = "https://n8n-0g84.onrender.com/webhook/news";

const sent = new Set();

// ==========================
// BANGLA NUMBER FIX
// ==========================
function convertBanglaToEnglish(str = "") {
  const map = {
    "০": "0", "১": "1", "২": "2", "৩": "3", "৪": "4",
    "৫": "5", "৬": "6", "৭": "7", "৮": "8", "৯": "9"
  };

  return str.replace(/[০-৯]/g, d => map[d]);
}

// ==========================
// TIME PARSER (LIST PAGE FILTER ONLY)
// ==========================
function parseMinutes(text = "") {
  text = convertBanglaToEnglish(text)
    .replace(/\u00a0/g, " ")
    .trim();

  const match = text.match(/(\d+)/);
  if (!match) return null;

  return parseInt(match[1]);
}

// ==========================
// FILTER (10 MIN)
// ==========================
function isWithinLimit(text, limit = 10) {
  const min = parseMinutes(text);

  console.log("⏱ PARSED MIN:", min);

  if (min === null || isNaN(min)) return false;

  return min <= limit;
}

// ==========================
// SAFE SEND
// ==========================
async function sendToN8N(payload, retry = 2) {
  if (sent.has(payload.link)) return;

  try {
    await axios.post(WEBHOOK_URL, payload, {
      timeout: 10000,
      headers: { "Content-Type": "application/json" }
    });

    sent.add(payload.link);
    console.log("📤 SENT:", payload.title);

  } catch (err) {
    console.log("❌ SEND ERROR:", err.message);

    if (retry > 0) {
      console.log("🔁 RETRYING...");
      await sendToN8N(payload, retry - 1);
    }
  }
}

// ==========================
// DETAIL SCRAPER
// ==========================
async function scrapeDetails(page, url) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });

    return await page.evaluate(() => {
      const image =
        document.querySelector('meta[property="og:image"]')?.content ||
        document.querySelector("article img")?.src ||
        "";

      // Try to find the most accurate ISO timestamp
      let isoTime = "";
      const meta = document.querySelector('meta[property="article:published_time"]');
      const ldJsonScript = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
                                .find(s => s.innerText.includes("datePublished"));
      
      if (ldJsonScript) {
        const match = ldJsonScript.innerText.match(/"datePublished"\s*:\s*"([^"]+)"/);
        if (match) isoTime = match[1];
      }
      
      if (!isoTime && meta) {
        isoTime = meta.content;
      }

      const timeEl =
        document.querySelector("article time") ||
        document.querySelector("time");

      let rawTime = "";
      if (timeEl) {
        rawTime = timeEl.innerText.trim() || "";
        if (!isoTime) isoTime = timeEl.getAttribute("datetime") || "";
      }

      const description =
        Array.from(document.querySelectorAll("article p"))
          .map(p => p.innerText.trim())
          .filter(p => p.length > 40)
          .slice(0, 2)
          .join(" ") ||
        document.querySelector('meta[name="description"]')?.content ||
        "";

      return {
        image,
        description,
        publishTime: isoTime || rawTime || ""
      };
    });

  } catch (err) {
    return { image: "", description: "", publishTime: "" };
  }
}

// ==========================
// 🔥 FIXED BST CONVERTER (FINAL)
// ==========================
function getBSTDate(timeStr) {
  try {
    if (!timeStr) return new Date();

    // Convert Bengali digits to English for parsing
    const text = convertBanglaToEnglish(timeStr).trim();

    // Handle relative time (minutes ago)
    const minMatch = text.match(/(\d+)\s*(minute|min|মিনিট)/i);
    if (minMatch) {
      return new Date(Date.now() - parseInt(minMatch[1]) * 60000);
    }

    // Handle relative time (hours ago)
    const hourMatch = text.match(/(\d+)\s*(hour|hr|ঘন্টা)/i);
    if (hourMatch) {
      return new Date(Date.now() - parseInt(hourMatch[1]) * 3600000);
    }

    // Handle absolute dates/ISO strings
    const date = new Date(text);
    if (!isNaN(date.getTime())) {
      return date;
    }

    return new Date();

  } catch (e) {
    return new Date();
  }
}

// ==========================
// FORMAT HELPER
// ==========================
function formatBST(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Dhaka",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date);

  const f = type => parts.find(p => p.type === type).value;
  return `${f("year")}-${f("month")}-${f("day")} ${f("hour")}:${f("minute")}:${f("second")}`;
}

// ==========================
// BENGALI FORMAT HELPER
// ==========================
function formatBengaliDate(date) {
  const options = {
    timeZone: "Asia/Dhaka",
    day: "2-digit",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  };

  const formatter = new Intl.DateTimeFormat("bn-BD", options);
  let str = formatter.format(date);
  
  // Refining format to "০৩ এপ্রিল ২০২৬, ২০:২৭"
  return str.replace(",", "").replace(" এ ", ", ");
}

// ==========================
// MAIN SCRAPER
// ==========================
async function scrape() {
  console.log("🚀 Launching browser...");

  let options = {};

  if (process.env.VERCEL) {
    const CHROMIUM_PACK_URL = "https://github.com/Sparticuz/chromium/releases/download/v143.0.4/chromium-v143.0.4-pack.x64.tar";
    options = {
      args: [...chromium.args, "--hide-scrollbars", "--disable-web-security"],
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(CHROMIUM_PACK_URL),
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    };
  } else {
    // Local development - change this path if your Chrome is installed elsewhere
    options = {
      headless: "new",
      executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    };
  }

  const browser = await puppeteer.launch(options);

  const page = await browser.newPage();

  await page.goto(
    "https://www.prothomalo.com/collection/latest",
    { waitUntil: "networkidle2" }
  );

  console.log("📄 Page loaded");

  const newsList = await page.evaluate(() => {
    const items = [];

    document.querySelectorAll(".wide-story-card, .news_with_item")
      .forEach(el => {

        const title =
          el.querySelector("h3 a span")?.innerText?.trim() || "";

        const link =
          el.querySelector("a")?.href || "";

        const time =
          el.querySelector("time")?.innerText?.trim() || "";

        if (title && link) {
          items.push({ title, link, time });
        }
      });

    return items;
  });

  console.log("📦 TOTAL:", newsList.length);

  // Reverse the list so oldest is processed first and latest is last
  for (let news of newsList.reverse()) {

    console.log("\n=====================");
    console.log("📰 TITLE:", news.title);
    console.log("⏰ TIME :", news.time);

    if (!isWithinLimit(news.time, 10)) {
      console.log(`⛔ SKIPPED (OLD): ${news.title} (${news.time})`);
      continue;
    }

    console.log(`🔍 FETCHING: ${news.link}`);
    const details = await scrapeDetails(page, news.link);
    const pubDate = getBSTDate(details.publishTime || news.time);

    const payload = {
      source: "prothom_alo",
      title: news.title,
      link: news.link,
      image: details.image || "",
      description: `প্রকাশ: ${formatBengaliDate(pubDate)} — ${details.description}`,
      time_text: formatBST(pubDate),
      scraped_at: formatBST(new Date())
    };

    console.log(`🚀 SENDING TO WEBHOOK: ${payload.title}`);
    await sendToN8N(payload);
  }

  await browser.close();

  console.log("\n🎉 DONE!");
}

// Export for Vercel
module.exports = scrape;

// Run if called directly
if (require.main === module) {
  scrape();
}
