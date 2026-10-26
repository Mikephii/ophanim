# Demo videos

The clips in the main README are recorded from a real VS Code (code-server in Docker) running this
checkout's extension and CLI against `sample-app/`, a small, deliberately vulnerable API with fake
secrets. Nothing is mocked: findings come from Claude. Analysis is cached by content hash, so every
clip except `01-analyze` replays the same results and a re-record looks the same.

## Record

Needs Docker, ffmpeg, Node 24, and an Anthropic API key (passed into the box at run time, never baked
into the image).

```sh
pnpm install
export ANTHROPIC_API_KEY=sk-ant-...
demo/prepare.sh            # build; package the CLI and a linux VSIX into demo/out/build
demo/box.sh build          # the image: code-server 4.141.1 + Node 24 + Ophan
demo/box.sh up             # http://127.0.0.1:8091
demo/box.sh analyze-cache  # analyze sample-app, its graph docs, and the fixed variant from fix.json
node demo/record.mjs       # every clip and the hero into demo/out/clips/
node demo/record.mjs 03-fix   # or just one
demo/box.sh down
```

## What is where

| Path | What |
|---|---|
| `sample-app/` | The fixture: SQL injection, XSS, `eval`, a hardcoded key, password logging, a shell-injection Python script, and some clean functions |
| `fix.json` | The on-camera fix in `03-fix`; `box.sh analyze-cache` analyzes the fixed text ahead of time so its hash is cached |
| `Dockerfile`, `box/settings.json` | The box: code-server, dark theme, editor settings that make typed text match the file exactly |
| `prepare.sh`, `box.sh` | Packaging, and the box's lifecycle |
| `rig/camera.mjs` | Chrome screencast frames re-timed to 30 fps and encoded with ffmpeg (adapted from the DonkeyBox rig) |
| `rig/person.mjs` | The browser, a visible smooth cursor, editor and panel helpers |
| `rig/clips.mjs` | Each clip's setup and shoot, and the cut of the hero |
| `record.mjs` | Runs the clips and writes `out/clips/*.mp4` and posters |
