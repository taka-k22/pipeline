import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import fetch from "node-fetch";
import express from "express";

puppeteer.use(StealthPlugin());

/* ---------------------------
   BME280ポーリング
--------------------------- */
let latestSensor = null;
async function pollSensor() {
    try {
        const res = await fetch("http://kokomi.local:5001/sensor_data");
        if (!res.ok) {
            console.log("sensor fetch error:", res.status);
            return;
        }
        const data = await res.json();
        latestSensor = data;
    } catch (err) {
        console.log("sensor fetch failed:", err.message);
    }
}
setInterval(pollSensor, 1000);

/* ---------------------------
   YOLOイベントリッスン
--------------------------- */
const app = express();
app.use(express.json());
let page = null;
app.post("/yolo_event", async (req, res) => {
    const label = req.body.event;
    console.log("YOLOイベント:", label);
    if (page) {
        const msg = `YOLO検出: ${label} が現れました`;
        await page.type("textarea", msg, { delay: 10 });
        await page.keyboard.press("Enter");
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
    const instruction = "回答は日本語で30文字以内。\n";
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
            prompt: instruction + prompt,
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
    /*const browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null,
        args: [
            "--no-sandbox",
            "--disable-blink-features=AutomationControlled",
        ],
    });*/
    const browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null,
        userDataDir: "./chrome_profile",
        args: [
            "--no-sandbox",
            "--start-maximized"
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
            //制御コード抽出
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

            // 涙液モジュール  MT形式のコマンドを受け取ったらそのままラズパイに送信
            if (/^MT[0-9A-Fa-f]{6};$/.test(command)) {
                try {
                    const res = await fetch("http://kokomi.local:5000/command", {
                        method: "POST",
                        headers: {
                            "Content-Type": "text/plain"
                        },
                        body: command
                    });
                    console.log("Motor 送信 →", command, res.status);
                } catch (err) {
                    console.error("Motor 送信失敗:", err.message);
                }
            }

            // RGB LEDモジュール LTRBGの6桁16進数を受け取り，そのままラズパイに送信
            if (/^LT[0-9A-Fa-f]{6};$/.test(command)) {
                try {
                    const res = await fetch("http://kokomi.local:5002/command", {
                        method: "POST",
                        headers: {
                            "Content-Type": "text/plain"
                        },
                        body: command
                    });
                    console.log("RGB LED 送信 →", command, res.status);
                } catch (err) {
                    console.error("RGB LED 送信失敗:", err.message);
                }
            }

            //BME280センサ値送信 @THP@ を受け取ったら最新のセンサ値をChatGPTに送信
            if (command === "THP") {
                if (!latestSensor) {
                    console.log("センサ値未取得");
                    return;
                }
                const msg =
                    `Sensor | Temp: ${latestSensor.temp.toFixed(2)} °C ` +
                    `Hum: ${latestSensor.humidity.toFixed(2)}% ` +
                    `Press: ${latestSensor.pressure.toFixed(2)} hPa`;
                console.log("LLM送信:", msg);
                if (page) {
                    await page.type("textarea", msg, { delay: 10 });
                    await page.keyboard.press("Enter");
                }
            }

            // Visionコマンド
            if (command.startsWith("vision:")) {
                const question = command.replace("vision:", "").trim();
                const result = await runLLaVA(question);
                console.log("LLaVA:", result);
                const msg =
                    `Vision result for "${question}":\n` +
                    result;
                if (page) {
                    await page.type('textarea, div[contenteditable="true"]', msg, { delay: 5 });
                    await page.keyboard.press("Enter");
                    console.log("LLM送信:", msg.slice(0, 80) + (msg.length > 80 ? "..." : ""));
                }
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
