import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import fetch from "node-fetch";
import express from "express";

puppeteer.use(StealthPlugin());

const CHAT_INPUT_SELECTOR = 'textarea, div[contenteditable="true"]';
const VALID_TOP_LEVEL_FIELDS = new Set(["speech", "emotion", "intensity", "actions", "requests"]);
const VALID_EMOTIONS = new Set([
    "neutral",
    "happy",
    "calm",
    "sad",
    "angry",
    "surprised",
    "fear",
    "thinking",
]);
const SENSOR_UNITS = {
    temperature: "celsius",
    humidity: "percent",
    pressure: "hpa",
};

let latestSensor = null;
let page = null;

/* ---------------------------
   BME280 polling
--------------------------- */
async function pollSensor() {
    try {
        const res = await fetch("http://kokomi.local:5000/bme280/sensor_data");
        if (!res.ok) {
            console.log("sensor fetch error:", res.status);
            return;
        }
        latestSensor = await res.json();
    } catch (err) {
        console.log("sensor fetch failed:", err.message);
    }
}
setInterval(pollSensor, 1000);
pollSensor();

/* ---------------------------
   JSON stream extraction and audit
--------------------------- */
function extractCompleteJsonObjects(buffer) {
    const objects = [];
    let firstObjectStart = -1;
    let depth = 0;
    let inString = false;
    let escapeNext = false;
    let objectStart = -1;
    let consumedUntil = 0;

    for (let i = 0; i < buffer.length; i += 1) {
        const char = buffer[i];

        if (objectStart === -1) {
            if (char === "{") {
                objectStart = i;
                if (firstObjectStart === -1) firstObjectStart = i;
                depth = 1;
                inString = false;
                escapeNext = false;
            }
            continue;
        }

        if (escapeNext) {
            escapeNext = false;
            continue;
        }

        if (char === "\\") {
            if (inString) escapeNext = true;
            continue;
        }

        if (char === "\"") {
            inString = !inString;
            continue;
        }

        if (inString) continue;

        if (char === "{") {
            depth += 1;
        } else if (char === "}") {
            depth -= 1;
            if (depth === 0) {
                objects.push(buffer.slice(objectStart, i + 1));
                consumedUntil = i + 1;
                objectStart = -1;
            }
        }
    }

    if (objectStart !== -1) {
        return {
            objects,
            rest: buffer.slice(objectStart),
        };
    }

    return {
        objects,
        rest: consumedUntil > 0 ? buffer.slice(consumedUntil) : "",
    };
}

