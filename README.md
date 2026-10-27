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
client/runtime.js   Windows/macOS abstraction: bundled-binary install, which, kill
client/dsp.js       matcher port (FFT, STFT, band flux, correlation, z-score)
client/media.js     ffprobe/ffmpeg via Node (probe, amix decode, folder scan)
client/main.js      panel logic
host/host.jsx       sspProjectItems / sspImport / sspCreateSequence (+ tiny JSON)
bin/win/            ffmpeg.exe + ffprobe.exe   (gitignored; get-bins.ps1)
bin/mac/            ffmpeg + ffprobe           (gitignored; get-bins.sh, run on a Mac)
```

On first launch the panel copies `bin/<platform>` to a per-user folder
(`%LOCALAPPDATA%\SoundSyncPro\bin` / `~/Library/Application Support/SoundSyncPro/bin`)
so macOS gets exec bits and no quarantine flag. Fallbacks: `C:\ffmpeg\bin`,
Homebrew paths, PATH.

## Install (dev)

`install.cmd` sets PlayerDebugMode and junctions this folder to
`%APPDATA%\Adobe\CEP\extensions\com.gregk.soundsyncpro` (Mac: `defaults write
com.adobe.CSXS.11 PlayerDebugMode 1` and symlink into
`~/Library/Application Support/Adobe/CEP/extensions/`). Fetch binaries with
`get-bins.ps1` / `./get-bins.sh`. Restart Premiere → **Window ▸ Extensions ▸
SoundSyncPro**. Debug at `http://localhost:8090`.

## Ship a ZXP

- Windows: `build-zxp.ps1 [version]` → `dist\SoundSyncPro-<v>-win.zxp`
- Mac: `./build-zxp.sh [version]` → `dist/SoundSyncPro-<v>-mac.zxp` (sign on a Mac)

Self-signed "CEP Panels" cert lives outside the repo (`%LOCALAPPDATA%\cep-tools`
/ `~/.cep-tools`). Friends install with the aescripts ZXP/UXP Installer; see
INSTALL.md.

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
