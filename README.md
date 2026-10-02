# 影音英語學習（Media English Study）

用電影／音訊學英文的網頁應用：雙語字幕（English + 繁體中文）、句子循環、跟讀、生詞本與閃卡。支援上傳 SRT／VTT、貼字幕網址，以及**貼 YouTube 連結拉取英＋繁中字幕**（需本機 Python 後端 + yt-dlp）。

## 如何開啟（含 YouTube 字幕）

建議用內建 Flask 伺服器（同時提供靜態檔與 `/api/youtube-captions`）：

```bash
cd /workspace/media-english-study
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python server.py
# 預設 http://0.0.0.0:5173
```

瀏覽器開啟：`http://localhost:5173`

僅靜態預覽（**無 YouTube API**）仍可用：

```bash
python3 -m http.server 5173 --directory . --bind 0.0.0.0
```

## 使用步驟

1. **上傳媒體**：拖放或選擇 mp4／webm／mp3／m4a／wav 等。
2. **載入字幕**（可併用）：
   - **貼 YouTube 連結**（youtube.com／youtu.be）→ 呼叫本機 `/api/youtube-captions`，用 yt-dlp 拉英＋繁中（zh-Hant／zh-TW／zh-HK／zh，含自動字幕）
   - 上傳英文、繁中或「雙語合一」`.srt`／`.vtt`
   - 貼上直接字幕檔網址（`.srt`／`.vtt`／`.txt`）或同源相對路徑
   - 貼上 SRT／VTT 文字
   - （可選）瀏覽器 Whisper 自動轉錄英文
3. **也可先按「載入示範字幕」** 試介面。
4. 點字幕句子跳轉；點英文字加入**生詞本**。
5. 調整速度、練習模式、循環句、A-B、跟讀。
6. **匯出**雙語 SRT 或純文字。

## YouTube 字幕 API

| 項目 | 說明 |
|------|------|
| 端點 | `GET`／`POST` `/api/youtube-captions?url=<YouTube URL>` |
| 回傳 | JSON：`{ ok, videoId, title, langs, cues:[{start,end,en,zh}], warnings, … }` |
| 前端 | 網址欄偵測到 YouTube 時自動改打此 API（不再 raw fetch） |

範例：

```bash
curl -sG 'http://127.0.0.1:5173/api/youtube-captions' \
  --data-urlencode 'url=https://www.youtube.com/watch?v=jNQXAC9IVRw' | head -c 500
```

## 主要功能

| 功能 | 說明 |
|------|------|
| 雙語字幕 | 英＋繁並排，播放同步高亮 |
| YouTube 連結 | 後端 yt-dlp 拉字幕（需 `server.py`） |
| 點句跳轉／速度／循環／跟讀 | 同前 |
| 生詞本＋閃卡 | localStorage |
| 匯出 | 雙語 SRT／TXT |
| 網址／上傳 SRT／VTT | 維持不變 |

## 快捷鍵

- `Space` 播放／暫停  
- `←`／`→` 上一句／下一句  
- `L` 循環目前句子 · `S` 跟讀 · `A`／`B` A-B 循環  

## 檔案說明

- `index.html` / `styles.css` / `app.js` — 前端  
- `server.py` — Flask：靜態檔 + YouTube 字幕 API  
- `requirements.txt` — `flask`, `yt-dlp`  
- `sample-bilingual.srt` — 示範雙語字幕  

## 限制與注意

- **YouTube**：純瀏覽器因 CORS 無法可靠抓字幕；必須跑 `server.py`。靜態託管（Shiply／Harvis／GitHub Pages）**沒有此 API**，貼 YouTube 會提示改用本機後端或上傳 SRT。
- **無字幕／僅自動字幕語言不全**：若影片無英／中官方或自動字幕，API 回傳清楚錯誤；僅有英文時會載入英文並提示可補繁中。
- **年齡限制／私人／地區封鎖／機器人驗證（429）**：yt-dlp 可能失敗；本服務**預設不使用登入 Cookie**。請稍後再試或改上傳字幕檔。
- **自動轉錄**為可選 Whisper tiny（僅英文）；請以 SRT／YouTube／上傳為主力。
- 生詞等存 `localStorage`；影音只在本機解碼。

## 技術

前端：HTML5 media、SRT／VTT 解析。後端：Flask + yt-dlp（優先 android player client）。
