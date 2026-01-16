// puppeteer_tearsync_persistent.js
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import fs from "fs";
import fetch from "node-fetch";

puppeteer.use(StealthPlugin());

(async () => {
  // -------------------------------
  // 永続プロファイル設定
  // -------------------------------
  const browser = await puppeteer.launch({
    headless: false,

    // ★ Puppeteer 内蔵 Chromium のプロファイル永続化
    userDataDir: "C:\\Users\\takan\\puppeteer_profiles\\kokomi_chromium",

    defaultViewport: null,
    args: [
      "--no-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--profile-directory=Default",
    ],
  });

  const page = await browser.newPage();

  // -------------------------------
  // ChatGPT へアクセス
  // -------------------------------
  await page.goto("https://chat.openai.com/", {
    waitUntil: "domcontentloaded",
  });

  await page.waitForSelector("textarea", { timeout: 60000 });
  console.log("テキストエリア検出成功");

  // -------------------------------
  // テストメッセージ送信
  // -------------------------------
  await page.type("textarea", "Write a test message with @tear@ inside.", {
    delay: 50,
  });
  await page.keyboard.press("Enter");

  // -------------------------------
  // onPartialOutput の定義
  // -------------------------------
  await page.exposeFunction("onPartialOutput", async (text) => {
    process.stdout.write(`🧠 ${text}\n`);

    const regex = /@([^@]+)@/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      const command = match[1].trim();
      console.log(`制御コード検出: ${command}`);

      // ローカルログ
      fs.appendFileSync(
        "commands.log",
        `${new Date().toISOString()} ${command}\n`
      );

      // Flask へ送信
      try {
        const res = await fetch("http://kokomi.local:5000/command", {
          method: "POST",
          body: command,
          headers: { "Content-Type": "text/plain" },
        });

        console.log(`コマンド送信: ${command} → ${res.status}`);
      } catch (err) {
        console.error(`Flask送信失敗 (${command}):`, err.message);
      }
    }
  });

  // -------------------------------
  // ChatGPT 出力監視ループ
  // -------------------------------
  await page.evaluate(() => {
    let lastContents = new Map();

    function pollTexts() {
      const containers = document.querySelectorAll(".markdown.prose");

      containers.forEach((container, idx) => {
        const currentText = container.innerText.trim();
        const lastText = lastContents.get(container) || "";

        if (currentText && currentText !== lastText) {
          const newPart = currentText.slice(lastText.length);
          lastContents.set(container, currentText);

          if (newPart) {
            newPart.split("\n").forEach((line) => {
              if (line.trim()) {
                window.onPartialOutput(`[ChatGPT #${idx}] ${line.trim()}`);
              }
            });
          }
        }
      });
    }

    console.log("ChatGPT 出力監視スタート（persistent profile）");
    setInterval(pollTexts, 300);
  });
})();