function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactlyKeys(obj, keys) {
    const actual = Object.keys(obj);
    return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function validateSpeech(payload) {
    const hasSpeech = Object.prototype.hasOwnProperty.call(payload, "speech");
    const hasEmotion = Object.prototype.hasOwnProperty.call(payload, "emotion");
    const hasIntensity = Object.prototype.hasOwnProperty.call(payload, "intensity");

    if (!hasSpeech) {
        if (hasEmotion || hasIntensity) {
            return "emotion and intensity must not exist without speech";
        }
        return null;
    }

    if (!hasEmotion || !hasIntensity) {
        return "speech requires emotion and intensity";
    }
    if (typeof payload.speech !== "string") {
        return "speech must be a string";
    }
    if (!VALID_EMOTIONS.has(payload.emotion)) {
        return "emotion is invalid";
    }
    if (typeof payload.intensity !== "number" || !Number.isFinite(payload.intensity)) {
        return "intensity must be a finite number";
    }
    if (payload.intensity < 0.0 || payload.intensity > 1.0) {
        return "intensity must be from 0.0 to 1.0";
    }

    return null;
}

function validateActions(actions) {
    if (!Array.isArray(actions)) {
        return "actions must be an array";
    }

    for (const action of actions) {
        if (!isPlainObject(action) || !hasExactlyKeys(action, ["type", "params"])) {
            return "each action must be an object with exactly type and params";
        }
        if (!isPlainObject(action.params)) {
            return "action params must be an object";
        }

        if (action.type === "tear") {
            if (!hasExactlyKeys(action.params, ["speed", "duration"])) {
                return "tear params must contain exactly speed and duration";
            }
            if (!Number.isInteger(action.params.speed) || action.params.speed < 0 || action.params.speed > 255) {
                return "tear speed must be an integer from 0 to 255";
            }
            if (!Number.isInteger(action.params.duration) || action.params.duration < 0 || action.params.duration > 255) {
                return "tear duration must be an integer from 0 to 255";
            }
            continue;
        }

        if (action.type === "led_change") {
            if (!hasExactlyKeys(action.params, ["color"])) {
                return "led_change params must contain exactly color";
            }
            if (typeof action.params.color !== "string" || !/^#[0-9A-Fa-f]{6}$/.test(action.params.color)) {
                return "led_change color must be #RRGGBB";
            }
            continue;
        }

        return `unknown action type: ${action.type}`;
    }

    return null;
}

function validateRequests(requests) {
    if (!Array.isArray(requests)) {
        return "requests must be an array";
    }

    const validSensorRequests = new Set(["temperature", "humidity", "pressure"]);

    for (const request of requests) {
        if (typeof request === "string") {
            if (!validSensorRequests.has(request)) {
                return `unknown request: ${request}`;
            }
            continue;
        }

        if (!isPlainObject(request) || !hasExactlyKeys(request, ["type", "params"])) {
            return "object request must contain exactly type and params";
        }
        if (request.type !== "vision") {
            return `unknown request type: ${request.type}`;
        }
        if (!isPlainObject(request.params) || !hasExactlyKeys(request.params, ["task"])) {
            return "vision params must contain exactly task";
        }
        if (request.params.task !== "describe_scene") {
            return "vision task must be describe_scene";
        }
    }

    return null;
}

function auditLLMJson(payload) {
    if (!isPlainObject(payload)) {
        return { ok: false, reason: "payload must be a JSON object" };
    }

    for (const field of Object.keys(payload)) {
        if (!VALID_TOP_LEVEL_FIELDS.has(field)) {
            return { ok: false, reason: `unknown top-level field: ${field}` };
        }
    }

    if (!("speech" in payload) && !("actions" in payload) && !("requests" in payload)) {
        return { ok: false, reason: "payload must include speech, actions, or requests" };
    }

    const speechError = validateSpeech(payload);
    if (speechError) return { ok: false, reason: speechError };

    if ("actions" in payload) {
        const actionsError = validateActions(payload.actions);
        if (actionsError) return { ok: false, reason: actionsError };
    }

    if ("requests" in payload) {
        const requestsError = validateRequests(payload.requests);
        if (requestsError) return { ok: false, reason: requestsError };
    }

    return { ok: true, payload };
}

/* ---------------------------
   Kernel output
--------------------------- */
async function sendJsonToChatGPT(obj) {
    if (!page) {
        console.log("ChatGPT send skipped: page is not ready", obj);
        return;
    }

    const json = JSON.stringify(obj, null, 2);
    await page.waitForSelector(CHAT_INPUT_SELECTOR, { timeout: 60000 });
    await page.type(CHAT_INPUT_SELECTOR, json, { delay: 5 });
    await page.keyboard.press("Enter");
    console.log("ChatGPT JSON sent:", json);
}

async function sendActionToPi(action) {
    const url =
        action.type === "tear"
            ? "http://kokomi.local:5000/motor/command"
            : "http://kokomi.local:5000/led/command";

    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action),
    });

    console.log("executed action:", action, "status:", res.status);
}

function readSensorField(field) {
    if (!latestSensor) return undefined;
    if (field === "temperature") {
        return latestSensor.temperature ?? latestSensor.temp;
    }
    return latestSensor[field];
}

function buildSensorResponse(requests) {
    const sensor = {};
    const units = {};

    for (const request of requests) {
        if (typeof request !== "string") continue;

        const value = readSensorField(request);
        if (typeof value !== "number" || !Number.isFinite(value)) {
            console.log("sensor field unavailable:", request);
            continue;
        }

        sensor[request] = value;
        units[request] = SENSOR_UNITS[request];
    }

    if (Object.keys(sensor).length === 0) return null;
    return { sensor, units };
}

