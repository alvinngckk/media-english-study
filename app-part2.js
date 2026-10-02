
  // ── Shadowing ──
  function toggleShadow() {
    shadowMode = !shadowMode;
    $("#btnShadow").classList.toggle("active", shadowMode);
    clearTimeout(shadowTimer);
    if (shadowMode) {
      shadowBanner.classList.add("visible");
      shadowBanner.textContent = "跟讀模式：播放一句 → 停頓 → 重播。按 S 或按鈕結束。";
      if (currentCueIndex < 0 && cues.length) seekToCue(0, true);
      else if (currentCueIndex >= 0) startShadowForCue(currentCueIndex);
      toast("已開啟跟讀模式");
    } else {
      shadowPhase = "idle";
      shadowBanner.classList.remove("visible");
      toast("已關閉跟讀模式");
    }
  }

  function startShadowForCue(index) {
    clearTimeout(shadowTimer);
    shadowPhase = "playing";
    shadowBanner.textContent = "播放中 — 仔細聽";
    shadowBanner.classList.add("visible");
    if (mediaEl.src) {
      mediaEl.currentTime = cues[index].start + 0.01;
      mediaEl.play().catch(() => {});
    }
  }

  // ── Loop / A-B ──
  function toggleLoop() {
    loopMode = !loopMode;
    if (loopMode) abLoop = null;
    updateLoopUI();
    toast(loopMode ? "循環目前句子" : "已關閉句子循環");
    setActiveCue(currentCueIndex, true);
  }

  function setABPoint(which) {
    const t = mediaEl.currentTime || 0;
    if (!abLoop) abLoop = { a: null, b: null };
    if (which === "a") {
      abLoop.a = t;
      toast(`A 點：${formatClock(t)}`);
    } else {
      abLoop.b = t;
      toast(`B 點：${formatClock(t)}`);
    }
    if (abLoop.a != null && abLoop.b != null && abLoop.b <= abLoop.a) {
      // swap
      const tmp = abLoop.a;
      abLoop.a = abLoop.b;
      abLoop.b = tmp;
    }
    if (abLoop.a != null && abLoop.b != null) {
      loopMode = false;
    }
    updateLoopUI();
  }

  function clearAB() {
    abLoop = null;
    updateLoopUI();
    toast("已清除 A-B 循環");
  }

  function updateLoopUI() {
    loopBtn.classList.toggle("active", loopMode);
    if (abLoop && abLoop.a != null && abLoop.b != null) {
      abIndicator.textContent = `A-B ${formatClock(abLoop.a)}–${formatClock(abLoop.b)}`;
      abIndicator.classList.remove("hidden");
    } else if (loopMode) {
      abIndicator.textContent = "循環句子";
      abIndicator.classList.remove("hidden");
    } else {
      abIndicator.classList.add("hidden");
    }
  }

  // ── Drawers ──
  function openDrawer(id) {
    $("#drawerBackdrop").classList.add("open");
    $(id).classList.add("open");
  }
  function closeDrawers() {
    $("#drawerBackdrop").classList.remove("open");
    $$(".drawer").forEach((d) => d.classList.remove("open"));
  }
  function openVocabDrawer() {
    renderVocabList();
    $("#flashcardPanel").classList.add("hidden");
    $("#vocabListPanel").classList.remove("hidden");
    openDrawer("#vocabDrawer");
  }


  // ── Load captions from URL ──
  const CORS_PROXY_PREFIX = "https://corsproxy.io/?";

  function setUrlStatus(msg, kind) {
    const el = $("#urlLoadStatus");
    if (!el) return;
    el.textContent = msg || "";
    el.classList.remove("is-error", "is-loading", "is-ok");
    if (kind) el.classList.add(`is-${kind}`);
  }

  function isYouTubeUrl(raw) {
    try {
      const u = new URL(raw, location.href);
      const host = u.hostname.replace(/^www\./, "").toLowerCase();
      if (/(^|\.)youtube\.com$/.test(host) || host === "youtu.be" || host === "m.youtube.com" || host === "music.youtube.com") {
        if (/\.(srt|vtt|txt)(\?|#|$)/i.test(u.pathname + u.search)) return false;
        return true;
      }
    } catch (_) { /* ignore */ }
    return false;
  }

  function isYouTubeOrVideoPageUrl(raw) {
    if (isYouTubeUrl(raw)) return true;
    try {
      const u = new URL(raw, location.href);
      const host = u.hostname.replace(/^www\./, "").toLowerCase();
      if (/(^|\.)vimeo\.com$/.test(host) && !/\.(srt|vtt|txt)(\?|#|$)/i.test(u.pathname)) return true;
    } catch (_) { /* ignore */ }
    return false;
  }

  async function loadYouTubeCaptions(rawUrl) {
    const api = new URL("/api/youtube-captions", location.origin);
    api.searchParams.set("url", rawUrl);
    let res;
    try {
      res = await fetch(api.href, { method: "GET", credentials: "omit", cache: "no-store" });
    } catch (netErr) {
      const err = new Error("NETWORK");
      err.cause = netErr;
      throw err;
    }
    const ctype = (res.headers.get("content-type") || "").toLowerCase();
    let data = null;
    if (ctype.includes("application/json") || ctype.includes("+json")) {
      try { data = await res.json(); } catch (_) { data = null; }
    } else {
      // Static hosts often return index.html (200) for unknown /api paths
      try { await res.text(); } catch (_) { /* ignore */ }
      const err = new Error("NO_BACKEND");
      err.httpStatus = res.status === 200 ? 404 : res.status;
      err.api = true;
      throw err;
    }
    if (!res.ok || !data || !data.ok) {
      const err = new Error((data && data.error) || `HTTP ${res.status}`);
      err.httpStatus = res.status;
      err.api = true;
      throw err;
    }
    return data;
  }

  function looksLikeSubtitleUrl(raw) {
    try {
      const u = new URL(raw, location.href);
      return /\.(srt|vtt|txt)(\?|#|$)/i.test(u.pathname) ||
        /\.(srt|vtt|txt)(\?|#|$)/i.test(raw);
    } catch (_) {
      return /\.(srt|vtt|txt)(\?|#|$)/i.test(raw);
    }
  }

  function isLikelyCorsFailure(err, res) {
    if (res && res.type === "opaque") return true;
    const msg = String(err && err.message || err || "").toLowerCase();
    if (/failed to fetch|networkerror|cors|blocked|access-control/i.test(msg)) return true;
    // TypeError from fetch often means CORS/network in browsers
    if (err && err.name === "TypeError") return true;
    return false;
  }

  async function fetchTextWithCorsFallback(url) {
    // 1) Direct fetch
    try {
      const res = await fetch(url, { mode: "cors", credentials: "omit", cache: "no-store" });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.httpStatus = res.status;
        err.res = res;
        throw err;
      }
      const text = await res.text();
      return { text, via: "direct" };
    } catch (directErr) {
      // Relative / same-origin failures: don't proxy
      let absolute;
      try { absolute = new URL(url, location.href); } catch (_) {
        throw directErr;
      }
      const sameOrigin = absolute.origin === location.origin;
      if (sameOrigin || absolute.protocol === "file:") {
        throw directErr;
      }
      if (!isLikelyCorsFailure(directErr, directErr.res) && directErr.httpStatus) {
        // Real HTTP error (404 etc.) — don't pretend CORS
        throw directErr;
      }
      // 2) Last-resort public CORS proxy
      const proxied = CORS_PROXY_PREFIX + encodeURIComponent(absolute.href);
      try {
        const res2 = await fetch(proxied, { mode: "cors", credentials: "omit", cache: "no-store" });
        if (!res2.ok) {
          const err = new Error(`Proxy HTTP ${res2.status}`);
          err.httpStatus = res2.status;
          throw err;
        }
        const text = await res2.text();
        return { text, via: "proxy" };
      } catch (proxyErr) {
        const wrap = new Error("CORS_OR_NETWORK");
        wrap.cause = directErr;
        wrap.proxyError = proxyErr;
        throw wrap;
      }
    }
  }

  async function loadCaptionFromUrl() {
    const input = $("#captionUrlInput");
    const btn = $("#btnLoadUrl");
    const langSel = $("#captionUrlLang");
    const raw = (input?.value || "").trim();
    if (!raw) {
      setUrlStatus("請先貼上字幕網址。", "error");
      toast("請先貼上字幕網址");
      return;
    }

    let resolved;
    try {
      resolved = new URL(raw, location.href).href;
    } catch (_) {
      setUrlStatus("網址格式無效，請檢查後重試。", "error");
      toast("網址格式無效");
      return;
    }

    // YouTube → local backend (yt-dlp); pure browser cannot fetch captions (CORS)
    if (isYouTubeUrl(raw)) {
      setUrlStatus("正在從 YouTube 拉取英／繁中字幕（可能需數秒）…", "loading");
      btn.disabled = true;
      input.disabled = true;
      try {
        const data = await loadYouTubeCaptions(resolved);
        const parsed = (data.cues || []).map((c, i) => ({
          id: i,
          start: Number(c.start) || 0,
          end: Number(c.end) || 0,
          en: (c.en || "").trim(),
          zh: (c.zh || "").trim(),
        })).filter((c) => c.end > c.start && (c.en || c.zh));
        if (!parsed.length) {
          const msg = "此影片沒有可用字幕（無官方／自動字幕）。請改上傳 SRT／VTT，或換有字幕的影片。";
          setUrlStatus(msg, "error");
          toast("無可用字幕");
          return;
        }
        await applyParsedCaptions(parsed, "auto");
        const langs = data.langs || {};
        const warn = (data.warnings && data.warnings[0]) || "";
        const titleBit = data.title ? `「${String(data.title).slice(0, 40)}」` : "";
        const langBit = [langs.en && `英:${langs.en}`, langs.zh && `中:${langs.zh}`].filter(Boolean).join("／");
        setUrlStatus(
          `已從 YouTube 載入 ${cues.length} 句${titleBit ? " " + titleBit : ""}${langBit ? "（" + langBit + "）" : ""}${warn ? " — " + warn : ""}`,
          warn ? "ok" : "ok"
        );
        toast(warn ? `已載入 ${cues.length} 句（${warn}）` : `已從 YouTube 載入 ${cues.length} 句`);
      } catch (e) {
        let msg;
        if (e && (e.message === "NETWORK" || e.message === "NO_BACKEND")) {
          msg = "此環境沒有 YouTube 字幕後端（需執行 server.py 提供 /api/youtube-captions）。靜態託管無法拉取；請本機啟動後端，或改上傳 SRT／VTT。";
        } else if (e && e.httpStatus === 404) {
          msg = "此站未提供 YouTube 字幕 API（靜態託管無後端）。請在本機執行 server.py，或改上傳 SRT／VTT。";
        } else {
          msg = (e && e.message) || "YouTube 字幕擷取失敗。若無官方／自動字幕、年齡限制或限流，請改上傳 SRT／VTT。";
        }
        setUrlStatus(msg, "error");
        toast("YouTube 字幕載入失敗");
        console.warn(e);
      } finally {
        btn.disabled = false;
        input.disabled = false;
      }
      return;
    }

    if (isYouTubeOrVideoPageUrl(raw)) {
      const msg = "無法在瀏覽器直接擷取此影片頁字幕。請改貼 .srt／.vtt 字幕檔網址，或下載後上傳。（YouTube 請貼 youtube.com／youtu.be 連結）";
      setUrlStatus(msg, "error");
      toast("請改用字幕檔網址或上傳");
      return;
    }

    if (!looksLikeSubtitleUrl(raw) && !raw.startsWith(".") && !raw.startsWith("/")) {
      // Allow anyway but warn — some CDNs omit extensions
      setUrlStatus("此網址不像 .srt／.vtt／.txt；仍會嘗試載入…", "loading");
    } else {
      setUrlStatus("載入中…", "loading");
    }

    btn.disabled = true;
    input.disabled = true;
    try {
      const { text, via } = await fetchTextWithCorsFallback(resolved);
      if (!text || !String(text).trim()) {
        setUrlStatus("取得的內容是空的，請確認網址。", "error");
        toast("字幕內容為空");
        return;
      }
      const lang = langSel?.value || "auto";
      // Reuse file-load path logic via temporary File-like handling
      const parsed = parseCaptions(text);
      if (!parsed.length) {
        setUrlStatus("無法解析為 SRT／VTT。請確認檔案格式，或改下載後上傳。", "error");
        toast("無法解析字幕");
        return;
      }
      // Apply using same rules as loadCaptionFile by synthesizing
      await applyParsedCaptions(parsed, lang === "bilingual" ? "auto" : lang);
      const note = via === "proxy"
        ? "（經公開 CORS 代理載入；若內容異常請改下載後上傳）"
        : "";
      setUrlStatus(`已載入 ${cues.length} 句${note}`, "ok");
      if (via === "proxy") {
        toast(`已載入字幕：${cues.length} 句（經 CORS 代理）`);
      }
    } catch (e) {
      if (e && e.message === "CORS_OR_NETWORK") {
        const msg = "載入失敗：瀏覽器可能因 CORS 跨域政策阻擋。請改下載字幕檔後上傳，或使用允許跨域的網址／同源相對路徑。";
        setUrlStatus(msg, "error");
        toast("CORS 阻擋，請下載後上傳");
      } else if (e && e.httpStatus) {
        setUrlStatus(`載入失敗：伺服器回應 HTTP ${e.httpStatus}。`, "error");
        toast(`載入失敗（HTTP ${e.httpStatus}）`);
      } else {
        setUrlStatus("載入失敗，請檢查網址或改下載後上傳。", "error");
        toast("載入字幕失敗");
        console.warn(e);
      }
    } finally {
      btn.disabled = false;
      input.disabled = false;
    }
  }

  async function applyParsedCaptions(parsed, lang) {
    const hasBoth = parsed.some((c) => c.en && c.zh);
    const mostlyZh = parsed.filter((c) => c.zh && !c.en).length > parsed.length * 0.5;

    if (lang === "auto" || lang === "bilingual") {
      if (hasBoth) {
        cues = parsed.map((c, i) => ({ ...c, id: i }));
      } else if (mostlyZh) {
        cues = mergeCaptionTracks(
          cues.filter((c) => c.en).length ? cues : [],
          parsed
        );
        if (!cues.length) {
          cues = parsed.map((c, i) => ({
            id: i,
            start: c.start,
            end: c.end,
            en: "",
            zh: c.zh || c.en,
          }));
        }
      } else {
        cues = mergeCaptionTracks(parsed, cues.filter((c) => c.zh));
        if (!cues.length) cues = parsed.map((c, i) => ({ ...c, id: i }));
      }
    } else if (lang === "en") {
      cues = mergeCaptionTracks(parsed, cues);
    } else if (lang === "zh") {
      const zhTrack = parsed.map((c) => ({
        ...c,
        zh: c.zh || c.en,
        en: "",
      }));
      cues = mergeCaptionTracks(cues.length ? cues : parsed.map((c) => ({ ...c, zh: "" })), zhTrack);
    }

    currentCueIndex = -1;
    renderCues();
    toast(`已載入字幕：${cues.length} 句`);
  }


  // ── Load caption helpers ──
  async function readFileText(file) {
    return await file.text();
  }

  async function loadCaptionFile(file, lang) {
    const text = await readFileText(file);
    const parsed = parseCaptions(text);
    if (!parsed.length) {
      toast("無法解析字幕檔，請確認為 SRT 或 VTT");
      return;
    }

    // Detect if bilingual already
    const hasBoth = parsed.some((c) => c.en && c.zh);
    const mostlyZh = parsed.filter((c) => c.zh && !c.en).length > parsed.length * 0.5;
    const mostlyEn = parsed.filter((c) => c.en && !c.zh).length > parsed.length * 0.5;

    if (lang === "auto" || lang === "bilingual") {
      if (hasBoth) {
        cues = parsed.map((c, i) => ({ ...c, id: i }));
      } else if (mostlyZh) {
        cues = mergeCaptionTracks(
          cues.filter((c) => c.en).length ? cues : [],
          parsed
        );
        if (!cues.length) {
          cues = parsed.map((c, i) => ({
            id: i,
            start: c.start,
            end: c.end,
            en: "",
            zh: c.zh || c.en,
          }));
        }
      } else {
        cues = mergeCaptionTracks(parsed, cues.filter((c) => c.zh));
        if (!cues.length) cues = parsed.map((c, i) => ({ ...c, id: i }));
      }
    } else if (lang === "en") {
      cues = mergeCaptionTracks(parsed, cues);
    } else if (lang === "zh") {
      const zhTrack = parsed.map((c) => ({
        ...c,
        zh: c.zh || c.en,
        en: "",
      }));
      cues = mergeCaptionTracks(cues.length ? cues : parsed.map((c) => ({ ...c, zh: "" })), zhTrack);
    }

    currentCueIndex = -1;
    renderCues();
    toast(`已載入字幕：${cues.length} 句`);
  }

  function loadCaptionText(text, lang) {
    const parsed = parseCaptions(text);
    if (!parsed.length) {
      toast("無法解析貼上的字幕");
      return;
    }
    if (lang === "en") {
      cues = mergeCaptionTracks(parsed, cues);
    } else if (lang === "zh") {
      const zhTrack = parsed.map((c) => ({ ...c, zh: c.zh || c.en, en: "" }));
      cues = mergeCaptionTracks(cues.length ? cues : parsed.map((c) => ({ ...c, zh: "" })), zhTrack);
    } else {
      cues = parsed.map((c, i) => ({ ...c, id: i }));
    }
    currentCueIndex = -1;
    renderCues();
    toast(`已載入字幕：${cues.length} 句`);
  }

  async function loadSample() {
    try {
      const res = await fetch("./sample-bilingual.srt");
      const text = await res.text();
      cues = parseCaptions(text).map((c, i) => ({ ...c, id: i }));
      currentCueIndex = -1;
      renderCues();
      toast("已載入示範雙語字幕（非真實電影內容）");
    } catch (e) {
      toast("無法載入示範字幕");
    }
  }

  // ── Keyboard ──
  function onKeydown(e) {
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || e.target.isContentEditable) return;

    switch (e.key) {
      case " ":
        e.preventDefault();
        if (!mediaEl.src) return;
        if (mediaEl.paused) mediaEl.play().catch(() => {});
        else mediaEl.pause();
        break;
      case "ArrowLeft":
        e.preventDefault();
        prevCue();
        break;
      case "ArrowRight":
        e.preventDefault();
        nextCue();
        break;
      case "l":
      case "L":
        e.preventDefault();
        toggleLoop();
        break;
      case "s":
      case "S":
        if (!e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          toggleShadow();
        }
        break;
      case "a":
      case "A":
        if (!e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          setABPoint("a");
        }
        break;
      case "b":
      case "B":
        if (!e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          setABPoint("b");
        }
        break;
      default:
        break;
    }
  }

  // ── Drag and drop ──
  function setupDropZone(el, onFiles) {
    ["dragenter", "dragover"].forEach((ev) => {
      el.addEventListener(ev, (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.classList.add("dragover");
      });
    });
    ["dragleave", "drop"].forEach((ev) => {
      el.addEventListener(ev, (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.classList.remove("dragover");
      });
    });
    el.addEventListener("drop", (e) => {
      const files = [...(e.dataTransfer?.files || [])];
      if (files.length) onFiles(files);
    });
  }

  // ── Init UI bindings ──
  function init() {
    // Apply prefs
    speedSelect.value = String(prefs.speed);
    mediaEl.playbackRate = prefs.speed;
    practiceSelect.value = prefs.practiceMode;
    updateVocabBadge();

    mediaEl.addEventListener("timeupdate", onTimeUpdate);
    mediaEl.addEventListener("loadedmetadata", onTimeUpdate);
    mediaEl.addEventListener("play", () => $("#btnPlay").textContent = "⏸");
    mediaEl.addEventListener("pause", () => $("#btnPlay").textContent = "▶");

    $("#btnPlay").addEventListener("click", () => {
      if (!mediaEl.src) {
        toast("請先上傳媒體檔案");
        return;
      }
      if (mediaEl.paused) mediaEl.play().catch(() => {});
      else mediaEl.pause();
    });

    $("#btnPrev").addEventListener("click", prevCue);
    $("#btnNext").addEventListener("click", nextCue);
    loopBtn.addEventListener("click", toggleLoop);
    $("#btnShadow").addEventListener("click", toggleShadow);
    $("#btnA").addEventListener("click", () => setABPoint("a"));
    $("#btnB").addEventListener("click", () => setABPoint("b"));
    $("#btnClearAB").addEventListener("click", clearAB);

    speedSelect.addEventListener("change", () => {
      prefs.speed = parseFloat(speedSelect.value) || 1;
      mediaEl.playbackRate = prefs.speed;
      savePrefs();
    });

    practiceSelect.addEventListener("change", () => {
      prefs.practiceMode = practiceSelect.value;
      savePrefs();
      renderCues();
    });

    // Media upload
    const mediaInput = $("#mediaInput");
    $("#mediaDrop").addEventListener("click", () => mediaInput.click());
    mediaInput.addEventListener("change", () => {
      if (mediaInput.files?.[0]) loadMediaFile(mediaInput.files[0]);
    });
    setupDropZone($("#mediaDrop"), (files) => {
      const f = files.find((x) => /^video\/|^audio\//.test(x.type) || /\.(mp4|webm|mkv|mp3|m4a|wav|ogg|flac|aac|mov)$/i.test(x.name));
      if (f) loadMediaFile(f);
      else toast("請放入影音檔案");
    });

    // Caption uploads
    $("#capEnInput").addEventListener("change", async () => {
      const f = $("#capEnInput").files?.[0];
      if (f) await loadCaptionFile(f, "en");
      $("#capEnInput").value = "";
    });
    $("#capZhInput").addEventListener("change", async () => {
      const f = $("#capZhInput").files?.[0];
      if (f) await loadCaptionFile(f, "zh");
      $("#capZhInput").value = "";
    });
    $("#capBiInput").addEventListener("change", async () => {
      const f = $("#capBiInput").files?.[0];
      if (f) await loadCaptionFile(f, "bilingual");
      $("#capBiInput").value = "";
    });

    setupDropZone($("#captionDrop"), async (files) => {
      const f = files.find((x) => /\.(srt|vtt|txt)$/i.test(x.name));
      if (f) await loadCaptionFile(f, "auto");
      else toast("請放入 .srt 或 .vtt");
    });

    $("#btnLoadUrl").addEventListener("click", () => { loadCaptionFromUrl(); });
    $("#captionUrlInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        loadCaptionFromUrl();
      }
    });

    $("#btnPasteEn").addEventListener("click", () => {
      loadCaptionText($("#pasteArea").value, "en");
    });
    $("#btnPasteZh").addEventListener("click", () => {
      loadCaptionText($("#pasteArea").value, "zh");
    });
    $("#btnPasteBi").addEventListener("click", () => {
      loadCaptionText($("#pasteArea").value, "auto");
    });

    $("#btnLoadSample").addEventListener("click", loadSample);
    $("#btnExportSrt").addEventListener("click", exportSRT);
    $("#btnExportTxt").addEventListener("click", exportTXT);
    $("#btnWhisper").addEventListener("click", runWhisperTranscribe);

    $("#btnVocab").addEventListener("click", openVocabDrawer);
    $("#btnShortcuts").addEventListener("click", () => openDrawer("#shortcutsDrawer"));
    $("#drawerBackdrop").addEventListener("click", closeDrawers);
    $$("[data-close-drawer]").forEach((b) => b.addEventListener("click", closeDrawers));

    $("#btnFlashcards").addEventListener("click", () => {
      $("#vocabListPanel").classList.add("hidden");
      $("#flashcardPanel").classList.remove("hidden");
      fcIndex = 0;
      fcRevealed = false;
      renderFlashcard();
    });
    $("#btnBackVocab").addEventListener("click", () => {
      $("#flashcardPanel").classList.add("hidden");
      $("#vocabListPanel").classList.remove("hidden");
      renderVocabList();
    });
    $("#flashcard").addEventListener("click", () => {
      if (!prefs.vocab.length) return;
      fcRevealed = !fcRevealed;
      renderFlashcard();
    });
    $("#btnFcPrev").addEventListener("click", () => {
      if (!prefs.vocab.length) return;
      fcIndex = (fcIndex - 1 + prefs.vocab.length) % prefs.vocab.length;
      fcRevealed = false;
      renderFlashcard();
    });
    $("#btnFcNext").addEventListener("click", () => {
      if (!prefs.vocab.length) return;
      fcIndex = (fcIndex + 1) % prefs.vocab.length;
      fcRevealed = false;
      renderFlashcard();
    });
    $("#btnClearVocab").addEventListener("click", () => {
      if (!prefs.vocab.length) return;
      if (confirm("確定清空生詞本？")) {
        prefs.vocab = [];
        savePrefs();
        updateVocabBadge();
        renderVocabList();
        toast("已清空生詞本");
      }
    });

    document.addEventListener("keydown", onKeydown);

    renderCues();
    updateLoopUI();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
