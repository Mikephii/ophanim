// Records the README clips from the demo box (demo/box.sh up first, with ANTHROPIC_API_KEY set).
//   node demo/record.mjs                 every clip, then the hero
//   node demo/record.mjs 03-fix 05-docs  just these (the hero needs all of its clips)
// Writes demo/out/clips/<clip>.{mp4,jpg}; raw frames go to demo/out/raw/<clip>/.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Camera, writeVideo } from "./rig/camera.mjs";
import { clips, hero } from "./rig/clips.mjs";
import { launch, Person } from "./rig/person.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "out", "clips");
const only = process.argv.slice(2);
const box = (...args) => execFileSync(join(here, "box.sh"), args, { stdio: "inherit" });

const browser = await launch();
const cams = {};
const report = {};
try {
  for (const [id, clip] of Object.entries(clips)) {
    if (only.length && !only.includes(id)) continue;
    process.stdout.write(`${id} … `);
    box("reset", clip.db);
    const p = await Person.open(browser);
    try {
      await p.load();
      await clip.setup(p);
      const cam = new Camera(p.page, join(here, "out", "raw", id));
      await cam.start();
      const { segments, poster } = await clip.shoot(p, cam);
      await cam.stop();
      const { seconds } = cam.encode(out, id, segments, poster);
      cams[id] = cam;
      report[id] = { seconds: Math.round(seconds * 10) / 10, marks: cam.marks };
      console.log(`${report[id].seconds}s`);
    } catch (e) {
      await p.page.screenshot({ path: join(out, `fail-${id}.png`) }).catch(() => {});
      throw e;
    } finally {
      await p.close();
    }
  }
  // Clips not recorded in this run come from their raw frames on disk.
  for (const [id] of hero) cams[id] ??= Camera.load(join(here, "out", "raw", id));
  if (hero.every(([id]) => cams[id].frames.length)) {
    const list = hero.flatMap(([id, from, to, speed]) => cams[id].frames30(from, to, speed));
    const { seconds } = writeVideo(out, "00-hero", list, cams["03-fix"].still("end"), join(here, "out", "raw"));
    report["00-hero"] = { seconds: Math.round(seconds * 10) / 10 };
    console.log(`00-hero … ${report["00-hero"].seconds}s`);
  }
} finally {
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
}
