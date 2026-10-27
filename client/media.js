/* SoundSyncPro media layer — ffprobe / ffmpeg via CEP's Node. Port of matcher.probe + decode_mono. */
var Media = (function () {
  "use strict";

  var nodeReq = (window.cep_node && window.cep_node.require) ? window.cep_node.require : require;
  var fs = nodeReq("fs");
  var path = nodeReq("path");
  var cp = nodeReq("child_process");
  var os = nodeReq("os");

  var VIDEO_EXT = { ".mov": 1, ".mp4": 1, ".mxf": 1, ".avi": 1, ".mts": 1, ".m2ts": 1, ".mkv": 1, ".m4v": 1, ".wmv": 1 };
  var AUDIO_EXT = { ".wav": 1, ".aif": 1, ".aiff": 1, ".mp3": 1, ".m4a": 1, ".flac": 1, ".caf": 1, ".bwf": 1, ".ogg": 1, ".mka": 1, ".w64": 1, ".rf64": 1, ".opus": 1 };

  var extRoot = null, ffmpegPath = null, ffprobePath = null;

  function firstExisting(list) {
    for (var i = 0; i < list.length; i++) { try { if (fs.existsSync(list[i])) return list[i]; } catch (e) {} }
    return null;
  }
  function whereExe(name) {
    try {
      var r = cp.spawnSync("where.exe", [name], { windowsHide: true, encoding: "utf8" });
      if (r.status === 0 && r.stdout) { var f = r.stdout.split(/\r?\n/).filter(Boolean)[0]; if (f && fs.existsSync(f)) return f; }
    } catch (e) {}
    return null;
  }
  function init(root) {
    extRoot = root;
    var bin = path.join(root, "bin");
    ffmpegPath = firstExisting([path.join(bin, "ffmpeg.exe"), "C:\\ffmpeg\\bin\\ffmpeg.exe", "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe"]) || whereExe("ffmpeg");
    ffprobePath = firstExisting([path.join(bin, "ffprobe.exe"), "C:\\ffmpeg\\bin\\ffprobe.exe", "C:\\Program Files\\ffmpeg\\bin\\ffprobe.exe"]) || whereExe("ffprobe");
    return { ffmpeg: ffmpegPath, ffprobe: ffprobePath };
  }

  function isVideo(p) { return !!VIDEO_EXT[path.extname(p).toLowerCase()]; }
  function isAudio(p) { return !!AUDIO_EXT[path.extname(p).toLowerCase()]; }

  function gather(folder, kind, recursive) {
    var want = kind === "video" ? VIDEO_EXT : AUDIO_EXT;
    var out = [];
    function walk(d) {
      var names; try { names = fs.readdirSync(d); } catch (e) { return; }
      names.forEach(function (name) {
        var full = path.join(d, name), st;
        try { st = fs.statSync(full); } catch (e) { return; }
        if (st.isDirectory()) { if (recursive) walk(full); return; }
        if (want[path.extname(name).toLowerCase()]) out.push(full);
      });
    }
    walk(folder);
    out.sort(function (a, b) {
      var x = path.basename(a).toLowerCase(), y = path.basename(b).toLowerCase();
      return x < y ? -1 : x > y ? 1 : (a < b ? -1 : a > b ? 1 : 0);
    });
    return out;
  }

  /* ---- process helpers ---- */
  var live = {};
  var seq = 0;
  function runBinary(exe, args, cancel) {
    return new Promise(function (resolve) {
      var id = ++seq, chunks = [], err = "", total = 0;
      var child;
      try { child = cp.spawn(exe, args, { windowsHide: true }); }
      catch (e) { return resolve({ code: -1, buf: null, err: String(e) }); }
      live[id] = child;
      child.stdout.on("data", function (c) { chunks.push(c); total += c.length; });
      child.stderr.on("data", function (c) { err += c.toString(); });
      child.on("error", function (e) { err += String(e); });
      child.on("close", function (code) {
        delete live[id];
        var buf = total ? Buffer.concat(chunks, total) : null;
        resolve({ code: code, buf: buf, err: err });
      });
      if (cancel) cancel.onCancel(function () { try { child.kill(); } catch (e) {} });
    });
  }
  function killAll() {
    Object.keys(live).forEach(function (k) {
      try { cp.spawnSync("taskkill", ["/pid", String(live[k].pid), "/T", "/F"], { windowsHide: true }); } catch (e) {}
      try { live[k].kill(); } catch (e) {}
    });
  }

  function Canceller() { this.cancelled = false; this.subs = []; }
  Canceller.prototype.cancel = function () { this.cancelled = true; this.subs.forEach(function (f) { try { f(); } catch (e) {} }); killAll(); };
  Canceller.prototype.onCancel = function (f) { if (this.cancelled) f(); else this.subs.push(f); };
  Canceller.prototype.check = function () { if (this.cancelled) throw new Error("Cancelled"); };

  /* ---- probe ---- */
  async function probe(p, cancel) {
    if (!ffprobePath) throw new Error("ffprobe not found");
    var r = await runBinary(ffprobePath, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", p], cancel);
    if (r.code !== 0) throw new Error("ffprobe failed: " + (r.err.trim().split(/\r?\n/).pop() || "exit " + r.code));
    var info;
    try { info = JSON.parse(r.buf ? r.buf.toString("utf8") : ""); } catch (e) { throw new Error("ffprobe returned nothing readable"); }
    var m = {
      path: p, name: path.basename(p), duration: 0, fps: 0, width: 0, height: 0,
      has_video: false, has_audio: false, audio_channels: 0, audio_streams: 0,
      video_codec: "", pix_fmt: "", profile: "", has_b_frames: 0, bit_rate: 0, file_size: 0
    };
    var fmt = info.format || {};
    m.duration = parseFloat(fmt.duration) || 0;
    m.file_size = parseInt(fmt.size, 10) || 0;
    if (!m.file_size) { try { m.file_size = fs.statSync(p).size; } catch (e) {} }
    m.bit_rate = parseInt(fmt.bit_rate, 10) || 0;
    (info.streams || []).forEach(function (s) {
      if (s.codec_type === "video" && !m.has_video) {
        if (s.disposition && s.disposition.attached_pic) return;
        m.has_video = true;
        m.video_codec = (s.codec_name || "").toLowerCase();
        m.width = parseInt(s.width, 10) || 0;
        m.height = parseInt(s.height, 10) || 0;
        m.pix_fmt = (s.pix_fmt || "").toLowerCase();
        m.profile = String(s.profile || "");
        m.has_b_frames = parseInt(s.has_b_frames, 10) || 0;
        ["avg_frame_rate", "r_frame_rate"].some(function (key) {
          var parts = String(s[key] || "0/0").split("/");
          var num = parseFloat(parts[0]), den = parseFloat(parts[1]);
          if (num && den) { m.fps = num / den; return true; }
          return false;
        });
      } else if (s.codec_type === "audio") {
        m.audio_streams++;
        if (!m.has_audio) { m.has_audio = true; m.audio_channels = parseInt(s.channels, 10) || 0; }
      }
    });
    return m;
  }

  /* ---- decode ---- */
  function toF32(buf) {
    if (!buf || buf.length < 4) return null;
    var n = buf.length - (buf.length % 4);
    var ab = new ArrayBuffer(n);
    new Uint8Array(ab).set(buf.subarray(0, n));
    return new Float32Array(ab);
  }
  function loud(x) {
    if (!x || !x.length) return 0;
    var m = 0;
    for (var i = 0; i < x.length; i++) { var a = x[i] < 0 ? -x[i] : x[i]; if (a > m) m = a; }
    return m;
  }
  async function runDecode(args, cancel) {
    var r = await runBinary(ffmpegPath, args, cancel);
    if (r.code !== 0 || !r.buf) return null;
    return toF32(r.buf);
  }

  /** Fold every audio stream to one mono track at DSP.SR (amix, with fallbacks). */
  async function decodeMono(p, nStreams, sr, cancel) {
    if (!ffmpegPath) throw new Error("ffmpeg not found");
    var base = ["-v", "error", "-i", p, "-vn"];
    var tail = ["-ac", "1", "-ar", String(sr), "-f", "f32le", "-"];
    var attempts = [];
    if (nStreams > 1) {
      var ins = "";
      for (var i = 0; i < nStreams; i++) ins += "[0:a:" + i + "]";
      attempts.push(base.concat(["-filter_complex", ins + "amix=inputs=" + nStreams + ":duration=longest:normalize=0[m]", "-map", "[m]"], tail));
      attempts.push(base.concat(["-filter_complex", ins + "amix=inputs=" + nStreams + ":duration=longest[m]", "-map", "[m]"], tail));
    }
    attempts.push(base.concat(tail));
    for (var a = 0; a < attempts.length; a++) {
      if (cancel) cancel.check();
      var data = await runDecode(attempts[a], cancel);
      if (loud(data) > 1e-5) return data;
    }
    var best = null;
    for (var s = 0; s < Math.max(1, nStreams); s++) {
      if (cancel) cancel.check();
      var d = await runDecode(base.concat(["-map", "0:a:" + s], tail), cancel);
      if (loud(d) > loud(best)) best = d;
    }
    return best;
  }

  function cpuCount() { try { return os.cpus().length || 2; } catch (e) { return 2; } }

  return {
    init: init, isVideo: isVideo, isAudio: isAudio, gather: gather,
    probe: probe, decodeMono: decodeMono, loud: loud, Canceller: Canceller,
    cpuCount: cpuCount, killAll: killAll,
    get ffmpeg() { return ffmpegPath; }, get ffprobe() { return ffprobePath; },
    fs: fs, path: path
  };
})();
