// Records a page as a sharp video: Chrome's screencast frames (JPEG, on every change) with timestamps,
// re-timed to 30 fps by ffmpeg. Marks name moments so a clip can be trimmed and sped up when encoded.
// Adapted from the DonkeyBox demo rig.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The page is 1280x800 at 1.25x, so frames are 1600x1000 with everything a quarter larger.
export const W = 1280;
export const H = 800;
export const SCALE = 1.25;
const FPS = 30;

export class Camera {
  constructor(page, dir) {
    this.page = page;
    this.dir = dir;
    this.frames = [];
    this.marks = {};
  }

  async start() {
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
    this.cdp = await this.page.context().newCDPSession(this.page);
    this.t0 = Date.now() / 1000;
    this.cdp.on("Page.screencastFrame", (f) => {
      const file = join(this.dir, `${String(this.frames.length).padStart(6, "0")}.jpg`);
      writeFileSync(file, Buffer.from(f.data, "base64"));
      this.frames.push({ t: f.metadata.timestamp - this.t0, file });
      this.cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
    });
    await this.cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: W * SCALE, maxHeight: H * SCALE, everyNthFrame: 1 });
    this.mark("start");
  }

  mark(name) {
    this.marks[name] = Date.now() / 1000 - this.t0;
    return this.marks[name];
  }

  async stop() {
    this.mark("end");
    await this.cdp.send("Page.stopScreencast").catch(() => {});
    await this.cdp.detach().catch(() => {});
    writeFileSync(join(this.dir, "frames.json"), JSON.stringify({ frames: this.frames, marks: this.marks }));
  }

  /** A camera from a recording on disk, to cut again without recording again. */
  static load(dir) {
    const cam = new Camera(null, dir);
    if (existsSync(join(dir, "frames.json"))) Object.assign(cam, JSON.parse(readFileSync(join(dir, "frames.json"), "utf8")));
    return cam;
  }

  at(m) {
    if (typeof m === "number") return m;
    if (!(m in this.marks)) throw new Error(`no mark "${m}" (have ${Object.keys(this.marks).join(", ")})`);
    return this.marks[m];
  }

  /** The frames to show for [from, to] at a speed, one per output frame. */
  frames30(from, to, speed = 1) {
    const out = [];
    let i = 0;
    for (let t = this.at(from); t < this.at(to); t += speed / FPS) {
      while (i + 1 < this.frames.length && this.frames[i + 1].t <= t) i++;
      out.push(this.frames[i].file);
    }
    return out;
  }

  still(mark) {
    let best = this.frames[0];
    for (const f of this.frames) if (f.t <= this.at(mark) - 0.05) best = f;
    return best.file;
  }

  /** Writes NAME.mp4 and NAME.jpg (poster). segments: [from, to, speed], from/to are marks or seconds. */
  encode(outDir, name, segments, poster) {
    const list = segments.flatMap(([a, b, speed]) => this.frames30(a, b, speed));
    return writeVideo(outDir, name, list, this.still(poster ?? segments.at(-1)[1]), this.dir);
  }
}

/** Encodes a list of frames (one per 1/30 s) as an H.264 mp4 plus a poster jpg. */
export function writeVideo(outDir, name, list, poster, scratch) {
  const txt = join(scratch, `${name}.txt`);
  writeFileSync(txt, list.map((f) => `file '${f}'\nduration ${1 / FPS}`).join("\n") + `\nfile '${list.at(-1)}'\n`);
  mkdirSync(outDir, { recursive: true });
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", txt,
    "-vf", `fps=${FPS},format=yuv420p`, "-c:v", "libx264", "-preset", "slow", "-crf", "22",
    "-tune", "stillimage", "-movflags", "+faststart", "-an", join(outDir, `${name}.mp4`),
  ]);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", poster, "-q:v", "3", join(outDir, `${name}.jpg`)]);
  return { seconds: list.length / FPS };
}
