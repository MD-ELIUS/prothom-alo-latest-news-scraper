const puppeteer = require("puppeteer-core");
const axios = require("axios");
const express = require("express");
const app = express();
const PORT = process.env.PORT || 3005;

let chromium;
try {
  chromium = require("@sparticuz/chromium-min");
} catch (e) {
  // Local environment might not have this
}

// ⚠️ Render এর Environment Variables থেকে Webhook URL নেবে
const WEBHOOK_URL = process.env.WEBHOOK_URL || "https://n8n-latest-tl33.onrender.com/webhook/news";
const SCRAPER_KEY = process.env.SCRAPER_KEY || "my_special_scraper_key_2026";


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

  const num = parseInt((text.match(/(\d+)/) || [])[1]);
  if (isNaN(num)) return null;

  // ঘন্টা (hour) হলে মিনিটে convert করো
  if (/ঘন্টা|hour|hr/i.test(text)) {
    return num * 60;
  }

  // দিন (day) হলে মিনিটে convert করো
  if (/দিন|day/i.test(text)) {
    return num * 1440;
  }

  // default: মিনিট
  return num;
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
      timeout: 30000, // ৩০ সেকেন্ড করে দেওয়া হলো
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
    console.log(`🔍 FETCHING DETAILS: ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    // Wait for article body to render
    await page.waitForSelector(
      ".story-contents, .story-elements-wrapper, [class*='story-content'], article p",
      { timeout: 10000 }
    ).catch(() => { }); 

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
        document.querySelector("time[datetime]") ||
        document.querySelector("article time") ||
        document.querySelector("time");

      let rawTime = "";
      if (timeEl) {
        rawTime = timeEl.innerText.trim() || "";
        if (!isoTime) isoTime = timeEl.getAttribute("datetime") || "";
      }

      // ==========================================
      // PROTHOM ALO SPECIFIC CONTENT EXTRACTION
      // ==========================================
      let description = "";

      // Helper: clean and extract text from a container element
      function extractText(container) {
        if (!container) return "";
        // Clone so we don't mutate the real DOM
        const clone = container.cloneNode(true);
        // Remove noise: scripts, styles, ads, share buttons, related links, image captions
        clone.querySelectorAll(
          'script, style, noscript, iframe, ' +
          '[class*="ad"], [class*="advertisement"], [class*="sponsor"], ' +
          '[class*="share"], [class*="social"], [class*="related"], ' +
          '[class*="caption"], [class*="photo-caption"], ' +
          '[aria-hidden="true"], [hidden], .visually-hidden, .sr-only'
        ).forEach(el => el.remove());
        return clone.innerText.trim();
      }

      // 1. Prothom Alo primary: .story-contents or .story-elements-wrapper
      const storyContents =
        document.querySelector(".story-contents") ||
        document.querySelector(".story-elements-wrapper") ||
        document.querySelector("[class*='story-content']") ||
        document.querySelector("[class*='story-element']");

      if (storyContents) {
        description = extractText(storyContents);
      }

      // 2. Fallback: paragraphs inside .story-contents
      if (!description) {
        const paras = document.querySelectorAll(
          ".story-contents p, .story-elements-wrapper p, [class*='story-content'] p"
        );
        if (paras.length > 0) {
          description = Array.from(paras)
            .map(p => p.innerText.trim())
            .filter(p => p.length > 0)
            .join("\n\n");
        }
      }

      // 3. Fallback: <article> tag
      if (!description) {
        description = extractText(document.querySelector("article"));
      }

      // 4. Fallback: all <p> tags on the page (broad)
      if (!description) {
        description = Array.from(document.querySelectorAll("p"))
          .map(p => p.innerText.trim())
          .filter(p => p.length > 20)
          .join("\n\n");
      }

      // 5. Last resort: meta description
      if (!description) {
        description = document.querySelector('meta[name="description"]')?.content || "";
      }

      return {
        image,
        description,
        publishTime: isoTime || rawTime || ""
      };
    });

  } catch (err) {
    console.log("❌ SCRAPE DETAIL ERROR:", err.message);
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
// BD ISO FORMATTER (With +06:00 Offset)
// ==========================
function formatBDISO(date) {
  const options = {
    timeZone: 'Asia/Dhaka',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  };
  const formatter = new Intl.DateTimeFormat('en-CA', options);
  const parts = formatter.formatToParts(date);
  const f = (type) => parts.find(p => p.type === type).value;
  return `${f('year')}-${f('month')}-${f('day')}T${f('hour')}:${f('minute')}:${f('second')}.000+06:00`;
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


  if (process.env.VERCEL || process.env.RENDER) {
    console.log("🌐 Detected Cloud Environment (Vercel/Render)");
    const CHROMIUM_PACK_URL = "https://github.com/Sparticuz/chromium/releases/download/v143.0.4/chromium-v143.0.4-pack.x64.tar";
    options = {
      args: [
        ...(chromium ? chromium.args : []),
        "--hide-scrollbars",
        "--disable-web-security",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--single-process",
        "--no-zygote"
      ],
      defaultViewport: chromium ? chromium.defaultViewport : null,
      executablePath: await chromium.executablePath(CHROMIUM_PACK_URL),
      headless: chromium ? chromium.headless : true,
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

  // Set User Agent to avoid being blocked and speed up loading
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36');

  console.log("📄 Opening Prothom Alo...");
  await page.goto(
    "https://www.prothomalo.com/collection/latest",
    { waitUntil: "domcontentloaded", timeout: 60000 }
  );

  // Set Viewport to mimic a real desktop browser
  await page.setViewport({ width: 1280, height: 800 });

  console.log("⏳ Waiting for news to load...");
  // অন্তত একটি নিউজ কার্ড আসা পর্যন্ত ১০ সেকেন্ড অপেক্ষা করবে
  await page.waitForSelector(".wide-story-card, .news_with_item", { timeout: 15000 }).catch(() => {
    console.log("⚠️ No news cards found after 15s wait.");
  });

  console.log("📄 Page loaded & Hydrated");

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

    console.log(`📝 DESC (200): ${details.description?.substring(0, 200) || "❌ EMPTY"}`);


    // Prepare payload as per strict requirements
    const payload = {
      title: news.title,
      description: details.description, // FULL ARTICLE TEXT ONLY
      link: news.link,
      image: details.image || "",
      source: "prothom alo",
      sourceBangla: "প্রথম আলো",
      sourceTime: formatBDISO(pubDate)
    };

    console.log(`🚀 SENDING TO WEBHOOK: ${payload.title}`);
    await sendToN8N(payload);
  }

  await browser.close();

  console.log("\n🎉 DONE!");
}

// ==========================
// SERVER ROUTES (For Render/External Cron)
// ==========================

// Health Check
app.get("/", (req, res) => {
  res.send("Prothom Alo News Scraper is Running! 🚀");
});

// Scrape Endpoint
app.get("/scrape", async (req, res) => {
  const { key } = req.query;

  if (key !== SCRAPER_KEY) {
    return res.status(401).json({ success: false, message: "Unauthorized: Invalid or missing key" });
  }

  try {
    console.log("🚀 Scrape triggered via HTTP/Cron");
    // Run in background to avoid Render timeout
    scrape().catch(err => {
      console.error("❌ CRITICAL SCRAPE ERROR:", err.message);
      console.error(err.stack);
    });

    res.status(200).json({ 
      success: true, 
      message: "Scraping started in background...",
      environment: process.env.RENDER ? "Render" : "Local" 
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Export for Vercel
module.exports = app;

// Run Server if not on Vercel
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`📡 Server is listening on port ${PORT}`);
    console.log(`🔗 Scrape URL: http://localhost:${PORT}/scrape?key=YOUR_KEY`);
  });
}

// Keep scrape available for direct module usage if needed
module.exports.scrape = scrape;
