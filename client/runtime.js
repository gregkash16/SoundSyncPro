/* Cross-platform runtime helpers for CEP panels (Windows + macOS).
 *
 * Bundled binaries live in bin/win or bin/mac inside the extension. On first run (or
 * after an extension update) they are copied to a per-user folder so that:
 *   - yt-dlp -U can overwrite itself even when the ZXP was installed under Program Files
 *   - macOS gets the exec bit and loses the quarantine flag (ZXP installers don't guarantee either)
 */
var Runtime = (function () {
  "use strict";

  var nodeReq = (window.cep_node && window.cep_node.require) ? window.cep_node.require : require;
  var fs = nodeReq("fs"), path = nodeReq("path"), os = nodeReq("os"), cp = nodeReq("child_process");
  var proc = (window.cep_node && window.cep_node.process) || (typeof process !== "undefined" ? process : { platform: "win32", arch: "x64", env: {} });

  var IS_WIN = proc.platform === "win32";
  var IS_MAC = proc.platform === "darwin";
  var ARCH = proc.arch === "arm64" ? "arm64" : "x64";

  function exe(name) { return IS_WIN ? name + ".exe" : name; }
  function mkdirp(d) { try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); return true; } catch (e) { return false; } }
  function firstExisting(list) {
    for (var i = 0; i < list.length; i++) { try { if (list[i] && fs.existsSync(list[i])) return list[i]; } catch (e) {} }
    return null;
  }

  function userDataDir(app) {
    if (IS_WIN) return path.join(proc.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), app);
    if (IS_MAC) return path.join(os.homedir(), "Library", "Application Support", app);
    return path.join(os.homedir(), ".config", app.toLowerCase());
  }
  function defaultMediaDir(app) {
    return path.join(os.homedir(), IS_MAC ? "Movies" : "Videos", app);
  }
  function bundledBinDir(extRoot) {
    return path.join(extRoot, "bin", IS_WIN ? "win" : IS_MAC ? "mac" : "linux");
  }
  function bundleVersion(extRoot) {
    try {
      var x = fs.readFileSync(path.join(extRoot, "CSXS", "manifest.xml"), "utf8");
      var m = /ExtensionBundleVersion="([^"]+)"/.exec(x);
      return m ? m[1] : "0";
    } catch (e) { return "0"; }
  }

  /* GUI apps on macOS get a tiny PATH; make Homebrew etc. visible to child processes. */
  function spawnEnv() {
    var e = Object.assign({}, proc.env);
    if (!IS_WIN) {
      var extra = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
      e.PATH = extra.concat((e.PATH || "").split(":")).filter(function (p, i, a) { return p && a.indexOf(p) === i; }).join(":");
    }
    return e;
  }

  function which(name) {
    try {
      var r = cp.spawnSync(IS_WIN ? "where.exe" : "which", [name], { windowsHide: true, encoding: "utf8", env: spawnEnv() });
      if (r.status === 0 && r.stdout) {
        var f = r.stdout.split(/\r?\n/).filter(Boolean)[0];
        if (f && fs.existsSync(f)) return f;
      }
    } catch (e) {}
    return null;
  }

  function fixMacBinary(p) {
    try { fs.chmodSync(p, 493 /* 0755 */); } catch (e) {}
    try { cp.spawnSync("xattr", ["-d", "com.apple.quarantine", p], { encoding: "utf8" }); } catch (e) {}
  }

  /**
   * Copy bundled binaries to the user folder (once per extension version) and return their paths.
   * names: base names without extension. On mac, "name-arm64" / "name-x64" variants are picked by CPU.
   * Returns { dir, bins: { name: fullPath|null }, copied: [names] }
   */
  function ensureBins(extRoot, app, names) {
    var src = bundledBinDir(extRoot);
    var dst = path.join(userDataDir(app), "bin");
    var writable = mkdirp(dst);
    var ver = bundleVersion(extRoot);
    var marker = path.join(dst, ".bundled-version");
    var cur = ""; try { cur = fs.readFileSync(marker, "utf8").trim(); } catch (e) {}
    var refresh = cur !== ver;
    var bins = {}, copied = [];

    names.forEach(function (n) {
      var file = exe(n);
      var s = path.join(src, file);
      if (!fs.existsSync(s) && !IS_WIN) {
        var alt = path.join(src, n + "-" + ARCH);
        if (fs.existsSync(alt)) s = alt;
      }
      var d = path.join(dst, file);
      if (writable && fs.existsSync(s) && (refresh || !fs.existsSync(d))) {
        try { fs.copyFileSync(s, d); copied.push(n); if (!IS_WIN) fixMacBinary(d); } catch (e) {}
      }
      if (!IS_WIN && fs.existsSync(d)) fixMacBinary(d);
      bins[n] = fs.existsSync(d) ? d : (fs.existsSync(s) ? s : null);
    });
    if (writable) { try { fs.writeFileSync(marker, ver); } catch (e) {} }
    return { dir: dst, bins: bins, copied: copied, version: ver };
  }

  /* System-installed fallbacks for common tools. */
  function systemCandidates(name) {
    if (IS_WIN) return ["C:\\ffmpeg\\bin\\" + name + ".exe", "C:\\Program Files\\ffmpeg\\bin\\" + name + ".exe", "C:\\Program Files\\nodejs\\" + name + ".exe"];
    return ["/opt/homebrew/bin/" + name, "/usr/local/bin/" + name, "/usr/bin/" + name];
  }
  function findTool(name, bundled) {
    return bundled || firstExisting(systemCandidates(name)) || which(name) || null;
  }

  function killTree(child) {
    if (!child) return;
    try {
      if (IS_WIN) cp.spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      else { try { cp.spawnSync("pkill", ["-TERM", "-P", String(child.pid)]); } catch (e) {} child.kill("SIGKILL"); }
    } catch (e) {}
    try { child.kill(); } catch (e) {}
  }

  /* Reveal a folder in Explorer / Finder. CEP's own process API is the one that works from a panel. */
  function openFolder(dir, log) {
    log = log || function () {};
    mkdirp(dir);
    try {
      var r;
      if (IS_WIN) r = window.cep.process.createProcess((proc.env.WINDIR || "C:\\Windows") + "\\explorer.exe", dir);
      else r = window.cep.process.createProcess("/usr/bin/open", dir);
      if (r && r.err === 0) return true;
      log("Open folder: cep.process err " + (r ? r.err : "?"));
    } catch (e) { log("Open folder: cep.process threw " + e); }
    try {
      var r2 = window.cep.util.openURLInDefaultBrowser("file://" + (IS_WIN ? "/" + dir.replace(/\\/g, "/") : dir));
      if (r2 && r2.err === 0) return true;
    } catch (e2) {}
    try { cp.spawn(IS_WIN ? "explorer.exe" : "open", [dir], { windowsHide: true, stdio: "ignore" }).on("error", function (e) { log("Open folder: spawn " + e.message); }); }
    catch (e3) { log("Open folder: spawn threw " + e3); }
    return false;
  }

  function toNative(p) { return IS_WIN ? String(p).replace(/\//g, "\\") : String(p); }
  function isAbsPathLine(s) { s = String(s).trim(); return IS_WIN ? /^[A-Za-z]:\\/.test(s) : /^\//.test(s); }

  return {
    IS_WIN: IS_WIN, IS_MAC: IS_MAC, ARCH: ARCH, platformLabel: IS_WIN ? "Windows" : IS_MAC ? "macOS " + ARCH : proc.platform,
    fs: fs, path: path, os: os, cp: cp, env: proc.env,
    exe: exe, mkdirp: mkdirp, firstExisting: firstExisting, userDataDir: userDataDir, defaultMediaDir: defaultMediaDir,
    bundledBinDir: bundledBinDir, ensureBins: ensureBins, findTool: findTool, which: which, spawnEnv: spawnEnv,
    killTree: killTree, openFolder: openFolder, toNative: toNative, isAbsPathLine: isAbsPathLine
  };
})();
