# SoundSyncPro

Premiere Pro CEP panel that matches separately-recorded audio to camera clips
by waveform fingerprint and builds one synced sequence per pair inside the
open project. Self-contained: a JavaScript port of the Sound Syncing matcher,
ffmpeg for decoding, ExtendScript for the Premiere side. No Python, no XML,
no baked media.

## What it does

1. **Source**: every clip already in the project, or a Video folder + Audio
   folder you pick (sibling folders auto-detected).
2. **Analyse**: ffprobe + ffmpeg decode each file to 8 kHz mono (all MXF audio
   streams mixed), 16-band spectral-flux fingerprint, coarse 1-D ranking then
   banded FFT cross-correlation. Accept on z-score of the peak vs the field.
3. **Results**: matched pairs with confidence %, offset, runner-ups; unmatched
   with best guess; skipped with reason. Export CSV.
4. **Create sequences**: for each ticked pair, `createNewSequenceFromClips`
   from the camera clip (so size/rate match), recorder audio overwritten onto a
   new track at the computed offset, camera scratch muted (optional keep).
   Files are imported into the bin if not already present.

## Layout

```
CSXS/manifest.xml   PPRO only, CSXS 11
client/dsp.js       matcher port (FFT, STFT, band flux, correlation, z-score)
client/media.js     ffprobe/ffmpeg via Node (probe, amix decode, folder scan)
client/main.js      panel logic
host/host.jsx       sspProjectItems / sspImport / sspCreateSequence (+ tiny JSON)
bin/                optional ffmpeg.exe + ffprobe.exe (else C:\ffmpeg\bin, else PATH)
```

## Install (dev)

`install.cmd` sets PlayerDebugMode and junctions this folder to
`%APPDATA%\Adobe\CEP\extensions\com.gregk.soundsyncpro`. Restart Premiere →
**Window ▸ Extensions ▸ SoundSyncPro**. Debug at `http://localhost:8090`.

## Algorithm constants (same as soundsync/matcher.py)

SR 8000 · NFFT 512 · HOP 80 (10 ms) · 16 log bands 100–3800 Hz · coarse pass
at 50 ms · TOP_K 6 · min overlap 2 s · z accept 12 · prominence 1.2 ·
confidence = 100·z³/(z³+10³).

## Notes

- Offset sign: positive = recorder was already rolling (trim into the audio);
  negative = recorder started late (audio placed later on the timeline).
- Adding a track uses the QE DOM (`qe.project.getActiveSequence().addTracks`).
  If that fails the audio goes on the first empty track, or A1 as last resort.
- Sequences, not merged clips: Premiere has no scripting API for Merge Clips.
