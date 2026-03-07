import { spawn } from "child_process";

const res = await fetch(
  "https://api.elevenlabs.io/v1/text-to-speech/JgWCVquTJEvtfo5gWQkx?output_format=mp3_44100_128",
  {
    method: "POST",
    headers: {
      "xi-api-key": "YOUR_API_KEY_HERE",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      text: "こんにちは、これはテストメッセージです。",
      model_id: "eleven_v3"
    })
  }
);

if (!res.ok) {
  console.log(await res.text());
  throw new Error("TTS failed");
}

const buffer = Buffer.from(await res.arrayBuffer());

const ffplay = spawn("ffplay", [
  "-nodisp",
  "-autoexit",
  "-"
]);

ffplay.stdin.write(buffer);
ffplay.stdin.end();