// server.js
import express from "express";
import cors from "cors";   // ←追加
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import "dotenv/config";

const app = express();
app.use(cors()); // ←これが本体

const elevenlabs = new ElevenLabsClient({
  apiKey: "sk_6692c4d1ed233386d711a4bee9368078ce75814b5b817fb7",
});

app.get("/scribe-token", async (req, res) => {
  const token = await elevenlabs.tokens.singleUse.create("realtime_scribe");
  res.json(token);
});

app.listen(3000, () => {
  console.log("server running on http://localhost:3000");
});