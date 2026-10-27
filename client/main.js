/* SoundSyncPro — match dual-system audio to camera clips and build synced sequences in Premiere. */
(function () {
  "use strict";

  var cs = new CSInterface();
  var EXT_ROOT = cs.getSystemPath(SystemPath.EXTENSION);
  var tools = Media.init(EXT_ROOT);
  var path = Media.path, fs = Media.fs;

  var $ = function (id) { return document.getElementById(id); };
  var el = {
    srcSeg: $("srcSeg"), projectSrc: $("projectSrc"), foldersSrc: $("foldersSrc"),
    projectInfo: $("projectInfo"), refreshBtn: $("refreshBtn"),
    videoDir: $("videoDir"), audioDir: $("audioDir"), videoBrowse: $("videoBrowse"), audioBrowse: $("audioBrowse"),
    recursiveChk: $("recursiveChk"),
    minZ: $("minZ"), minProm: $("minProm"), oneToOneChk: $("oneToOneChk"), keepScratchChk: $("keepScratchChk"),
    binName: $("binName"), seqSuffix: $("seqSuffix"), jobs: $("jobs"), settingsDetails: $("settingsDetails"),
    analyseBtn: $("analyseBtn"), cancelBtn: $("cancelBtn"),
    fill: $("fill"), status: $("status"),
    resultsBlock: $("resultsBlock"), results: $("results"), resultsTitle: $("resultsTitle"), allChk: $("allChk"),
    csvBtn: $("csvBtn"), createBtn: $("createBtn"),
    log: $("log"), logDetails: $("logDetails"), ver: $("ver"), hostInfo: $("hostInfo")
  };

  var state = {
    src: "project", busy: false, cancel: null,
    projectItems: [],          // { name, path }
    data: null                 // last match result: { accepted, rejected, unmatched, skipped, media }
  };

  /* ---------------- settings ---------------- */
  var KEY = "ssp.settings.v1";
  function saveSettings() {
    var s = {
      src: state.src, videoDir: el.videoDir.value, audioDir: el.audioDir.value, recursive: el.recursiveChk.checked,
      minZ: el.minZ.value, minProm: el.minProm.value, oneToOne: el.oneToOneChk.checked, keepScratch: el.keepScratchChk.checked,
      binName: el.binName.value, seqSuffix: el.seqSuffix.value, jobs: el.jobs.value
    };
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {}
  }
  function loadSettings() {
    var s = {};
    try { s = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (e) {}
    setSrc(s.src || "project");
    el.videoDir.value = s.videoDir || "";
    el.audioDir.value = s.audioDir || "";
    el.recursiveChk.checked = !!s.recursive;
    if (s.minZ) el.minZ.value = s.minZ;
    if (s.minProm) el.minProm.value = s.minProm;
    el.oneToOneChk.checked = !!s.oneToOne;
    el.keepScratchChk.checked = !!s.keepScratch;
    if (s.binName) el.binName.value = s.binName;
    if (s.seqSuffix !== undefined) el.seqSuffix.value = s.seqSuffix;
    el.jobs.value = s.jobs || String(Math.min(4, Media.cpuCount()));
  }

  /* ---------------- ui ---------------- */
  function setSrc(src) {
    state.src = src;
    Array.prototype.forEach.call(el.srcSeg.querySelectorAll(".seg-btn"), function (b) {
      b.classList.toggle("active", b.getAttribute("data-src") === src);
    });
    el.projectSrc.classList.toggle("hidden", src !== "project");
    el.foldersSrc.classList.toggle("hidden", src !== "folders");
  }
  function setBusy(b) {
    state.busy = b;
    el.analyseBtn.classList.toggle("hidden", b);
    el.cancelBtn.classList.toggle("hidden", !b);
    el.createBtn.disabled = b;
    el.refreshBtn.disabled = b;
  }
  function setProgress(pct, cls) {
    el.fill.style.width = Math.max(0, Math.min(100, pct)) + "%";
    el.fill.className = "fill" + (cls ? " " + cls : "");
  }
  function status(msg) { el.status.textContent = msg; el.status.title = msg; }
  function log(line, cls) {
    el.log.textContent += String(line).replace(/\s+$/, "") + "\n";
    el.log.scrollTop = el.log.scrollHeight;
  }
  function fail(msg) {
    status(msg); setProgress(100, "err"); log("ERROR: " + msg); el.logDetails.open = true; setBusy(false);
  }
  function fmtOff(s) { return (s >= 0 ? "+" : "−") + Math.abs(s).toFixed(3) + "s"; }
  function confClass(c) { return c >= 80 ? "hi" : c >= 50 ? "mid" : "lo"; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  /* ---------------- host bridge ---------------- */
  function host(fnCall) {
    return new Promise(function (resolve) {
      cs.evalScript(fnCall, function (res) {
        var out;
        try { out = JSON.parse(res); } catch (e) { out = { ok: false, error: "host returned: " + String(res).slice(0, 300) }; }
        resolve(out);
      });
    });
  }
  function hostCall(fn /*, args... */) {
    var args = Array.prototype.slice.call(arguments, 1).map(function (a) { return JSON.stringify(typeof a === "string" ? a : JSON.stringify(a)); });
    return host(fn + "(" + args.join(",") + ")");
  }

  async function scanProject() {
    var r = await host("sspProjectItems()");
    if (!r.ok) { el.projectInfo.textContent = "Could not read project: " + r.error; state.projectItems = []; return; }
    state.projectItems = r.items || [];
    var nv = 0, na = 0;
    state.projectItems.forEach(function (it) { if (Media.isVideo(it.path)) nv++; else if (Media.isAudio(it.path)) na++; });
    el.projectInfo.textContent = (r.project || "Project") + ": " + nv + " video clip" + (nv === 1 ? "" : "s") + ", " + na + " audio file" + (na === 1 ? "" : "s");
    el.hostInfo.textContent = r.project || "";
  }

  /* ---------------- analysis ---------------- */
  async function fingerprint(p, cancel) {
    var m;
    try { m = await Media.probe(p, cancel); } catch (e) { return { skip: e.message }; }
    if (!m.has_audio) return { skip: "no audio track -- cannot be synced by waveform" };
    var pcm = await Media.decodeMono(p, m.audio_streams, DSP.SR, cancel);
    if (!pcm || pcm.length < DSP.SR) return { skip: "audio undecodable or under 1s (" + m.audio_streams + " stream(s) tried)" };
    if (Media.loud(pcm) < 1e-5) return { skip: "all " + m.audio_streams + " audio stream(s) are silent" };
    cancel.check();
    m.fine = await DSP.bandFlux(pcm);
    pcm = null;
    if (m.fine.frames < 8) return { skip: "too short to fingerprint" };
    m.coarse = DSP.coarseFromFine(m.fine);
    return { media: m };
  }

  async function loadAll(paths, label, jobs, cancel) {
    var items = [], skipped = [], done = 0, idx = 0;
    async function worker() {
      while (idx < paths.length) {
        var p = paths[idx++];
        cancel.check();
        var r = await fingerprint(p, cancel);
        done++;
        setProgress(100 * done / paths.length);
        status("Analysing " + label + " " + done + "/" + paths.length + ": " + path.basename(p));
        log("[" + label + " " + done + "/" + paths.length + "] " + path.basename(p) + (r.skip ? "  SKIPPED: " + r.skip : ""));
        if (r.skip) skipped.push({ file: path.basename(p), path: p, reason: r.skip });
        else items.push(r.media);
      }
    }
    var pool = [];
    for (var i = 0; i < Math.max(1, Math.min(jobs, paths.length)); i++) pool.push(worker());
    await Promise.all(pool);
    items.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
    return { items: items, skipped: skipped };
  }

  function sourcePaths() {
    if (state.src === "project") {
      var v = [], a = [];
      state.projectItems.forEach(function (it) { if (Media.isVideo(it.path)) v.push(it.path); else if (Media.isAudio(it.path)) a.push(it.path); });
      return { v: v, a: a };
    }
    var vd = el.videoDir.value.trim(), ad = el.audioDir.value.trim();
    if (!vd || !fs.existsSync(vd)) throw new Error("Pick a video folder.");
    if (!ad || !fs.existsSync(ad)) throw new Error("Pick an audio folder.");
    return { v: Media.gather(vd, "video", el.recursiveChk.checked), a: Media.gather(ad, "audio", el.recursiveChk.checked) };
  }

  async function analyse() {
    if (state.busy) return;
    if (!Media.ffmpeg || !Media.ffprobe) return fail("ffmpeg/ffprobe not found. Put them in bin\\ or C:\\ffmpeg\\bin.");
    saveSettings();
    el.log.textContent = "";
    var src;
    try { if (state.src === "project") await scanProject(); src = sourcePaths(); } catch (e) { return fail(e.message); }
    if (!src.v.length) return fail("No video clips found.");
    if (!src.a.length) return fail("No audio files found.");

    var cancel = new Media.Canceller();
    state.cancel = cancel;
    setBusy(true);
    setProgress(0);
    el.resultsBlock.classList.add("hidden");
    var jobs = parseInt(el.jobs.value, 10) || 4;
    var t0 = Date.now();
    log("Analysing " + src.v.length + " video and " + src.a.length + " audio file(s), " + jobs + " at a time");

    try {
      var V = await loadAll(src.v, "video", jobs, cancel);
      var A = await loadAll(src.a, "audio", jobs, cancel);
      if (!V.items.length) throw new Error("No video files had usable scratch audio -- nothing to sync against.");
      if (!A.items.length) throw new Error("No audio files could be analysed.");

      status("Matching…");
      setProgress(0);
      var res = await DSP.match(V.items, A.items, {
        minZ: parseFloat(el.minZ.value) || 12, minProm: parseFloat(el.minProm.value) || 1.2, oneToOne: el.oneToOneChk.checked
      }, function (i, n, name) { setProgress(100 * i / n); status("Matching " + i + "/" + n + ": " + name); cancel.check(); });

      var matched = {};
      res.accepted.forEach(function (p) { matched[p.video] = true; });
      var media = {};
      V.items.concat(A.items).forEach(function (m) { media[m.name] = { path: m.path, duration: m.duration, fps: m.fps, name: m.name }; });
      state.data = {
        accepted: res.accepted, rejected: res.rejected,
        unmatched: V.items.filter(function (v) { return !matched[v.name]; }).map(function (v) { return v.name; }),
        skipped: V.skipped.concat(A.skipped), media: media
      };
      // free fingerprints
      V.items.concat(A.items).forEach(function (m) { m.fine = null; m.coarse = null; });

      var secs = ((Date.now() - t0) / 1000).toFixed(1);
      res.accepted.forEach(function (p) { log(p.video + "  <-  " + p.audio + "   offset " + fmtOff(p.offset) + "   (" + p.confidence + "%, z " + p.z + ", prom " + p.prominence + ")"); });
      res.rejected.forEach(function (p) { if (!matched[p.video]) log(p.video + "  <-  NO MATCH   best guess " + p.audio + " at " + fmtOff(p.offset) + ", " + p.reason); });
      status(res.accepted.length + " matched, " + state.data.unmatched.length + " unmatched, " + state.data.skipped.length + " skipped  (" + secs + "s)");
      setProgress(100, "done");
      renderResults();
    } catch (e) {
      if (cancel.cancelled) { status("Cancelled."); setProgress(0); }
      else return fail(e.message || String(e));
    } finally {
      state.cancel = null;
      setBusy(false);
    }
  }

  function cancelRun() {
    if (state.cancel) { status("Cancelling…"); state.cancel.cancel(); }
  }

  /* ---------------- results ---------------- */
  function renderResults() {
    var d = state.data;
    if (!d) return;
    var html = "";
    var seen = {};
    function alts(p) {
      var c = (p.candidates || []).slice(1);
      if (!c.length) return "";
      return '<details><summary>runner-ups</summary><div class="alts">' + c.map(function (x) {
        return "<div>" + esc(x.audio) + " · " + fmtOff(x.offset) + " · " + x.confidence + "% (z " + x.z + ")</div>";
      }).join("") + "</div></details>";
    }
    if (d.accepted.length) html += '<div class="group">Matched</div>';
    d.accepted.forEach(function (p, i) {
      html += '<div class="pair" data-i="' + i + '"><div class="top">' +
        '<input type="checkbox" class="rowchk" data-i="' + i + '" checked>' +
        '<div class="names"><div class="v" title="' + esc(p.video_path) + '">' + esc(p.video) + '</div><div class="a" title="' + esc(p.audio_path) + '">' + esc(p.audio) + '</div></div>' +
        '<div class="meta"><div class="conf ' + confClass(p.confidence) + '">' + p.confidence + '%</div><div class="off">' + fmtOff(p.offset) + '</div></div>' +
        '</div><div class="state" id="st-' + i + '"></div>' + alts(p) + '</div>';
    });
    var rej = d.rejected.filter(function (p) { if (seen[p.video] || d.accepted.some(function (a) { return a.video === p.video; })) return false; seen[p.video] = true; return true; });
    if (rej.length) html += '<div class="group">Unmatched (best guess shown)</div>';
    rej.forEach(function (p) {
      html += '<div class="pair rej"><div class="top"><span style="width:13px"></span>' +
        '<div class="names"><div class="v">' + esc(p.video) + '</div><div class="a">' + esc(p.audio) + '</div></div>' +
        '<div class="meta"><div class="conf ' + confClass(p.confidence) + '">' + p.confidence + '%</div><div class="off">' + fmtOff(p.offset) + '</div></div>' +
        '</div><div class="why">' + esc(p.reason) + '</div>' + alts(p) + '</div>';
    });
    if (d.skipped.length) html += '<div class="group">Skipped</div>';
    d.skipped.forEach(function (s) {
      html += '<div class="pair skip"><div class="top"><span style="width:13px"></span><div class="names"><div class="v">' + esc(s.file) + '</div></div></div><div class="why">' + esc(s.reason) + '</div></div>';
    });
    el.results.innerHTML = html;
    el.resultsTitle.textContent = d.accepted.length + " match" + (d.accepted.length === 1 ? "" : "es");
    el.allChk.checked = true;
    el.createBtn.disabled = !d.accepted.length;
    updateCreateLabel();
    el.resultsBlock.classList.remove("hidden");
  }
  function selectedPairs() {
    var out = [];
    Array.prototype.forEach.call(el.results.querySelectorAll(".rowchk"), function (c) {
      if (c.checked) out.push(parseInt(c.getAttribute("data-i"), 10));
    });
    return out;
  }
  function updateCreateLabel() {
    var n = selectedPairs().length;
    el.createBtn.textContent = "Create " + n + " sequence" + (n === 1 ? "" : "s");
    el.createBtn.disabled = state.busy || n === 0;
  }

  /* ---------------- create sequences ---------------- */
  async function createSequences() {
    var d = state.data;
    if (!d || state.busy) return;
    var idxs = selectedPairs();
    if (!idxs.length) return;
    saveSettings();
    setBusy(true);
    setProgress(0);
    var bin = el.binName.value.trim() || "Synced";
    var suffix = el.seqSuffix.value;
    var keep = el.keepScratchChk.checked;
    var okN = 0, errN = 0, names = [];

    for (var k = 0; k < idxs.length; k++) {
      var p = d.accepted[idxs[k]];
      var st = $("st-" + idxs[k]);
      var vm = d.media[p.video] || {}, am = d.media[p.audio] || {};
      var seqName = p.video.replace(/\.[^.]+$/, "") + suffix;
      status("Creating " + (k + 1) + "/" + idxs.length + ": " + seqName);
      setProgress(100 * k / idxs.length);
      if (st) { st.textContent = "creating…"; st.className = "state"; }
      var r = await hostCall("sspCreateSequence", {
        videoPath: p.video_path, audioPath: p.audio_path, offset: p.offset,
        videoDur: vm.duration || 0, audioDur: am.duration || 0,
        seqName: seqName, binName: bin, keepScratch: keep
      });
      if (r.ok) {
        okN++; names.push(seqName);
        if (st) { st.textContent = "✓ " + seqName + " (audio on " + r.track + ")"; st.className = "state"; }
        st && st.parentElement.classList.add("done");
        log("OK  " + seqName + "  audio " + r.track + " start " + Number(r.audioStart).toFixed(3) + "s in " + Number(r.audioIn).toFixed(3) + "s" + (r.warnings && r.warnings.length ? "  [" + r.warnings.join("; ") + "]" : ""));
      } else {
        errN++;
        if (st) { st.textContent = "✗ " + r.error; st.className = "state err"; }
        log("FAIL " + seqName + ": " + r.error + (r.warnings && r.warnings.length ? "  [" + r.warnings.join("; ") + "]" : ""));
      }
      await new Promise(function (res) { setTimeout(res, 0); });
    }
    setProgress(100, errN ? "err" : "done");
    status(okN + " sequence" + (okN === 1 ? "" : "s") + " created in bin \"" + bin + "\"" + (errN ? ", " + errN + " failed (see log)" : ""));
    if (errN) el.logDetails.open = true;
    setBusy(false);
    updateCreateLabel();
  }

  /* ---------------- csv ---------------- */
  function exportCsv() {
    var d = state.data;
    if (!d) return;
    var start = el.videoDir.value.trim() || (d.accepted[0] ? path.dirname(d.accepted[0].video_path) : "");
    var res = window.cep.fs.showSaveDialogEx("Save pairing CSV", start, ["csv"], "soundsync_pairs.csv");
    if (!res || res.err !== 0 || !res.data) return;
    var out = Runtime.toNative(res.data);
    if (!/\.csv$/i.test(out)) out += ".csv";
    function q(s) { s = String(s === undefined || s === null ? "" : s); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
    var rows = [["status", "video", "audio", "offset_s", "confidence", "z", "prominence", "runner_up", "runner_up_offset_s", "runner_up_confidence", "reason", "video_path", "audio_path"]];
    function row(stat, p) {
      var ru = (p.candidates || [])[1] || {};
      rows.push([stat, p.video, p.audio, p.offset, p.confidence, p.z, p.prominence, ru.audio || "", ru.offset === undefined ? "" : ru.offset, ru.confidence === undefined ? "" : ru.confidence, p.reason || "", p.video_path, p.audio_path]);
    }
    d.accepted.forEach(function (p) { row("matched", p); });
    var seen = {};
    d.rejected.forEach(function (p) { if (d.accepted.some(function (a) { return a.video === p.video; }) || seen[p.video]) return; seen[p.video] = true; row("unmatched", p); });
    d.skipped.forEach(function (s) { rows.push(["skipped", s.file, "", "", "", "", "", "", "", "", s.reason, s.path || "", ""]); });
    try {
      fs.writeFileSync(out, rows.map(function (r) { return r.map(q).join(","); }).join("\r\n") + "\r\n", "utf8");
      status("CSV saved: " + path.basename(out));
    } catch (e) { fail("CSV write failed: " + e.message); }
  }

  /* ---------------- browse ---------------- */
  function browseDir(input) {
    var start = input.value.trim() || "";
    var res = window.cep.fs.showOpenDialogEx(false, true, "Choose folder", start, []);
    if (res && res.err === 0 && res.data && res.data.length) {
      input.value = Runtime.toNative(res.data[0]);
      autoSibling(input);
      saveSettings();
    }
  }
  var VIDEO_NAMES = ["video", "footage", "clips", "camera", "cam", "a-cam", "b-cam", "mxf", "card"];
  var AUDIO_NAMES = ["audio", "sound", "rec", "recorder", "wav", "zoom", "tascam", "mixpre"];
  function autoSibling(changed) {
    var other = changed === el.videoDir ? el.audioDir : el.videoDir;
    if (other.value.trim()) return;
    var want = changed === el.videoDir ? AUDIO_NAMES : VIDEO_NAMES;
    var parent = path.dirname(changed.value.trim());
    try {
      var hit = fs.readdirSync(parent).filter(function (n) {
        var full = path.join(parent, n);
        try { if (!fs.statSync(full).isDirectory()) return false; } catch (e) { return false; }
        var l = n.toLowerCase();
        return want.some(function (w) { return l.indexOf(w) >= 0; });
      })[0];
      if (hit) other.value = path.join(parent, hit);
    } catch (e) {}
  }

  /* ---------------- wire ---------------- */
  el.srcSeg.addEventListener("click", function (e) {
    var b = e.target.closest(".seg-btn");
    if (!b) return;
    setSrc(b.getAttribute("data-src"));
    saveSettings();
    if (state.src === "project") scanProject();
  });
  el.refreshBtn.addEventListener("click", scanProject);
  el.videoBrowse.addEventListener("click", function () { browseDir(el.videoDir); });
  el.audioBrowse.addEventListener("click", function () { browseDir(el.audioDir); });
  [el.videoDir, el.audioDir, el.recursiveChk, el.minZ, el.minProm, el.oneToOneChk, el.keepScratchChk, el.binName, el.seqSuffix, el.jobs]
    .forEach(function (x) { x.addEventListener("change", saveSettings); });
  el.analyseBtn.addEventListener("click", analyse);
  el.cancelBtn.addEventListener("click", cancelRun);
  el.createBtn.addEventListener("click", createSequences);
  el.csvBtn.addEventListener("click", exportCsv);
  el.allChk.addEventListener("change", function () {
    Array.prototype.forEach.call(el.results.querySelectorAll(".rowchk"), function (c) { c.checked = el.allChk.checked; });
    updateCreateLabel();
  });
  el.results.addEventListener("change", function (e) { if (e.target.classList.contains("rowchk")) updateCreateLabel(); });

  loadSettings();
  el.ver.textContent = (Media.ffmpeg ? "ffmpeg ok" : "ffmpeg NOT FOUND") + " · " + Runtime.platformLabel;
  el.ver.title = "ffmpeg: " + (Media.ffmpeg || "none") + "\nffprobe: " + (Media.ffprobe || "none") + "\nbin: " + (tools.bins ? tools.bins.dir : "") + "\next: " + EXT_ROOT;
  if (tools.bins && tools.bins.copied.length) log("Installed bundled binaries to " + tools.bins.dir + ": " + tools.bins.copied.join(", "));
  scanProject();
})();
