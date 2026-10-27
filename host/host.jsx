/* SoundSyncPro host script (Premiere Pro ExtendScript).
 * Everything returns a JSON string. ExtendScript has no JSON, so a small one lives here.
 */

/* ---------------- minimal JSON ---------------- */
if (typeof JSON === "undefined") { JSON = {}; }
if (typeof JSON.stringify !== "function") {
  JSON.stringify = function (v) {
    function esc(s) {
      return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t") + '"';
    }
    function go(x) {
      if (x === null || x === undefined) return "null";
      var t = typeof x;
      if (t === "number") return isFinite(x) ? String(x) : "null";
      if (t === "boolean") return x ? "true" : "false";
      if (t === "string") return esc(x);
      if (x instanceof Array) { var a = []; for (var i = 0; i < x.length; i++) a.push(go(x[i])); return "[" + a.join(",") + "]"; }
      var o = [];
      for (var k in x) if (x.hasOwnProperty(k) && typeof x[k] !== "function") o.push(esc(k) + ":" + go(x[k]));
      return "{" + o.join(",") + "}";
    }
    return go(v);
  };
}
if (typeof JSON.parse !== "function") {
  JSON.parse = function (s) { return eval("(" + s + ")"); };
}

function sspOk(obj) { obj = obj || {}; obj.ok = true; return JSON.stringify(obj); }
function sspErr(msg, extra) { var o = extra || {}; o.ok = false; o.error = String(msg); return JSON.stringify(o); }

/* ---------------- helpers ---------------- */
function sspNorm(p) { return String(p || "").replace(/\\/g, "/").toLowerCase(); }   // same on Windows and macOS

function sspWalk(item, fn, depth) {
  depth = depth || 0;
  if (!item) return;
  for (var i = 0; i < item.children.numItems; i++) {
    var c = item.children[i];
    fn(c, depth);
    if (c.type === ProjectItemType.BIN) sspWalk(c, fn, depth + 1);
  }
}

function sspFindByPath(p) {
  var want = sspNorm(p), hit = null;
  sspWalk(app.project.rootItem, function (c) {
    if (hit || c.type !== ProjectItemType.CLIP && c.type !== ProjectItemType.FILE) return;
    var mp = "";
    try { mp = c.getMediaPath(); } catch (e) {}
    if (mp && sspNorm(mp) === want) hit = c;
  });
  return hit;
}

function sspEnsureBin(name, parent) {
  parent = parent || app.project.rootItem;
  for (var i = 0; i < parent.children.numItems; i++) {
    var c = parent.children[i];
    if (c.type === ProjectItemType.BIN && c.name === name) return c;
  }
  return parent.createBin(name);
}

function sspSeconds(x) { var t = new Time(); t.seconds = x; return t; }

/* ---------------- API ---------------- */

/** All media clips in the project with their file paths. */
function sspProjectItems() {
  try {
    if (!app.project) return sspErr("no project open");
    var out = [];
    sspWalk(app.project.rootItem, function (c, depth) {
      if (c.type !== ProjectItemType.CLIP && c.type !== ProjectItemType.FILE) return;
      var mp = "";
      try { mp = c.getMediaPath(); } catch (e) {}
      if (!mp) return;
      var isSeq = false;
      try { isSeq = c.isSequence(); } catch (e) {}
      if (isSeq) return;
      out.push({ name: c.name, path: mp, nodeId: c.nodeId, treePath: c.treePath });
    });
    return sspOk({ items: out, project: app.project.name, projectPath: app.project.path });
  } catch (e) { return sspErr(e); }
}

/** Import any of the given paths not already in the project, into binName. */
function sspImport(pathsJson, binName) {
  try {
    if (!app.project) return sspErr("no project open");
    var paths = JSON.parse(pathsJson);
    var bin = sspEnsureBin(binName || "SoundSyncPro");
    var missing = [];
    for (var i = 0; i < paths.length; i++) if (!sspFindByPath(paths[i])) missing.push(paths[i]);
    if (missing.length) {
      var ok = app.project.importFiles(missing, true, bin, false);
      if (!ok) return sspErr("importFiles returned false", { attempted: missing.length });
    }
    var still = [];
    for (var j = 0; j < paths.length; j++) if (!sspFindByPath(paths[j])) still.push(paths[j]);
    return sspOk({ imported: missing.length, failed: still });
  } catch (e) { return sspErr(e); }
}

/**
 * Build one synced sequence.
 * payload: { videoPath, audioPath, offset, videoDur, audioDur, seqName, binName, keepScratch }
 * offset = point in the audio that lines up with the video's first frame (seconds).
 */
