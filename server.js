// write-server.js
const fs = require('fs');
const express = require('express');
const { Client } = require('ssh2'); // ← 追加
const app = express();
const PORT = 3000;

app.use(express.text()); // プレーンテキスト受け取る

app.post('/log', (req, res) => {
  const logMessage = req.body;
  const timestamp = new Date().toISOString();

  // ローカルにログ保存
  fs.appendFile('tampermonkey_log.txt', `${logMessage}\n`, (err) => {
    if (err) {
      console.error('Error: Logging Failed.:', err);
    } else {
      console.log('Logging Succeeded!:', logMessage);
    }
  });

  // SSH経由でラズパイに送って実行
  const conn = new Client();
  conn.on('ready', () => {
    console.log('SSH接続成功！');
    conn.exec(logMessage, (err, stream) => {
      if (err) {
        console.error('SSH Exec Error:', err);
        res.status(500).send('SSH Error');
        conn.end();
        return;
      }
      stream.on('close', (code, signal) => {
        console.log(`コマンド終了: code=${code}, signal=${signal}`);
        conn.end();
        res.send('OK');
      }).on('data', (data) => {
        console.log('出力: ' + data.toString());
      }).stderr.on('data', (data) => {
        console.error('エラー: ' + data.toString());
      });
    });
  }).connect({
    host: 'kokomi.local',  // ラズパイのIP
    port: 22,
    username: 'takan',
    password: 'kokomi'  // パスワード（設定してあるもの）
  });
});

app.listen(PORT, () => {
  console.log(`Server running... http://localhost:${PORT}`);
});