async function executeAuditedPayload(payload) {
    if ("speech" in payload) {
        console.log("speech:", {
            speech: payload.speech,
            emotion: payload.emotion,
            intensity: payload.intensity,
        });
        // TODO: Call TTS here after the speech system is wired into the JSON protocol.
    }

    if ("actions" in payload) {
        for (const action of payload.actions) {
            try {
                await sendActionToPi(action);
            } catch (err) {
                console.error("action execution failed:", action, err.message);
            }
        }
    }

    if ("requests" in payload) {
        console.log("executed requests:", payload.requests);

        const sensorResponse = buildSensorResponse(payload.requests);
        if (sensorResponse) {
            await sendJsonToChatGPT(sensorResponse);
        } else if (payload.requests.some((request) => typeof request === "string")) {
            console.log("sensor response skipped: no requested sensor values available");
        }

        for (const request of payload.requests) {
            if (typeof request === "object" && request.type === "vision") {
                try {
                    const query = "describe the scene";
                    const result = await runLLaVA(query);
                    console.log("LLaVA:", result);
                    await sendJsonToChatGPT({
                        vision: {
                            query,
                            result,
                        },
                    });
                } catch (err) {
                    console.error("vision request failed:", err.message);
                }
            }
        }
    }
}

/* ---------------------------
   YOLO event listener
--------------------------- */
const app = express();
app.use(express.json());

app.post("/yolo_event", async (req, res) => {
    console.log("YOLO event:", req.body);
    await sendJsonToChatGPT({
        event: {
            source: "deepsort",
            type: "person_appeared",
            message: "A person has appeared.",
        },
    });
    res.sendStatus(200);
});

app.listen(3000, () => {
    console.log("YOLO event server listening on :3000");
});

/* ---------------------------
   LLaVA
--------------------------- */
async function runLLaVA(prompt) {
    const instruction = "Answer in Japanese within 30 characters.\n";
    console.log("fetching snapshot...");
    const img = await fetch("http://localhost:5000/snapshot");
    if (!img.ok) throw new Error("snapshot fetch failed");

    const buffer = await img.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");

    console.log("running LLaVA...");
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

    if (!res.ok) throw new Error(`LLaVA request failed: ${res.status}`);

    const data = await res.json();
    return data.response;
}

/* ---------------------------
   Puppeteer boot and ChatGPT monitor
--------------------------- */
(async () => {
    const browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null,
        userDataDir: "./chrome_profile",
        args: [
            "--no-sandbox",
            "--start-maximized",
        ],
    });

    page = await browser.newPage();
    await page.goto("https://chat.openai.com/", { waitUntil: "domcontentloaded" });
    await page.waitForSelector(CHAT_INPUT_SELECTOR, { timeout: 60000 });
    console.log("ChatGPT input detected");

    await sendJsonToChatGPT({
        user_input: "Ready. Use JSON only.",
    });

    let streamBuffer = "";
    const processedJsonTexts = new Set();

    await page.exposeFunction("onPartialOutput", async (text) => {
        streamBuffer = `${text}\n`;

        const extracted = extractCompleteJsonObjects(streamBuffer);
        streamBuffer = extracted.rest;

        for (const jsonText of extracted.objects) {
            if (processedJsonTexts.has(jsonText)) {
                continue;
            }
            processedJsonTexts.add(jsonText);

            let payload;
            try {
                payload = JSON.parse(jsonText);
                console.log("parsed JSON:", payload);
            } catch (err) {
                console.log("rejected JSON: invalid JSON", err.message, jsonText);
                continue;
            }

            const audit = auditLLMJson(payload);
            if (!audit.ok) {
                console.log("rejected JSON:", audit.reason, payload);
                continue;
            }

            console.log("accepted JSON:", audit.payload);
            await executeAuditedPayload(audit.payload);
        }
    });

    await page.evaluate(() => {
        const lastContents = new Map();

        function pollTexts() {
            const containers = document.querySelectorAll(".markdown.prose");
            containers.forEach((container) => {
                const currentText = container.innerText.trim();
                const lastText = lastContents.get(container) || "";

                if (currentText && currentText !== lastText) {
                    lastContents.set(container, currentText);
                    window.onPartialOutput(currentText);
                }
            });
        }

        console.log("ChatGPT output monitor started");
        setInterval(pollTexts, 300);
    });
})();