function sspCreateSequence(payloadJson) {
  var warn = [];
  try {
    if (!app.project) return sspErr("no project open");
    var p = JSON.parse(payloadJson);
    var bin = sspEnsureBin(p.binName || "SoundSyncPro");

    var video = sspFindByPath(p.videoPath);
    var audio = sspFindByPath(p.audioPath);
    if (!video || !audio) {
      var need = [];
      if (!video) need.push(p.videoPath);
      if (!audio) need.push(p.audioPath);
      var mediaBin = sspEnsureBin("Media", bin);
      app.project.importFiles(need, true, mediaBin, false);
      video = video || sspFindByPath(p.videoPath);
      audio = audio || sspFindByPath(p.audioPath);
      if (!video) return sspErr("could not import video: " + p.videoPath);
      if (!audio) return sspErr("could not import audio: " + p.audioPath);
    }

    // 1) sequence that matches the camera clip
    var seq = null;
    try { seq = app.project.createNewSequenceFromClips(p.seqName, [video], bin); } catch (e) { warn.push("createNewSequenceFromClips: " + e); }
    if (!seq) {
      // fallback: default preset, then drop the clip in
      var id = "ssp-" + (new Date()).getTime() + "-" + Math.floor(Math.random() * 1e6);
      app.project.createNewSequence(p.seqName, id);
      seq = app.project.activeSequence;
      if (!seq) return sspErr("could not create a sequence", { warnings: warn });
      try { seq.videoTracks[0].overwriteClip(video, 0); } catch (e2) { return sspErr("overwriteClip(video): " + e2, { warnings: warn }); }
      try { seq.projectItem.moveBin(bin); } catch (e3) {}
      warn.push("sequence used the default preset; check frame size / rate");
    }
    try { app.project.activeSequence = seq; } catch (e4) { try { app.project.openSequence(seq.sequenceID); } catch (e5) {} }

    // 2) in/out on the audio master clip, then overwrite onto its own track
    var off = Number(p.offset) || 0;
    var vDur = Number(p.videoDur) || 0, aDur = Number(p.audioDur) || 0;
    var aIn, aStart;
    if (off >= 0) { aIn = off; aStart = 0; } else { aIn = 0; aStart = -off; }
    var aLen = Math.min(vDur - aStart, aDur - aIn);
    if (!(aLen > 0)) return sspErr("no usable overlap at the computed offset", { warnings: warn });
    var aOut = aIn + aLen;

    var inOk = false;
    try { audio.setInPoint(sspSeconds(aIn).ticks, 2); audio.setOutPoint(sspSeconds(aOut).ticks, 2); inOk = true; } catch (e6) {}
    if (!inOk) { try { audio.setInPoint(aIn, 2); audio.setOutPoint(aOut, 2); inOk = true; } catch (e7) { warn.push("setInPoint/OutPoint failed: " + e7); } }

    var camTracks = seq.audioTracks.numTracks;
    var trackIdx = -1;
    // try to add a fresh audio track via QE so the camera scratch stays untouched
    try {
      app.enableQE();
      var qseq = qe.project.getActiveSequence();
      if (qseq) {
        qseq.addTracks(0, 0, 1, 1, qseq.numAudioTracks, 0, 0);
        if (seq.audioTracks.numTracks > camTracks) trackIdx = seq.audioTracks.numTracks - 1;
      }
    } catch (e8) { warn.push("QE addTracks: " + e8); }
    if (trackIdx < 0) {
      // fallback: find an audio track with no clips; else use A1 (overwrites scratch in the overlap)
      for (var t = 0; t < seq.audioTracks.numTracks; t++) {
        if (seq.audioTracks[t].clips.numItems === 0) { trackIdx = t; break; }
      }
      if (trackIdx < 0) { trackIdx = 0; warn.push("no free audio track; recorder audio overwrote camera audio on A1"); }
    }

    var placed = false, perr = "";
    var track = seq.audioTracks[trackIdx];
    try { track.overwriteClip(audio, aStart); placed = true; } catch (e9) { perr = String(e9); }
    if (!placed) { try { track.overwriteClip(audio, sspSeconds(aStart).ticks); placed = true; } catch (e10) { perr += " | " + e10; } }
    if (!placed) { try { track.insertClip(audio, aStart); placed = true; } catch (e11) { perr += " | " + e11; } }
    try { audio.clearInPoint(2); audio.clearOutPoint(2); } catch (e12) {}
    if (!placed) return sspErr("could not place audio on track A" + (trackIdx + 1) + ": " + perr, { warnings: warn, seqName: p.seqName });

    // 3) mute camera scratch unless asked to keep it
    if (!p.keepScratch) {
      for (var m = 0; m < seq.audioTracks.numTracks; m++) {
        if (m === trackIdx) continue;
        try { seq.audioTracks[m].setMute(1); } catch (e13) {}
      }
    }
    try { var qs = qe.project.getActiveSequence(); if (qs && qs.name === p.seqName) { /* leave open */ } } catch (e14) {}

    return sspOk({ seqName: p.seqName, track: "A" + (trackIdx + 1), audioStart: aStart, audioIn: aIn, audioOut: aOut, warnings: warn });
  } catch (e) { return sspErr(e, { warnings: warn }); }
}

/** Close any sequences we opened during a batch (keeps the UI tidy). */
function sspCloseSequences(namesJson) {
  try {
    var names = JSON.parse(namesJson), closed = 0;
    for (var i = 0; i < app.project.sequences.numSequences; i++) {
      var s = app.project.sequences[i];
      for (var j = 0; j < names.length; j++) if (s.name === names[j]) { try { s.close(); closed++; } catch (e) {} }
    }
    return sspOk({ closed: closed });
  } catch (e) { return sspErr(e); }
}

function sspHostInfo() {
  try { return sspOk({ app: BridgeTalk.appName, version: app.version, project: app.project ? app.project.name : "" }); }
  catch (e) { return sspErr(e); }
}
