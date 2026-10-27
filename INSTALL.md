# Installing SoundSyncPro

SoundSyncPro is a Premiere Pro panel (2024 or newer) that matches
separately-recorded audio to your camera clips by listening to them, then
builds one synced sequence per pair in your project. Windows and macOS.

Download from the [Releases page](https://github.com/gregkash16/SoundSyncPro/releases/latest)
and pick the file for your computer:

- Windows: `SoundSyncPro-<version>-win.zxp`
- Mac: `SoundSyncPro-<version>-mac.zxp` (Apple Silicon and Intel)

1. Install a ZXP installer if you don't have one. Either works and both are free:
   - aescripts ZXP/UXP Installer: https://aescripts.com/learn/zxp-installer/
   - Anastasiy's Extension Manager: https://install.anastasiy.com/
2. Open the installer and drag the `.zxp` onto it.
3. Restart Premiere Pro.
4. **Window ▸ Extensions ▸ SoundSyncPro**.

ffmpeg is included in the package. On first open the panel copies it into your
user folder (`%LOCALAPPDATA%\SoundSyncPro` on Windows,
`~/Library/Application Support/SoundSyncPro` on Mac).

## Using it

- **Project clips**: import your camera clips and recorder files into the
  project as usual, then press **Analyse & match**. Or switch to **Folders**
  and point it at a video folder and an audio folder.
- Each matched pair shows a confidence % and the offset. Untick anything you
  don't want, then **Create sequences**. Sequences land in a `Synced` bin with
  the recorder audio on its own track and the camera scratch audio muted.
- Camera clips and recorder files stay separate media. The sequences are the
  sync; nothing is re-encoded.
- Blank panel after install? Known Adobe quirk: run Premiere once as
  Administrator (Windows) or from an admin account (Mac), open the panel, then
  go back to normal.
- Mac: the bundled ffmpeg is native on both Apple Silicon and Intel. No Rosetta needed.

## Uninstall

Remove it with the same ZXP installer, or delete the extension folder:

- Windows: `%APPDATA%\Adobe\CEP\extensions\com.gregk.soundsyncpro` or
  `C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\com.gregk.soundsyncpro`
- Mac: `~/Library/Application Support/Adobe/CEP/extensions/com.gregk.soundsyncpro`
  or `/Library/Application Support/Adobe/CEP/extensions/com.gregk.soundsyncpro`
