// The README clips. Each has a setup (not recorded), and a shoot that marks moments on the camera
// and returns how to cut them: segments [from, to, speed] and the poster mark.
import { readFileSync } from "node:fs";
import { sleep } from "./person.mjs";

const fix = JSON.parse(readFileSync(new URL("../fix.json", import.meta.url), "utf8"));
const squiggles = (p) => p.page.locator(".monaco-editor .squiggly-error, .monaco-editor .squiggly-warning");
const hoverWidget = (p) => p.page.locator(".monaco-hover:not(.hidden)").first();

/** Waits for a locator count to satisfy a test, polling. */
async function until(fn, timeout = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await fn()) return;
    await sleep(250);
  }
  throw new Error("timed out");
}

export const clips = {
  // Analyze an unanalyzed workspace: Command Palette, progress, squiggles appear.
  "01-analyze": {
    db: "empty",
    async setup(p) {
      await p.openFile("src/routes/users.ts");
      await p.rest();
    },
    async shoot(p, cam) {
      await sleep(1200);
      await p.command("Ophan: Analyze Now");
      cam.mark("running");
      await until(async () => (await squiggles(p).count()) > 0, 240000);
      cam.mark("found");
      await sleep(2000);
      await p.openFile("src/render.ts");
      await sleep(3000);
      return { segments: [["start", "running", 1], ["running", "found", 6], ["found", "end", 1]], poster: "end" };
    },
  },

  // Hover the SQL injection, then the Problems panel.
  "02-findings": {
    db: "cache",
    async setup(p) {
      await p.openFile("src/routes/users.ts");
      await p.rest();
    },
    async shoot(p, cam) {
      await sleep(1000);
      await p.hover(squiggles(p).first(), { ms: 900, dx: 0.45 });
      await hoverWidget(p).waitFor({ timeout: 10000 });
      cam.mark("hover");
      await sleep(4500);
      await p.rest();
      await sleep(500);
      await p.page.keyboard.press("Meta+Shift+M");
      cam.mark("problems");
      await sleep(3500);
      return { segments: [["start", "end", 1]], poster: "hover" };
    },
  },

  // Fix the query; the squiggle goes as you type and stays gone after re-analysis.
  "03-fix": {
    db: "cache",
    async setup(p) {
      await p.openFile(fix.file);
      await p.rest();
    },
    async shoot(p, cam) {
      await sleep(1500);
      const [first, second] = fix.lines;
      const line = p.page.locator(".monaco-editor .view-line", { hasText: first.from.trim().slice(0, 30) }).first();
      // The line element runs past the viewport; click on the text, then go to its end.
      await p.click(line, { ms: 900, dx: 0.35 });
      await p.page.keyboard.press("End");
      await p.page.keyboard.press("Shift+Home");
      await sleep(400);
      cam.mark("typing");
      await p.type(first.to.trim(), { delay: 38 });
      await p.page.keyboard.press("ArrowDown");
      await p.page.keyboard.press("End");
      await p.page.keyboard.press("Shift+Home");
      await p.type(second.to.trim(), { delay: 38 });
      cam.mark("typed");
      await sleep(600);
      await p.page.keyboard.press("Meta+s");
      cam.mark("saved");
      await p.rest();
      // Watch mode re-analyzes the saved file (about 5 s debounce); the fixed function's result is cached.
      await sleep(9000);
      if ((await squiggles(p).count()) !== 0) throw new Error("squiggle came back after the fix");
      return { segments: [["start", "end", 1]], poster: "end" };
    },
  },

  // Data flow: open a function's detail from its CodeLens.
  "04-dataflow": {
    db: "cache",
    async setup(p) {
      await p.openFile("src/auth.ts");
      await p.rest();
    },
    async shoot(p, cam) {
      await sleep(1000);
      const lens = p.page.locator(".codelens-decoration a", { hasText: "details" }).first();
      await p.click(lens, { ms: 900 });
      await p.panel.getByText("Data flow", { exact: false }).first().waitFor({ timeout: 15000 });
      cam.mark("detail");
      await sleep(1200);
      await p.hover(p.panel.getByText("credentials", { exact: true }).first(), { ms: 900 });
      await sleep(1500);
      // The first finding on login (its exact wording is Claude's, so match loosely)
      await p.hover(p.panel.getByText(/plaintext password/i).first(), { ms: 900 });
      await sleep(3000);
      return { segments: [["start", "end", 1]], poster: "detail" };
    },
  },

  // Function docs: hover a function name, then another.
  "05-docs": {
    db: "cache",
    async setup(p) {
      await p.openFile("src/payments.ts");
      await p.rest();
    },
    async shoot(p, cam) {
      await sleep(1000);
      await p.hover(p.lineToken("chargeCustomer"), { ms: 900 });
      await hoverWidget(p).waitFor({ timeout: 10000 });
      cam.mark("hover");
      await sleep(4500);
      await p.rest(700, 720);
      await sleep(400);
      await p.hover(p.lineToken("formatCurrency"), { ms: 900 });
      await hoverWidget(p).waitFor({ timeout: 10000 });
      await sleep(3500);
      return { segments: [["start", "end", 1]], poster: "hover" };
    },
  },

  // The panel: the security dashboard, then the generated architecture docs.
  "06-dashboard": {
    db: "cache",
    async setup(p) {
      await p.command("View: Close All Editors");
      await sleep(500);
      await p.page.keyboard.press("Meta+b"); // hide the sidebar for a wide panel
      await sleep(500);
      await p.page.keyboard.press("Escape");
      await sleep(800);
      await p.rest();
    },
    async shoot(p, cam) {
      await sleep(800);
      await p.command("Ophan: Open");
      await p.panel.getByText("Top issues", { exact: false }).first().waitFor({ timeout: 20000 });
      cam.mark("dashboard");
      await sleep(2500);
      await p.hover(p.panel.getByText(/SQL injection/i).nth(1), { ms: 900 });
      await p.page.mouse.wheel(0, 500);
      await sleep(2000);
      await p.panelNav("Architecture Docs");
      cam.mark("architecture");
      await sleep(1500);
      await p.hover(p.panel.locator("h2").first(), { ms: 700 });
      await p.page.mouse.wheel(0, 420);
      await sleep(2500);
      await sleep(1000);
      return { segments: [["start", "end", 1]], poster: "dashboard" };
    },
  },

  // The CLI in the integrated terminal: everything cached, so a re-run is instant and free.
  "07-cli": {
    db: "cache",
    async setup(p) {
      await p.command("View: Close All Editors");
      await sleep(400);
      await p.command("Terminal: Create New Terminal");
      await sleep(2500);
      await p.command("View: Toggle Maximized Panel");
      await sleep(800);
      await p.page.keyboard.type("clear");
      await p.page.keyboard.press("Enter");
      await sleep(800);
      await p.rest();
    },
    async shoot(p, cam) {
      await sleep(800);
      await p.type("npx @ophan/cli analyze", { delay: 55 });
      await p.page.keyboard.press("Enter");
      cam.mark("run");
      await sleep(5500);
      return { segments: [["start", "run", 1.4], ["run", "end", 1]], poster: "end" };
    },
  },
};

// The hero: the best moments of the clips back to back, a little faster.
export const hero = [
  ["01-analyze", "running", "found", 9],
  ["01-analyze", "found", "end", 1.3],
  ["02-findings", "hover", "problems", 1.2],
  ["03-fix", "typing", "end", 1.5],
  ["05-docs", "hover", "end", 1.4],
  ["06-dashboard", "dashboard", "end", 1.5],
];
