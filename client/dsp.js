/* SoundSyncPro DSP — JavaScript port of soundsync/matcher.py.
 *
 * Each file is reduced to a per-band spectral-flux matrix (energy rises in 16
 * log-spaced bands every 10 ms). Video vs audio fingerprints are
 * cross-correlated; a match is accepted on the z-score of the peak against the
 * field of all other alignments. Pure JS, no Node dependencies.
 */
var DSP = (function () {
  "use strict";

  var SR = 8000, NFFT = 512, HOP = 80;
  var FINE_HOP = HOP / SR;             // 0.010 s
  var COARSE_DECIM = 5;
  var COARSE_HOP = FINE_HOP * COARSE_DECIM;
  var N_BANDS = 16, BAND_LO = 100.0, BAND_HI = 3800.0;
  var TOP_K = 6, MIN_OVERLAP_S = 2.0, N_CANDIDATES = 3, Z_HALF = 10.0;

  /* ---------------- bands ---------------- */
  function bandEdges() {
    var lo = Math.log10(BAND_LO), hi = Math.log10(BAND_HI);
    var bins = [];
    for (var i = 0; i <= N_BANDS; i++) {
      var f = Math.pow(10, lo + (hi - lo) * i / N_BANDS);
      bins.push(Math.floor(f / (SR / NFFT)));
    }
    var out = [];
    for (var b = 0; b < N_BANDS; b++) out.push([bins[b], Math.max(bins[b] + 1, bins[b + 1])]);
    return out;
  }
  var BANDS = bandEdges();

  /* ---------------- FFT (radix-2, in place) ---------------- */
  var fftCache = {};
  function FFT(n) {
    if ((n & (n - 1)) !== 0) throw new Error("FFT size must be a power of two");
    this.n = n;
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (var i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos(2 * Math.PI * i / n);
      this.sin[i] = Math.sin(2 * Math.PI * i / n);
    }
    var levels = Math.round(Math.log2(n));
    this.rev = new Uint32Array(n);
    for (var j = 0; j < n; j++) {
      var r = 0, x = j;
      for (var l = 0; l < levels; l++) { r = (r << 1) | (x & 1); x >>>= 1; }
      this.rev[j] = r;
    }
  }
  FFT.get = function (n) { return fftCache[n] || (fftCache[n] = new FFT(n)); };
  FFT.prototype.transform = function (re, im, inverse) {
    var n = this.n, rev = this.rev, cos = this.cos, sin = this.sin;
    for (var i = 0; i < n; i++) {
      var j = rev[i];
      if (j > i) {
        var t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    var sgn = inverse ? 1 : -1;
    for (var size = 2; size <= n; size <<= 1) {
      var half = size >> 1, step = n / size;
      for (var s = 0; s < n; s += size) {
        for (var k = 0, q = s; q < s + half; q++, k += step) {
          var c = cos[k], sn = sgn * sin[k];
          var l = q + half;
          var tr = re[l] * c - im[l] * sn;
          var ti = im[l] * c + re[l] * sn;
          re[l] = re[q] - tr; im[l] = im[q] - ti;
          re[q] += tr; im[q] += ti;
        }
      }
    }
    if (inverse) { var inv = 1 / n; for (var m = 0; m < n; m++) { re[m] *= inv; im[m] *= inv; } }
  };
  function nextPow2(n) { var p = 1; while (p < n) p <<= 1; return p; }

  /* Split Z = FFT(a + i b) into A[k], B[k] for real a, b. Writes into out arrays. */
  function unpackPair(zr, zi, n, ar, ai, br, bi) {
    for (var k = 0; k < n; k++) {
      var km = (n - k) & (n - 1);
      ar[k] = 0.5 * (zr[k] + zr[km]);
      ai[k] = 0.5 * (zi[k] - zi[km]);
      br[k] = 0.5 * (zi[k] + zi[km]);
      bi[k] = 0.5 * (zr[km] - zr[k]);
    }
  }

  /* ---------------- fingerprint ---------------- */
  var HANN = (function () {
    var w = new Float64Array(NFFT);
    for (var i = 0; i < NFFT; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / NFFT);
    return w;
  })();
  var HANN_SUM = 256; // sum of periodic Hann(512); scipy.stft scales by this

  function yieldUI() { return new Promise(function (r) { setTimeout(r, 0); }); }

  /**
   * Per-band spectral flux: returns { bands: Float32Array[N_BANDS] (each `frames` long), frames }.
   * Matches scipy.signal.stft(boundary=None, padded=False, window='hann') semantics.
   */
  async function bandFlux(x, onProgress) {
    var len = x.length;
    var frames = len >= NFFT ? Math.floor((len - NFFT) / HOP) + 1 : 0;
    if (frames < 4) return { bands: [], frames: 0 };

    var fft = FFT.get(NFFT);
    var re = new Float64Array(NFFT), im = new Float64Array(NFFT);
    var banded = [];
    for (var b = 0; b < N_BANDS; b++) banded.push(new Float64Array(frames));
    var nb = NFFT / 2 + 1;
    var magA = new Float64Array(nb), magB = new Float64Array(nb);

    function accumulate(mag, f) {
      for (var b = 0; b < N_BANDS; b++) {
        var lo = BANDS[b][0], hi = BANDS[b][1], s = 0;
        for (var k = lo; k < hi; k++) s += mag[k];
        banded[b][f] = s / (hi - lo);
      }
    }

    for (var f = 0; f < frames; f += 2) {
      var off1 = f * HOP, two = (f + 1) < frames, off2 = (f + 1) * HOP;
      for (var i = 0; i < NFFT; i++) {
        re[i] = x[off1 + i] * HANN[i];
        im[i] = two ? x[off2 + i] * HANN[i] : 0;
      }
      fft.transform(re, im, false);
      for (var k = 0; k < nb; k++) {
        var km = (NFFT - k) & (NFFT - 1);
        var arr = 0.5 * (re[k] + re[km]), aii = 0.5 * (im[k] - im[km]);
        magA[k] = Math.sqrt(arr * arr + aii * aii) / HANN_SUM;
        if (two) {
          var brr = 0.5 * (im[k] + im[km]), bii = 0.5 * (re[km] - re[k]);
          magB[k] = Math.sqrt(brr * brr + bii * bii) / HANN_SUM;
        }
      }
      accumulate(magA, f);
      if (two) accumulate(magB, f + 1);
      if ((f & 4095) === 0) {
        if (onProgress) onProgress(f / frames);
        await yieldUI();
      }
    }

    // log compress, rising-energy flux, per-band standardise
    var out = [];
    for (var bb = 0; bb < N_BANDS; bb++) {
      var src = banded[bb];
      var dif = new Float32Array(frames);
      var prev = Math.log1p(src[0] * 100.0), sum = 0;
      dif[0] = 0;
      for (var t = 1; t < frames; t++) {
        var cur = Math.log1p(src[t] * 100.0);
        var d = cur - prev;
        dif[t] = d > 0 ? d : 0;
        sum += dif[t];
        prev = cur;
      }
      var mean = sum / frames, sq = 0;
      for (var u = 0; u < frames; u++) { var e = dif[u] - mean; sq += e * e; }
      var sd = Math.sqrt(sq / frames);
      if (sd < 1e-9) sd = 1.0;
      for (var v = 0; v < frames; v++) dif[v] = (dif[v] - mean) / sd;
      out.push(dif);
    }
    return { bands: out, frames: frames };
  }

  /** Summed flux decimated to 50 ms for the cheap first pass. */
  function coarseFromFine(fine) {
    var frames = fine.frames;
    if (!frames) return new Float32Array(0);
    var n = Math.floor(frames / COARSE_DECIM) * COARSE_DECIM;
    if (!n) return new Float32Array(0);
    var out = new Float32Array(n / COARSE_DECIM);
    for (var i = 0; i < n; i++) {
      var s = 0;
      for (var b = 0; b < N_BANDS; b++) s += fine.bands[b][i];
      out[(i / COARSE_DECIM) | 0] += s;
    }
    return out;
  }

  /* ---------------- correlation ---------------- */
  function unit(v) {
    var n = v.length, mean = 0, i;
    for (i = 0; i < n; i++) mean += v[i];
    mean /= n;
    var out = new Float64Array(n), norm = 0;
    for (i = 0; i < n; i++) { out[i] = v[i] - mean; norm += out[i] * out[i]; }
    norm = Math.sqrt(norm);
    if (norm < 1e-12) norm = 1.0;
    for (i = 0; i < n; i++) out[i] /= norm;
    return out;
  }

  function median(arr) {
    var a = Float64Array.from(arr).sort();
    var m = a.length >> 1;
    return a.length % 2 ? a[m] : 0.5 * (a[m - 1] + a[m]);
  }

  /** Best valid lag and how far it stands above the field. */
  function peakStats(corr, nv, na, hop) {
    var size = corr.length;
    var minOv = Math.max(4, Math.floor(MIN_OVERLAP_S / hop));
    var valid = new Uint8Array(size), nValid = 0;
    for (var i = 0; i < size; i++) {
      var lag = i - (nv - 1);
      var ov = Math.min(Math.min(na - lag, nv), na);
      if (ov >= minOv) { valid[i] = 1; nValid++; }
    }
    if (nValid < 8) return { offset: 0, z: 0, prom: 0 };

    var vals = new Float64Array(nValid), vi = 0, peakI = -1, peak = -Infinity;
    for (var j = 0; j < size; j++) {
      if (!valid[j]) continue;
      vals[vi++] = corr[j];
      if (corr[j] > peak) { peak = corr[j]; peakI = j; }
    }
    var med = median(vals);
    var dev = new Float64Array(nValid);
    for (var k = 0; k < nValid; k++) dev[k] = Math.abs(vals[k] - med);
    var mad = median(dev) * 1.4826;
    var spread = mad;
    if (!(mad > 1e-12)) {
      var mean = 0, sq = 0, m;
      for (m = 0; m < nValid; m++) mean += vals[m];
      mean /= nValid;
      for (m = 0; m < nValid; m++) { var e = vals[m] - mean; sq += e * e; }
      spread = Math.sqrt(sq / nValid) || 1e-12;
    }
    var z = (peak - med) / spread;

    var shift = 0;
    if (peakI > 0 && peakI < size - 1) {
      var y0 = corr[peakI - 1], y1 = peak, y2 = corr[peakI + 1];
      var denom = y0 - 2 * y1 + y2;
      if (Math.abs(denom) > 1e-12) shift = Math.max(-0.5, Math.min(0.5, 0.5 * (y0 - y2) / denom));
    }

    var guard = Math.max(3, Math.round(0.5 / hop));
    var gLo = Math.max(0, peakI - guard), gHi = Math.min(size, peakI + guard + 1);
    var runner = -Infinity, any = false;
    for (var q = 0; q < size; q++) {
      if (!valid[q] || (q >= gLo && q < gHi)) continue;
      any = true;
      if (corr[q] > runner) runner = corr[q];
    }
    if (!any) runner = 0;
    var prom = runner > 1e-9 ? peak / runner : 99.0;
    var offset = ((peakI - (nv - 1)) + shift) * hop;
    return { offset: offset, z: z, prom: Math.min(prom, 99.0) };
  }

  /** 1-D cross-correlation (coarse pass). v, a: Float32Array. */
  function correlate1d(v, a, hop) {
    var nv = v.length, na = a.length;
    if (!nv || !na) return { offset: 0, z: 0, prom: 0 };
    var uv = unit(v), ua = unit(a);
    var n = nextPow2(nv + na - 1);
    var fft = FFT.get(n);
    var re = new Float64Array(n), im = new Float64Array(n);
    for (var i = 0; i < na; i++) re[i] = ua[i];
    for (var j = 0; j < nv; j++) im[j] = uv[nv - 1 - j];   // reversed v in imaginary part
    fft.transform(re, im, false);
    var ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n);
    unpackPair(re, im, n, ar, ai, br, bi);
    for (var k = 0; k < n; k++) {
      re[k] = ar[k] * br[k] - ai[k] * bi[k];
      im[k] = ar[k] * bi[k] + ai[k] * br[k];
    }
    fft.transform(re, im, true);
    return peakStats(re.subarray(0, nv + na - 1), nv, na, hop);
  }

  /**
   * Precompute packed spectra of an audio fingerprint at FFT size n.
   * Returns Float32Array[2*N_BANDS] (re, im interleaved per band) — ~n*16*8 bytes.
   */
  function audioSpectra(fine, n) {
    var fft = FFT.get(n);
    var re = new Float64Array(n), im = new Float64Array(n);
    var ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n);
    var out = [];
    for (var b = 0; b < N_BANDS; b += 2) {
      var u1 = unit(fine.bands[b]), u2 = unit(fine.bands[b + 1]);
      re.fill(0); im.fill(0);
      re.set(u1); im.set(u2);
      fft.transform(re, im, false);
      unpackPair(re, im, n, ar, ai, br, bi);
      out.push(Float32Array.from(ar), Float32Array.from(ai), Float32Array.from(br), Float32Array.from(bi));
    }
    return out; // [b0re,b0im,b1re,b1im, b2re,...]
  }

  /** Banded cross-correlation summed across bands. specA from audioSpectra(aFine, n). */
  function correlateBands(vFine, aFine, specA, n) {
    var nv = vFine.frames, na = aFine.frames;
    if (!nv || !na) return { offset: 0, z: 0, prom: 0 };
    var fft = FFT.get(n);
    var re = new Float64Array(n), im = new Float64Array(n);
    var vr = new Float64Array(n), vi = new Float64Array(n), wr = new Float64Array(n), wi = new Float64Array(n);
    var sr = new Float64Array(n), si = new Float64Array(n);
    for (var b = 0; b < N_BANDS; b += 2) {
      var u1 = unit(vFine.bands[b]), u2 = unit(vFine.bands[b + 1]);
      re.fill(0); im.fill(0);
      for (var j = 0; j < nv; j++) { re[j] = u1[nv - 1 - j]; im[j] = u2[nv - 1 - j]; }
      fft.transform(re, im, false);
      unpackPair(re, im, n, vr, vi, wr, wi);
      var a1r = specA[2 * b], a1i = specA[2 * b + 1], a2r = specA[2 * b + 2], a2i = specA[2 * b + 3];
      for (var k = 0; k < n; k++) {
        sr[k] += a1r[k] * vr[k] - a1i[k] * vi[k] + a2r[k] * wr[k] - a2i[k] * wi[k];
        si[k] += a1r[k] * vi[k] + a1i[k] * vr[k] + a2r[k] * wi[k] + a2i[k] * wr[k];
      }
    }
    fft.transform(sr, si, true);
    return peakStats(sr.subarray(0, nv + na - 1), nv, na, FINE_HOP);
  }

  function confidence(z) {
    z = Math.max(0, z);
    var c = 100.0 * Math.pow(z, 3) / (Math.pow(z, 3) + Math.pow(Z_HALF, 3));
    return Math.round(c * 10) / 10;
  }

  /**
   * Match videos to audios. Each item: { name, path, duration, fine, coarse }.
   * opts: { minZ, minProm, oneToOne }. onProgress(i, total, name).
   * Returns { accepted: [...], rejected: [...] } with the same shape as matcher.py.
   */
  async function match(videos, audios, opts, onProgress) {
    var maxNv = 0, maxNa = 0;
    videos.forEach(function (v) { maxNv = Math.max(maxNv, v.fine.frames); });
    audios.forEach(function (a) { maxNa = Math.max(maxNa, a.fine.frames); });
    var n = nextPow2(maxNv + maxNa - 1);
    var specCache = {};

    var pairs = [];
    for (var vi = 0; vi < videos.length; vi++) {
      var v = videos[vi];
      if (onProgress) onProgress(vi + 1, videos.length, v.name);
      await yieldUI();

      var ranked = audios.map(function (a, ai) {
        return { z: correlate1d(v.coarse, a.coarse, COARSE_HOP).z, ai: ai };
      }).sort(function (p, q) { return q.z - p.z; });

      var cands = [];
      for (var r = 0; r < Math.min(TOP_K, ranked.length); r++) {
        var ai = ranked[r].ai, a = audios[ai];
        if (!specCache[ai]) specCache[ai] = audioSpectra(a.fine, n);
        var res = correlateBands(v.fine, a.fine, specCache[ai], n);
        cands.push({
          audio: a.name, audio_path: a.path, offset: Math.round(res.offset * 1e4) / 1e4,
          z: Math.round(res.z * 100) / 100, prominence: Math.round(res.prom * 100) / 100,
          confidence: confidence(res.z), _ai: ai
        });
        await yieldUI();
      }
      cands.sort(function (p, q) { return q.z - p.z; });
      if (cands.length) {
        var best = Object.assign({}, cands[0]);
        best.video = v.name; best.video_path = v.path;
        best.candidates = cands.slice(0, N_CANDIDATES).map(function (c) {
          return { audio: c.audio, audio_path: c.audio_path, offset: c.offset, z: c.z, prominence: c.prominence, confidence: c.confidence };
        });
        pairs.push(best);
      }
    }
    specCache = null;

    pairs.sort(function (p, q) { return q.z - p.z; });
    var used = {}, accepted = [], rejected = [];
    pairs.forEach(function (p) {
      if (p.z < opts.minZ || p.prominence < opts.minProm) {
        p.reason = "below confidence threshold (z " + p.z + ", prominence " + p.prominence + ")";
        rejected.push(p);
      } else if (opts.oneToOne && used[p._ai]) {
        p.reason = "that audio file was already claimed by a stronger match";
        rejected.push(p);
      } else {
        used[p._ai] = true;
        accepted.push(p);
      }
    });
    accepted.concat(rejected).forEach(function (p) { delete p._ai; });
    return { accepted: accepted, rejected: rejected };
  }

  return {
    SR: SR, N_BANDS: N_BANDS, FINE_HOP: FINE_HOP, COARSE_HOP: COARSE_HOP,
    bandFlux: bandFlux, coarseFromFine: coarseFromFine,
    correlate1d: correlate1d, correlateBands: correlateBands, audioSpectra: audioSpectra,
    confidence: confidence, match: match, nextPow2: nextPow2, FFT: FFT
  };
})();
