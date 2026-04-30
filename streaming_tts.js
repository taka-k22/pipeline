import { spawn } from "child_process";

const res = await fetch(
  "https://api.elevenlabs.io/v1/text-to-speech/JgWCVquTJEvtfo5gWQkx/stream?output_format=mp3_44100_128",
  {
    method: "POST",
    headers: {
      "xi-api-key": "sk_6692c4d1ed233386d711a4bee9368078ce75814b5b817fb7",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      text: "水中の世界は陸の上ほど明るくはありませんが、あそこに留まる度、心がゆっくりと落ち着いていくような気がします。遠くには魚の群れが泳ぎ、そばにはクラゲが舞い、自分でも気づかないうちに、すべての心配事を置き去りにできるのです。機会があれば、あなたもそこに連れていってあげましょうか？",
      model_id: "eleven_v3"
    })
  }
);

if (!res.ok || !res.body) {
  console.log(await res.text());
  throw new Error("TTS failed");
}

// ffplay起動
const ffplay = spawn("ffplay", [
  "-nodisp",
  "-autoexit",
  "-loglevel", "quiet",
  "-"
]);

// WebStream → Node stream に変換して pipe
const reader = res.body.getReader();

async function pump() {
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    ffplay.stdin.write(Buffer.from(value));
  }
  ffplay.stdin.end();
}

pump();