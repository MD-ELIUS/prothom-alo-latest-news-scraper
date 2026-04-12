const { scrape } = require("../index");

module.exports = async function handler(req, res) {
  const { key } = req.query;

  // Security check: Only allow if the key matches the environment variable
  const scraperKey = process.env.SCRAPER_KEY || "my_special_scraper_key_2026";
  if (key !== scraperKey) {
    return res.status(401).json({ success: false, message: "Unauthorized: Invalid or missing key" });
  }

  try {
    console.log("Scrape triggered via API");
    await scrape();
    res.status(200).json({ success: true, message: "Scrape completed" });
  } catch (error) {
    console.error("Scrape failed:", error);
    res.status(500).json({ success: false, error: error.message });
  }
}
