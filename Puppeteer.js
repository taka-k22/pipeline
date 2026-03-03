// puppeteer_vision_agent.js

import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
//import fs from "fs";
import fetch from "node-fetch";
import express from "express";


puppeteer.use(StealthPlugin());

/* ---------------------------
   HTTPサーバ（YOLOイベント受信）
--------------------------- */

const app = express();
app.use(express.json());

let pageRef = null;

app.post("/yolo_event", async (req, res) => {
    const label = req.body.event;
    console.log("YOLOイベント:", label);
    if (pageRef) {
        const msg = `YOLO検出: ${label} が現れました`;
        await pageRef.type("textarea", msg, { delay: 10 });
        await pageRef.keyboard.press("Enter");
        console.log("ChatGPT送信:", msg);
    }
    res.sendStatus(200);
});

app.listen(3000, () => {
    console.log("イベント受信用サーバ起動 :3000");
});

/* ---------------------------
   LLaVA 実行関数
--------------------------- */
async function runLLaVA(prompt) {
    console.log("スナップショット取得中...");
    const img = await fetch("http://localhost:5000/snapshot");
    if (!img.ok) throw new Error("スナップショット取得失敗");
    const buffer = await img.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");
    console.log("LLaVA推論開始...");
    const res = await fetch("http://localhost:11434/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: "llava",
            prompt: prompt,
            images: [base64],
            stream: false,
        }),
    });
    const data = await res.json();
    return data.response;
}

/* ---------------------------
   Puppeteer 起動，ChatGPT監視
--------------------------- */
(async () => {
    const browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null,
        args: [
            "--no-sandbox",
            "--disable-blink-features=AutomationControlled",
        ],
    });
    const page = await browser.newPage();
    await page.goto("https://chat.openai.com/", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("textarea", { timeout: 60000 });
    console.log("テキストエリア検出成功");
    await page.type("textarea", "Say @vision:describe the scene@ when ready.", { delay: 50 });
    await page.keyboard.press("Enter");

    let streamBuffer = "";

    const lastExec = {};
    await page.exposeFunction("onPartialOutput", async (text) => {

        // ChatGPTタグ除去
        text = text.replace(/\[ChatGPT #[0-9]+\]\s*/g, "");
        streamBuffer += text;

        while (true) {
            const start = streamBuffer.indexOf("@");
            if (start === -1) break;
            const end = streamBuffer.indexOf("@", start + 1);
            if (end === -1) break;
            const command = streamBuffer.slice(start + 1, end).trim();
            const now = Date.now();
            if (lastExec[command] && now - lastExec[command] < 1000) {
                console.log("重複防止:", command);
                streamBuffer = streamBuffer.slice(end + 1);
                continue;
            }
            lastExec[command] = now;
            console.log("制御コード:", command);

            // ===== コマンドことの処理 =====
            if (command === "tear") {
                try {
                    const res = await fetch("http://kokomi.local:5000/command", {
                        method: "POST",
                        body: "tear",
                        headers: { "Content-Type": "text/plain" },
                    });
                    console.log("💧 tear送信 →", res.status);
                } catch (err) {
                    console.error("tear失敗:", err.message);
                }
            }

            if (command.startsWith("vision:")) {
                const question = command.replace("vision:", "").trim();
                const result = await runLLaVA(question);
                console.log("LLaVA:", result);
            }
            streamBuffer = streamBuffer.slice(end + 1);
        }
    });

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
                            if (line.trim())
                                window.onPartialOutput(`[ChatGPT #${idx}] ${line.trim()}`);
                        });
                    }
                }
            });
        }
        console.log("ChatGPT 出力監視スタート");
        setInterval(pollTexts, 300);
    });

})();
