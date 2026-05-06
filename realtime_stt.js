// server.js
import express from "express";
import cors from "cors";   // ←追加
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import "dotenv/config";

const app = express();
app.use(cors()); // ←これが本体

if (!process.env.ELEVENLABS_API_KEY) {
  throw new Error("ELEVENLABS_API_KEY is required. Set it in .env.");
}

const elevenlabs = new ElevenLabsClient({
  apiKey: process.env.ELEVENLABS_API_KEY,
});

app.get("/scribe-token", async (req, res) => {
  const token = await elevenlabs.tokens.singleUse.create("realtime_scribe");
  res.json(token);
});

app.listen(3000, () => {
  console.log("server running on http://localhost:3000");
});
