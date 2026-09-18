---
description: "Built-in ClawMaster Voice: offline Whisper dictation with speaker separation, feeding the built-in notes vault."
kind: "package-bundle"
---

# ClawMaster Voice

English | [中文](README.zh.md)

## Summary

This desktop bundle records a meeting through the Sidebar, transcribes it offline with Whisper, separates the speakers, and keeps a timeline the built-in notes vault can be derived from. It needs no cloud service, no API key and no third-party app. Audio never reaches the disk: only one line of text per recognized turn does.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Open the Voice tab in the Sidebar, name the meeting, and press Start recording. The first press asks macOS for microphone access. The panel shows the level, the speakers it has separated, and each recognized turn with its timecode and speaker.

Rename a speaker as soon as you know who they are: the rename follows every turn already recorded, because the note is derived from the timeline rather than edited in place. Use the arrow button to merge two labels when clustering split one person in two. "Remember this voice" stores a voiceprint under a name so later meetings recognize that person without being told.

Press Stop recording to release the microphone and close the final sentence. The transcript stays readable in the panel and in the timeline file.

Then ask the agent to write the meeting up, or let it decide to. The `voice_writeup` tool composes `录音/<date> <title>.md` from the recording's own timeline — every turn with its speaker and timecode — and appends one line to the day's journal that links to it, so the meeting is reachable from the day it happened. Because the note is derived, renaming a speaker and writing up again corrects the note instead of editing it, and a paragraph you added under the note's `<!-- clawmaster-voice:body -->` marker survives every rewrite. That write goes into the notes vault, so it asks for a one-shot approval.

The component writes one append-only timeline per meeting at `<vault>/.clawmaster/voice/<sessionId>.jsonl`. Nothing else in the vault changes until a write-up is made.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation and contributor checks — click to expand</summary>

The panel owns the microphone and the sentence boundaries; the Host owns recognition, attribution and durability. That split exists because only the client can reach the device, and only the Host can load a model once instead of per turn.

Codec and endpointing are pure functions with no dependencies (`wav.ts`, `endpointer.ts`), so both halves share them and both are testable without a device. Endpointing is energy-based with a calibrated noise floor rather than a neural VAD: it costs nothing, never blocks the audio thread, and its two parameters are the two a user can judge when a room is noisy.

Attribution is a cosine-distance clustering of per-turn speaker embeddings, plus a voiceprint book that outlives the meeting. A name only ever comes from a human decision — a rename, or a match against an enrolled voiceprint — so a wrong attribution stays visible and correctable instead of silently plausible.

The engine is `sherpa-onnx-node` (Apache-2.0), an optional native dependency with prebuilt macOS arm64 binaries. Models are not bundled: they are large, so they live in `~/.clawmaster/components/voice/models` and the component reports precisely what is missing when they are absent. `scripts/fetch-models.mjs` downloads them from the mirrors measured to work, checking size and sha256 after every fetch because one of those mirrors truncates large files while still answering HTTP 200.

Three environment variables are honoured:

| Variable | Effect |
|---|---|
| `CLAWMASTER_VOICE_MODELS` | Where the models live, when they are not under the home directory. |
| `CLAWMASTER_VOICE_ENGINE` | A module exporting `createEngine(options)` that replaces the engine entirely. |
| `CLAWMASTER_VOICE_ENGINE` | (also how the Host tests run without a model) |

The write-up goes through the notes plugin's published access handle (`ctx.get('clawmasterNotes')`) rather than the filesystem, so the vault keeps a single writer with one revision chain; when the notes component is not loaded, the tool says so instead of writing anything.

```sh
npm install --include=dev --prefix frontends/voice
node frontends/voice/scripts/build.mjs
node frontends/voice/scripts/build.mjs --check
npm test --prefix frontends/voice
```

Both halves are bundled with esbuild: the host half as Node ESM with workspace packages external, the client half as CommonJS wrapped in `window.__ModuleLoader__.load`, exactly like the other product front ends. `--check` fails when a built artifact is stale, and the test suite includes a `node --check` pass over every `.mjs` file because the TypeScript loader otherwise hides a plain syntax error in a test.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- `src/host.ts` — the five authenticated routes and the two agent tools, plus disposal.
- `src/store.ts` — the append-only timeline and how renames and merges are replayed.
- `src/endpointer.ts` — where a sentence begins and ends, and the noise-floor calibration.
- `src/speakers.ts` — online clustering and the voiceprint book.
- `tests/` — 76 cases covering the codec, the timeline, clustering, the service and the Host.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- The meeting title is the only metadata the panel collects; project linking and the note write-up are the next stage.
- A recording in progress is lost if the application quits: the timeline keeps every turn already written, but the open sentence goes with the process.
- Speaker separation needs a few turns per person to settle, and a voiceprint is matched at a fixed threshold rather than being tuned per room.
- The microphone is captured through `ScriptProcessorNode`, which is deprecated in favour of an AudioWorklet; the worklet migration is deferred until the desktop's WebKit version is pinned.
