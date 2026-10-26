// The person on camera: one Chromium page on the box with a visible, smoothly moving cursor.
// Adapted from the DonkeyBox demo rig. Keys are macOS ones: Chromium on a Mac makes code-server bind Cmd.
import { chromium } from "@playwright/test";
import { W, H, SCALE } from "./camera.mjs";

export const BOX = process.env.OPHAN_DEMO_URL ?? "http://127.0.0.1:8091";
export const WORKSPACE = "/home/coder/acme-api";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A real 1.25x screen rather than an emulated one, so text is drawn at its true size.
export const launch = () => chromium.launch({ args: [`--force-device-scale-factor=${SCALE}`, `--window-size=${W},${H}`] });

// The page doesn't draw the OS cursor, so the recorded person gets one.
const CURSOR = () => {
  if (window.top !== window) return;
  const make = () => {
    if (document.getElementById("demo-cursor")) return;
    const c = document.createElement("div");
    c.id = "demo-cursor";
    c.innerHTML =
      '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M5 3l14 8-6.2 1.6L9.6 19z" fill="#f5f5f5" stroke="#0a0a0a" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    Object.assign(c.style, { position: "fixed", left: "0", top: "0", zIndex: "2147483647", pointerEvents: "none", transform: "translate(-80px,-80px)", willChange: "transform" });
    document.documentElement.appendChild(c);
  };
  document.readyState === "loading" ? addEventListener("DOMContentLoaded", make) : make();
  window.__demoCursor = (x, y, ms) => {
    make();
    const c = document.getElementById("demo-cursor");
    c.style.transition = `transform ${ms}ms cubic-bezier(.25,.8,.25,1)`;
    c.style.transform = `translate(${x - 5}px,${y - 3}px)`;
  };
  window.__demoPress = () => {
    document.getElementById("demo-cursor")?.animate([{ scale: "1" }, { scale: "0.82" }, { scale: "1" }], { duration: 220 });
  };
};

export class Person {
  constructor(page) {
    this.page = page;
    this.x = W / 2;
    this.y = H / 2;
  }

  static async open(browser) {
    const ctx = await browser.newContext({ viewport: null, colorScheme: "dark", reducedMotion: "no-preference" });
    await ctx.addInitScript(CURSOR);
    return new Person(await ctx.newPage());
  }

  /** Loads the workbench and waits until Ophan has decorated the editor area. */
  async load() {
    await this.page.goto(`${BOX}/?folder=${WORKSPACE}`);
    await this.page.getByRole("treeitem", { name: "src" }).waitFor({ timeout: 60000 });
    await sleep(4000);
    await this.dismissNotifications();
  }

  async dismissNotifications() {
    for (const close of await this.page.locator(".notification-toast .codicon-notifications-clear, .notification-toast .codicon-close").all()) {
      await close.click().catch(() => {});
    }
  }

  async glide(x, y, ms = 700) {
    await this.page.evaluate(([a, b, t]) => window.__demoCursor?.(a, b, t), [x, y, ms]);
    const [x0, y0] = [this.x, this.y];
    const t0 = Date.now();
    for (;;) {
      const k = Math.min(1, (Date.now() - t0) / ms);
      const e = 1 - Math.pow(1 - k, 3);
      await this.page.mouse.move(x0 + (x - x0) * e, y0 + (y - y0) * e);
      if (k >= 1) break;
      await sleep(30);
    }
    this.x = x;
    this.y = y;
  }

  async box(locator) {
    await locator.waitFor({ state: "visible", timeout: 30000 });
    return locator.boundingBox();
  }

  async hover(locator, { ms = 700, dx = 0.5, dy = 0.5 } = {}) {
    const b = await this.box(locator);
    await this.glide(b.x + b.width * dx, b.y + b.height * dy, ms);
  }

  async click(locator, { ms = 700, dx = 0.5, dy = 0.5, pause = 250 } = {}) {
    await this.hover(locator, { ms, dx, dy });
    await sleep(pause);
    await this.page.evaluate(() => window.__demoPress?.());
    await this.page.mouse.click(this.x, this.y);
  }

  /** Moves the cursor somewhere neutral so it doesn't hover anything. */
  async rest(x = W - 60, y = H - 120, ms = 600) {
    await this.glide(x, y, ms);
  }

  async type(text, { delay = 45 } = {}) {
    for (const ch of text) {
      await this.page.keyboard.type(ch);
      await sleep(delay * (0.6 + Math.random() * 0.8));
    }
  }

  async command(name) {
    await this.page.keyboard.press("Meta+Shift+P");
    await sleep(500);
    await this.type(name, { delay: 35 });
    await sleep(500);
    await this.page.keyboard.press("Enter");
  }

  /** Opens a file from the explorer, expanding folders on the way. */
  async openFile(path) {
    const parts = path.split("/");
    for (const [i, name] of parts.entries()) {
      const item = this.page.getByRole("treeitem", { name, exact: true }).first();
      const last = i === parts.length - 1;
      if (!last && (await item.getAttribute("aria-expanded")) === "true") continue;
      await this.click(item, { ms: 500, dx: 0.2, pause: 150 });
      await sleep(last ? 1500 : 400);
    }
  }

  /** The editor text for one line, e.g. to hover a name on it. */
  lineToken(text) {
    return this.page.locator(".monaco-editor .view-line span", { hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }).first();
  }

  /** The Ophan panel's React app (a webview: two nested iframes). */
  get panel() {
    return this.page.frameLocator("iframe.webview.ready").frameLocator("iframe#active-frame");
  }

  async panelNav(label) {
    await this.click(this.panel.getByLabel("Open navigation menu"), { ms: 600 });
    await sleep(700);
    await this.click(this.panel.getByRole("dialog").getByText(label, { exact: true }), { ms: 600 });
    await sleep(1500);
  }

  async close() {
    await this.page.context().close();
  }
}
