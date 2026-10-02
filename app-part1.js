/**
 * Media English Study — bilingual English + 繁體中文 learner
 * Client-side only. No fake transcripts.
 */
(() => {
  "use strict";

  const STORAGE_KEY = "media-english-study-v1";
  const DEFAULT_PREFS = {
    speed: 1,
    practiceMode: "both", // both | hide-en | hide-zh
    vocab: [], // { word, gloss, context, addedAt }
  };

  // ── State ──
  let cues = []; // { id, start, end, en, zh }
  let currentCueIndex = -1;
  let loopMode = false; // loop current cue
  let abLoop = null; // { a, b } in seconds, or null
  let shadowMode = false;
  let shadowPhase = "idle"; // idle | playing | pause | replay
  let shadowTimer = null;
  let mediaObjectUrl = null;
  let prefs = loadPrefs();

  // ── DOM ──
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const mediaEl = $("#mediaEl");
  const mediaWrap = $("#mediaWrap");
  const mediaPlaceholder = $("#mediaPlaceholder");
  const cueList = $("#cueList");
  const timeDisplay = $("#timeDisplay");
  const speedSelect = $("#speedSelect");
  const practiceSelect = $("#practiceSelect");
  const toastEl = $("#toast");
  const vocabBadge = $("#vocabBadge");
  const progressBar = $("#transcribeProgress");
  const progressFill = $("#transcribeProgressFill");
  const progressLabel = $("#transcribeProgressLabel");
  const shadowBanner = $("#shadowBanner");
  const abIndicator = $("#abIndicator");
  const loopBtn = $("#btnLoop");

  // ── Prefs ──
  function loadPrefs() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return structuredClone(DEFAULT_PREFS);
      return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
    } catch {
      return structuredClone(DEFAULT_PREFS);
    }
  }

  function savePrefs() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch (e) {
      console.warn("localStorage save failed", e);
    }
  }

  // ── Toast ──
  let toastTimer;
  function toast(msg, ms = 2400) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), ms);
  }

  // ── Time helpers ──
  function parseTimestamp(str) {
    // Supports SRT (00:00:01,000) and VTT (00:00:01.000) and short (00:01.000 / 1.000)
    const s = str.trim().replace(",", ".");
    const parts = s.split(":");
    let h = 0, m = 0, sec = 0;
    if (parts.length === 3) {
      h = parseFloat(parts[0]) || 0;
      m = parseFloat(parts[1]) || 0;
      sec = parseFloat(parts[2]) || 0;
    } else if (parts.length === 2) {
      m = parseFloat(parts[0]) || 0;
      sec = parseFloat(parts[1]) || 0;
    } else {
      sec = parseFloat(parts[0]) || 0;
    }
    return h * 3600 + m * 60 + sec;
  }

  function formatTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.round((sec % 1) * 1000);
    const pad = (n, w = 2) => String(n).padStart(w, "0");
    if (h > 0) return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
    return `${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
  }

  function formatTimeSRT(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.round((sec % 1) * 1000);
    const pad = (n, w = 2) => String(n).padStart(w, "0");
    return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
  }

  function formatClock(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  // ── Detect CJK ──
  function isMostlyCJK(text) {
    const chars = [...text.replace(/\s/g, "")];
    if (!chars.length) return false;
    const cjk = chars.filter((c) => /[\u3000-\u9fff\uf900-\ufaff]/.test(c)).length;
    return cjk / chars.length >= 0.35;
  }

  function stripTags(html) {
    return html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/?[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .trim();
  }

  // ── Parse SRT / VTT ──
  function parseCaptions(text) {
    if (!text || !text.trim()) return [];
    let raw = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    // Strip WEBVTT header / NOTE / STYLE blocks lightly
    if (/^WEBVTT/i.test(raw.trim())) {
      raw = raw.replace(/^WEBVTT[^\n]*\n/, "");
      // Remove STYLE / REGION blocks (until blank line)
      raw = raw.replace(/^(STYLE|REGION|NOTE)[^\n]*\n(?:.*\n)*?(?=\n\n|\n(?=\d|\w))/gim, "\n");
    }

    const blocks = raw.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
    const result = [];

    for (const block of blocks) {
      const lines = block.split("\n").map((l) => l.trim()).filter((l) => l.length);
      if (!lines.length) continue;

      let timeLineIdx = lines.findIndex((l) => /-->/.test(l));
      if (timeLineIdx === -1) continue;

      const timeLine = lines[timeLineIdx];
      const m = timeLine.match(/([\d:.,]+)\s*-->\s*([\d:.,]+)/);
      if (!m) continue;

      const start = parseTimestamp(m[1]);
      const end = parseTimestamp(m[2]);
      if (!(end > start)) continue;

      const textLines = lines.slice(timeLineIdx + 1).map(stripTags).filter(Boolean);
      if (!textLines.length) continue;

      let en = "";
      let zh = "";

      if (textLines.length === 1) {
        if (isMostlyCJK(textLines[0])) zh = textLines[0];
        else en = textLines[0];
      } else if (textLines.length === 2) {
        const a = textLines[0];
        const b = textLines[1];
        if (isMostlyCJK(a) && !isMostlyCJK(b)) {
          zh = a;
          en = b;
        } else if (!isMostlyCJK(a) && isMostlyCJK(b)) {
          en = a;
          zh = b;
        } else if (isMostlyCJK(a) && isMostlyCJK(b)) {
          zh = textLines.join(" ");
        } else {
          // Both look English — keep first as EN, second as secondary EN→merge
          en = textLines.join(" ");
        }
      } else {
        // 3+ lines: classify each
        const enParts = [];
        const zhParts = [];
        for (const line of textLines) {
          if (isMostlyCJK(line)) zhParts.push(line);
          else enParts.push(line);
        }
        en = enParts.join(" ");
        zh = zhParts.join(" ");
      }

      result.push({
        id: result.length,
        start,
        end,
        en: en.trim(),
        zh: zh.trim(),
      });
    }

    return result;
  }

  function mergeCaptionTracks(enCues, zhCues) {
    // Prefer EN timing; attach ZH by overlap or index fallback
    if (!enCues.length && zhCues.length) {
      return zhCues.map((c, i) => ({ ...c, id: i, en: c.en || "", zh: c.zh || c.en || "" }));
    }
    if (enCues.length && !zhCues.length) {
      return enCues.map((c, i) => ({ ...c, id: i }));
    }
    if (!enCues.length && !zhCues.length) return [];

    const merged = enCues.map((ec, i) => {
      let best = null;
      let bestOverlap = 0;
      for (const zc of zhCues) {
        const overlap = Math.min(ec.end, zc.end) - Math.max(ec.start, zc.start);
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          best = zc;
        }
      }
      let zh = "";
      if (best && bestOverlap > 0.15) {
        zh = best.zh || (isMostlyCJK(best.en) ? best.en : best.zh) || "";
      } else if (zhCues[i]) {
        // index fallback if timings differ a lot
        const z = zhCues[i];
        zh = z.zh || (isMostlyCJK(z.en) ? z.en : "") || "";
      }
      return { id: i, start: ec.start, end: ec.end, en: ec.en || "", zh };
    });
    return merged;
  }

  // ── Render cues ──
  function tokenizeEnglish(text) {
    // Split keeping punctuation attached loosely; clickable word tokens
    const parts = [];
    const re = /([A-Za-z][A-Za-z'-]*|[^\sA-Za-z]+|\s+)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      parts.push(m[0]);
    }
    return parts.length ? parts : [text];
  }

  function renderCues() {
    cueList.classList.remove("practice-hide-en", "practice-hide-zh");
    if (prefs.practiceMode === "hide-en") cueList.classList.add("practice-hide-en");
    if (prefs.practiceMode === "hide-zh") cueList.classList.add("practice-hide-zh");

    if (!cues.length) {
      cueList.innerHTML = `<div class="empty-cues">尚未載入字幕。<br>請上傳、貼上網址／文字，或載入示範字幕。</div>`;
      return;
    }

    const frag = document.createDocumentFragment();
    cues.forEach((cue, i) => {
      const div = document.createElement("div");
      div.className = "cue" + (i === currentCueIndex ? " active" : "") + (loopMode && i === currentCueIndex ? " looping" : "");
      div.dataset.index = String(i);
      div.setAttribute("role", "button");
      div.tabIndex = 0;

      const time = document.createElement("div");
      time.className = "cue-time";
      time.textContent = `${formatClock(cue.start)} → ${formatClock(cue.end)}`;

      const en = document.createElement("div");
      en.className = "cue-en";
      if (cue.en) {
        tokenizeEnglish(cue.en).forEach((tok) => {
          if (/^[A-Za-z][A-Za-z'-]*$/.test(tok)) {
            const span = document.createElement("span");
            span.className = "word";
            span.textContent = tok;
            span.title = "點擊加入生詞本";
            span.addEventListener("click", (e) => {
              e.stopPropagation();
              addVocab(tok, cue.en);
            });
            en.appendChild(span);
          } else {
            en.appendChild(document.createTextNode(tok));
          }
        });
      } else {
        en.textContent = "（無英文）";
        en.style.opacity = "0.5";
      }

      const zh = document.createElement("div");
      zh.className = "cue-zh";
      zh.textContent = cue.zh || "";
      if (!cue.zh) {
        zh.dataset.placeholder = "1";
        zh.textContent = "點此輸入繁中翻譯…";
        zh.style.opacity = "0.45";
        zh.style.fontStyle = "italic";
      }
      zh.contentEditable = "true";
      zh.spellcheck = false;
      zh.addEventListener("click", (e) => e.stopPropagation());
      zh.addEventListener("focus", () => {
        if (zh.dataset.placeholder === "1") {
          zh.textContent = "";
          zh.style.opacity = "1";
          zh.style.fontStyle = "normal";
          delete zh.dataset.placeholder;
        }
      });
      zh.addEventListener("blur", () => {
        const val = zh.textContent.trim();
        cues[i].zh = val;
        if (!val) {
          zh.dataset.placeholder = "1";
          zh.textContent = "點此輸入繁中翻譯…";
          zh.style.opacity = "0.45";
          zh.style.fontStyle = "italic";
        }
      });

      div.appendChild(time);
      div.appendChild(en);
      div.appendChild(zh);

      div.addEventListener("click", () => seekToCue(i, true));
      div.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          seekToCue(i, true);
        }
      });

      frag.appendChild(div);
    });

    cueList.innerHTML = "";
    cueList.appendChild(frag);
    scrollActiveCueIntoView();
  }

  function scrollActiveCueIntoView() {
    const el = cueList.querySelector(".cue.active");
    if (el) {
      const listRect = cueList.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      if (elRect.top < listRect.top + 8 || elRect.bottom > listRect.bottom - 8) {
        el.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }
  }

  function setActiveCue(index, forceRender = false) {
    if (index === currentCueIndex && !forceRender) {
      // just update classes if DOM exists
      const items = $$(".cue", cueList);
      items.forEach((el, i) => {
        el.classList.toggle("active", i === index);
        el.classList.toggle("looping", loopMode && i === index);
      });
      return;
    }
    currentCueIndex = index;
    const items = $$(".cue", cueList);
    if (items.length !== cues.length) {
      renderCues();
      return;
    }
    items.forEach((el, i) => {
      el.classList.toggle("active", i === index);
      el.classList.toggle("looping", loopMode && i === index);
    });
    scrollActiveCueIntoView();
  }

  function findCueAt(time) {
    // Binary-ish linear scan is fine for typical subtitle counts
    for (let i = 0; i < cues.length; i++) {
      if (time >= cues[i].start && time < cues[i].end) return i;
    }
    // If between cues, find nearest previous
    for (let i = cues.length - 1; i >= 0; i--) {
      if (time >= cues[i].start) return i;
    }
    return -1;
  }

  function seekToCue(index, play = false) {
    if (index < 0 || index >= cues.length) return;
    const cue = cues[index];
    if (mediaEl.src) {
      mediaEl.currentTime = cue.start + 0.01;
    }
    setActiveCue(index);
    if (play && mediaEl.src) {
      mediaEl.play().catch(() => {});
    }
    if (shadowMode) startShadowForCue(index);
  }

  function prevCue() {
    if (!cues.length) return;
    const idx = currentCueIndex <= 0 ? 0 : currentCueIndex - 1;
    seekToCue(idx, true);
  }

  function nextCue() {
    if (!cues.length) return;
    const idx = currentCueIndex < 0 ? 0 : Math.min(cues.length - 1, currentCueIndex + 1);
    // if already on a cue and past start, go next
    let target = idx;
    if (currentCueIndex >= 0 && currentCueIndex < cues.length - 1) {
      target = currentCueIndex + 1;
    }
    seekToCue(target, true);
  }

  // ── Media ──
  function loadMediaFile(file) {
    if (!file) return;
    if (mediaObjectUrl) URL.revokeObjectURL(mediaObjectUrl);
    mediaObjectUrl = URL.createObjectURL(file);
    const isAudio = /^audio\//i.test(file.type) || /\.(mp3|m4a|wav|ogg|flac|aac)$/i.test(file.name);

    mediaEl.src = mediaObjectUrl;
    mediaEl.classList.add("visible");
    mediaPlaceholder.classList.add("hidden");
    mediaWrap.classList.toggle("is-audio", isAudio);
    mediaEl.load();
    toast(`已載入媒體：${file.name}`);
  }

  function onTimeUpdate() {
    const t = mediaEl.currentTime;
    const dur = mediaEl.duration;
    timeDisplay.textContent = `${formatClock(t)} / ${isFinite(dur) ? formatClock(dur) : "--:--"}`;

    if (abLoop && abLoop.a != null && abLoop.b != null) {
      if (t >= abLoop.b - 0.05) {
        mediaEl.currentTime = abLoop.a;
      }
    } else if (loopMode && currentCueIndex >= 0 && cues[currentCueIndex]) {
      const cue = cues[currentCueIndex];
      if (t >= cue.end - 0.05) {
        mediaEl.currentTime = cue.start + 0.01;
      }
    }

    if (shadowMode && shadowPhase === "playing" && currentCueIndex >= 0) {
      const cue = cues[currentCueIndex];
      if (t >= cue.end - 0.05) {
        mediaEl.pause();
        shadowPhase = "pause";
        shadowBanner.textContent = "跟讀中…（停頓後會重播）";
        shadowBanner.classList.add("visible");
        clearTimeout(shadowTimer);
        shadowTimer = setTimeout(() => {
          if (!shadowMode) return;
          shadowPhase = "replay";
          shadowBanner.textContent = "重播句子 — 請跟著說";
          mediaEl.currentTime = cue.start + 0.01;
          mediaEl.play().catch(() => {});
          // after second play, show text briefly then advance? keep looping cue until user exits
          shadowPhase = "playing";
        }, 1500);
        return;
      }
    }

    const idx = findCueAt(t);
    if (idx !== currentCueIndex) setActiveCue(idx);
  }

  // ── Vocab ──
  function addVocab(word, context) {
    const w = word.trim();
    if (!w) return;
    const existing = prefs.vocab.find((v) => v.word.toLowerCase() === w.toLowerCase());
    if (existing) {
      toast(`「${w}」已在生詞本`);
      openVocabDrawer();
      return;
    }
    prefs.vocab.unshift({
      word: w,
      gloss: "",
      context: context || "",
      addedAt: Date.now(),
    });
    savePrefs();
    updateVocabBadge();
    toast(`已加入生詞：${w}`);
  }

  function updateVocabBadge() {
    const n = prefs.vocab.length;
    vocabBadge.textContent = String(n);
    vocabBadge.style.display = n ? "inline-flex" : "none";
  }

  function renderVocabList() {
    const list = $("#vocabList");
    if (!prefs.vocab.length) {
      list.innerHTML = `<p class="hint">尚未加入生詞。在英文字幕中點擊單字即可加入。</p>`;
      return;
    }
    list.innerHTML = "";
    prefs.vocab.forEach((v, i) => {
      const item = document.createElement("div");
      item.className = "vocab-item";
      item.innerHTML = `
        <div class="vocab-word"></div>
        <input class="vocab-gloss" type="text" placeholder="輸入中文解釋／例句…" />
        <div class="vocab-meta">
          <span class="ctx"></span>
          <button type="button" class="btn btn-sm btn-ghost del">刪除</button>
        </div>`;
      item.querySelector(".vocab-word").textContent = v.word;
      const input = item.querySelector(".vocab-gloss");
      input.value = v.gloss || "";
      input.addEventListener("change", () => {
        prefs.vocab[i].gloss = input.value.trim();
        savePrefs();
      });
      const ctx = item.querySelector(".ctx");
      ctx.textContent = v.context ? `「${v.context.slice(0, 40)}${v.context.length > 40 ? "…" : ""}」` : "";
      item.querySelector(".del").addEventListener("click", () => {
        prefs.vocab.splice(i, 1);
        savePrefs();
        updateVocabBadge();
        renderVocabList();
        toast("已刪除生詞");
      });
      list.appendChild(item);
    });
  }

  // Flashcards
  let fcIndex = 0;
  let fcRevealed = false;

  function renderFlashcard() {
    const card = $("#flashcard");
    if (!prefs.vocab.length) {
      card.innerHTML = `<p class="hint">生詞本是空的，先點擊英文字幕中的單字吧。</p>`;
      return;
    }
    if (fcIndex >= prefs.vocab.length) fcIndex = 0;
    const v = prefs.vocab[fcIndex];
    card.innerHTML = "";
    const w = document.createElement("div");
    w.className = "fc-word";
    w.textContent = v.word;
    card.appendChild(w);
    if (fcRevealed) {
      const g = document.createElement("div");
      g.className = "fc-gloss";
      g.textContent = v.gloss || "（尚未填寫中文）";
      card.appendChild(g);
      if (v.context) {
        const c = document.createElement("div");
        c.className = "fc-hint";
        c.textContent = v.context;
        card.appendChild(c);
      }
    } else {
      const h = document.createElement("div");
      h.className = "fc-hint";
      h.textContent = "點擊卡片顯示中文";
      card.appendChild(h);
    }
  }

  // ── Export ──
  function exportSRT() {
    if (!cues.length) {
      toast("沒有字幕可匯出");
      return;
    }
    const lines = [];
    cues.forEach((c, i) => {
      lines.push(String(i + 1));
      lines.push(`${formatTimeSRT(c.start)} --> ${formatTimeSRT(c.end)}`);
      if (c.en) lines.push(c.en);
      if (c.zh) lines.push(c.zh);
      lines.push("");
    });
    downloadText(lines.join("\n"), "bilingual-transcript.srt", "application/x-subrip");
  }

  function exportTXT() {
    if (!cues.length) {
      toast("沒有字幕可匯出");
      return;
    }
    const lines = cues.map((c) => {
      const t = `[${formatClock(c.start)}]`;
      return `${t}\n${c.en || ""}\n${c.zh || ""}\n`;
    });
    downloadText(lines.join("\n"), "bilingual-transcript.txt", "text/plain");
  }

  function downloadText(text, filename, mime) {
    const blob = new Blob([text], { type: mime + ";charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast(`已下載 ${filename}`);
  }

  // ── Whisper (optional) ──
  let whisperPipeline = null;
  let whisperLoading = false;

  async function runWhisperTranscribe() {
    if (!mediaEl.src) {
      toast("請先上傳音訊或影片");
      return;
    }
    if (whisperLoading) {
      toast("轉錄進行中…");
      return;
    }

    const note = $("#whisperNote");
    note.textContent = "首次使用會下載 Whisper 模型（約數十 MB），請保持網路暢通。僅支援英文轉錄。";

    try {
      whisperLoading = true;
      progressBar.classList.add("visible");
      progressFill.style.width = "5%";
      progressLabel.textContent = "載入模型中…";

      if (!whisperPipeline) {
        const { pipeline, env } = await import("https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2");
        env.allowLocalModels = false;
        progressLabel.textContent = "下載／初始化 Whisper tiny 模型…";
        whisperPipeline = await pipeline(
          "automatic-speech-recognition",
          "Xenova/whisper-tiny.en",
          {
            progress_callback: (p) => {
              if (p && typeof p.progress === "number") {
                progressFill.style.width = `${Math.min(40, Math.round(p.progress * 0.4))}%`;
                progressLabel.textContent = `模型：${p.status || "loading"} ${Math.round(p.progress || 0)}%`;
              }
            },
          }
        );
      }

      progressFill.style.width = "45%";
      progressLabel.textContent = "擷取音訊中…";

      // Decode audio via Web Audio API from media element source
      const audioBuf = await fetchMediaAsAudioBuffer();
      progressFill.style.width = "60%";
      progressLabel.textContent = "轉錄中（可能需一分鐘）…";

      // Convert to mono float32 at 16kHz for Whisper
      const mono = downsampleTo16k(audioBuf);

      const result = await whisperPipeline(mono, {
        return_timestamps: true,
        chunk_length_s: 30,
        stride_length_s: 5,
      });

      progressFill.style.width = "90%";
      progressLabel.textContent = "整理字幕…";

      const newCues = [];
      const chunks = result.chunks || [];
      if (chunks.length) {
        chunks.forEach((ch, i) => {
          const ts = ch.timestamp || [0, 0];
          let start = typeof ts[0] === "number" ? ts[0] : 0;
          let end = typeof ts[1] === "number" ? ts[1] : start + 2;
          if (!(end > start)) end = start + 1.5;
          const text = (ch.text || "").trim();
          if (!text) return;
          newCues.push({ id: i, start, end, en: text, zh: "" });
        });
      } else if (result.text) {
        // fallback single cue
        newCues.push({
          id: 0,
          start: 0,
          end: mediaEl.duration || 5,
          en: result.text.trim(),
          zh: "",
        });
      }

      if (!newCues.length) {
        toast("轉錄未產生字幕，請改用 SRT 上傳");
      } else {
        // Keep existing ZH if timings overlap
        const oldZh = cues.filter((c) => c.zh);
        cues = mergeCaptionTracks(newCues, oldZh.map((c) => ({ ...c, en: "" })));
        currentCueIndex = -1;
        renderCues();
        toast(`轉錄完成：${cues.length} 句（僅英文，可逐行補繁中）`);
      }

      progressFill.style.width = "100%";
      progressLabel.textContent = "完成";
    } catch (err) {
      console.error(err);
      toast("自動轉錄失敗（模型或瀏覽器限制）。請改用 SRT／VTT 上傳。", 4000);
      progressLabel.textContent = "失敗：" + (err.message || String(err));
    } finally {
      whisperLoading = false;
      setTimeout(() => {
        progressBar.classList.remove("visible");
        progressFill.style.width = "0%";
      }, 2500);
    }
  }

  async function fetchMediaAsAudioBuffer() {
    const res = await fetch(mediaEl.src);
    const buf = await res.arrayBuffer();
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    try {
      return await ctx.decodeAudioData(buf.slice(0));
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  function downsampleTo16k(audioBuffer) {
    const targetRate = 16000;
    const numChannels = audioBuffer.numberOfChannels;
    const length = audioBuffer.length;
    // mixdown
    const mixed = new Float32Array(length);
    for (let c = 0; c < numChannels; c++) {
      const data = audioBuffer.getChannelData(c);
      for (let i = 0; i < length; i++) mixed[i] += data[i] / numChannels;
    }
    if (audioBuffer.sampleRate === targetRate) return mixed;
    const ratio = audioBuffer.sampleRate / targetRate;
    const newLen = Math.floor(length / ratio);
    const out = new Float32Array(newLen);
    for (let i = 0; i < newLen; i++) {
      const idx = i * ratio;
      const i0 = Math.floor(idx);
      const i1 = Math.min(i0 + 1, length - 1);
      const frac = idx - i0;
      out[i] = mixed[i0] * (1 - frac) + mixed[i1] * frac;
    }
    return out;
  }
