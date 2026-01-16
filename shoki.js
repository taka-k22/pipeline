import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
//ロボット回避して，入力成功．拾うのは無理
puppeteer.use(StealthPlugin());

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: [
      "--no-sandbox",
      "--disable-blink-features=AutomationControlled"
    ]
  });

  const page = await browser.newPage();
  await page.goto("https://chat.openai.com/", { waitUntil: "domcontentloaded" });

  try {
    console.log("⌛ textarea を待機中...");
    await page.waitForSelector("textarea", { timeout: 60000 });

    console.log("✅ テキストエリアが見つかりました！");
    await page.type("textarea", "Hello from Puppeteer 👋", { delay: 50 });
    await page.keyboard.press("Enter");

    console.log("💬 メッセージ送信しました。応答を待機中...");

    await page.waitForSelector(".markdown.prose", { timeout: 120000 });

    // 最後のレスポンスを取得
    const response = await page.$$eval(".markdown.prose", nodes =>
      nodes[nodes.length - 1]?.innerText
    );

    console.log("🤖 ChatGPTの応答:", response);

  } catch (err) {
    console.error("❌ エラー:", err.message);
    await page.screenshot({ path: "error_screenshot.png" });
    console.log("📸 error_screenshot.png を保存しました");
  }

  // await browser.close(); ← デバッグ中は手動で閉じる
})();
