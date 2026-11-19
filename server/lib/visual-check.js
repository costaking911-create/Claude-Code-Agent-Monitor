/**
 * @file visual-check.js
 * @description Optional visual step of a verification ("Verified"): after the tests pass, the
 * clean copy of the project is served (by a tiny built-in static server, or by the project's own
 * `serveCmd` on a free `PORT`), opened in a headless Chrome/Edge at phone size through the
 * DevTools protocol, and judged by what the page actually shows — not by what the agent said:
 *   - no uncaught exception, console error or failed load on the page,
 *   - the screenshot is not blank (a single colour),
 *   - an optional `readyExpr` (JavaScript evaluated in the page) is truthy.
 * The screenshot is saved next to the verification log. Nothing is installed: an existing Chrome
 * or Edge is used (`DASHBOARD_BROWSER` overrides the path); without one the step reports an error.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const zlib = require("zlib");
const { spawn } = require("child_process");
const WebSocket = require("ws");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".mp3": "audio/mpeg",
  ".webmanifest": "application/manifest+json",
};

const MAX_ERRORS = 20;
const CDP_CALL_TIMEOUT_MS = 20000;

/** First existing Chrome/Edge executable, or null. */
function findBrowser(env = process.env) {
  const candidates = [];
  if (env.DASHBOARD_BROWSER) candidates.push(env.DASHBOARD_BROWSER);
  if (process.platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(Boolean);
    for (const r of roots) {
      candidates.push(path.join(r, "Google", "Chrome", "Application", "chrome.exe"));
      candidates.push(path.join(r, "Microsoft", "Edge", "Application", "msedge.exe"));
    }
  } else if (process.platform === "darwin") {
    candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    candidates.push("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
    candidates.push("/Applications/Chromium.app/Contents/MacOS/Chromium");
  } else {
    for (const n of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
      for (const d of ["/usr/bin", "/usr/local/bin", "/snap/bin"]) candidates.push(path.join(d, n));
    }
  }
  return candidates.find((c) => c && fs.existsSync(c)) || null;
}

/** Serve `root` read-only on 127.0.0.1 (random port). Resolves { server, port }. */
function startStaticServer(root) {
  const base = path.resolve(root);
  const server = http.createServer((req, res) => {
    let rel;
    try {
      rel = decodeURIComponent(String(req.url || "/").split("?")[0]);
    } catch {
      res.writeHead(400);
      return res.end();
    }
    // A NUL byte would make fs throw synchronously, outside any callback.
    if (rel.includes("\0")) {
      res.writeHead(400);
      return res.end();
    }
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.resolve(base, "." + rel);
    if (file !== base && !file.startsWith(base + path.sep)) {
      res.writeHead(403);
      return res.end();
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end("Not found");
      }
      res.writeHead(200, {
        "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      res.end(data);
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

/** A free TCP port on 127.0.0.1. */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until `url` answers any HTTP status. */
async function waitForHttp(url, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const ok = await new Promise((resolve) => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve(true);
      });
      req.on("error", () => resolve(false));
      req.setTimeout(2000, () => {
        req.destroy();
        resolve(false);
      });
    });
    if (ok) return true;
    await sleep(300);
  }
  return false;
}

/** GET JSON from the browser's DevTools endpoint. */
function getJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject)
      .setTimeout(10000, function onTimeout() {
        this.destroy(new Error("browser did not answer"));
      });
  });
}

/** Minimal DevTools protocol client over one page WebSocket. */
function connectCdp(wsUrl, callTimeoutMs = CDP_CALL_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    let next = 0;
    const pending = new Map();
    const listeners = new Set();
    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg.id != null && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message || "CDP error"));
        else res(msg.result || {});
      } else if (msg.method) {
        for (const fn of listeners) fn(msg);
      }
    });
    ws.on("close", () => {
      for (const { rej } of pending.values()) rej(new Error("browser connection closed"));
      pending.clear();
    });
    ws.once("error", reject);
    ws.once("open", () =>
      resolve({
        // Every call has its own time limit: a page that blocks its main thread never answers.
        send(method, params = {}, timeoutMs = callTimeoutMs) {
          const id = ++next;
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              rej(new Error(`browser did not answer ${method}`));
            }, timeoutMs);
            pending.set(id, {
              res: (v) => {
                clearTimeout(timer);
                res(v);
              },
              rej: (e) => {
                clearTimeout(timer);
                rej(e);
              },
            });
            try {
              ws.send(JSON.stringify({ id, method, params }));
            } catch (e) {
              pending.get(id)?.rej(e);
              pending.delete(id);
            }
          });
        },
        on(fn) {
          listeners.add(fn);
        },
        close() {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        },
      })
    );
  });
}

/**
 * Decode an 8-bit RGB/RGBA (non-interlaced) PNG into raw pixels. Enough for the screenshots
 * Chrome produces; returns null for anything else.
 * @param {Buffer} buf
 * @returns {{ width: number, height: number, channels: number, data: Buffer } | null}
 */
function decodePng(buf) {
  if (!buf || buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  let off = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const color = body[9];
      const interlace = body[12];
      if (depth !== 8 || interlace !== 0) return null;
      channels = color === 6 ? 4 : color === 2 ? 3 : 0;
      if (!channels) return null;
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }
  if (!width || !height) return null;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

/**
 * How much the picture varies: the share of sampled pixels that differ clearly from the most
 * common colour. A blank or single-colour page gives ~0.
 * @param {Buffer} png
 * @returns {number|null} 0..1, or null when the image cannot be read.
 */
function pngVariety(png) {
  const img = decodePng(png);
  if (!img) return null;
  const { width, height, channels, data } = img;
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 20000)));
  const counts = new Map();
  const samples = [];
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * channels;
      const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
      counts.set(key, (counts.get(key) || 0) + 1);
      samples.push(key);
    }
  }
  let top = 0;
  for (const n of counts.values()) top = Math.max(top, n);
  return samples.length ? 1 - top / samples.length : null;
}

/**
 * Run the visual check on an extracted copy.
 * @param {object} o
 * @param {string} o.dir - The clean copy.
 * @param {{ serveCmd?: string, path?: string, url?: string, waitMs?: number, readyExpr?: string,
 *   width?: number, height?: number, minVariety?: number }} o.visual - From verify.json.
 * @param {string} o.screenshotPath - Where to save the PNG.
 * @param {number} o.timeoutMs - Overall limit.
 * @param {(s: string) => void} o.write - Log writer (already masks secrets).
 * @param {{ shell: { file: string, args: string[] }, killTree: (c: any) => void,
 *   env: Record<string, string> }} o.proc - Process helpers from the runner.
 * @param {string|null} [o.browser] - Browser executable (default: findBrowser()).
 * @param {number} [o.cdpTimeoutMs] - Limit for each browser call (default 20 s).
 * @param {string} [o.profileDir] - Throwaway browser profile (default: inside the copy).
 * @returns {Promise<{ ok: boolean, reason: string|null, errors: string[], variety: number|null,
 *   screenshot: boolean }>}
 */
async function runVisualCheck(o) {
  const v = o.visual || {};
  const errors = [];
  const cleanups = [];
  const exits = [];
  const until = Date.now() + o.timeoutMs;
  const left = () => Math.max(1000, until - Date.now());
  let screenshot = false;
  let variety = null;
  const result = (ok, reason) => ({ ok, reason, errors, variety, screenshot });
  try {
    const browser = o.browser === undefined ? findBrowser() : o.browser;
    if (!browser) return result(false, "visual check: no Chrome or Edge found");

    // 1. Serve the clean copy.
    let pageUrl;
    if (v.serveCmd) {
      const port = await freePort();
      const child = spawn(o.proc.shell.file, [...o.proc.shell.args, v.serveCmd], {
        cwd: o.dir,
        env: { ...o.proc.env, PORT: String(port) },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      });
      let out = "";
      const grab = (c) => {
        if (out.length < 20000) out += String(c);
      };
      child.stdout.on("data", grab);
      child.stderr.on("data", grab);
      exits.push(exitOf(child));
      cleanups.push(() => o.proc.killTree(child));
      pageUrl = String(v.url || `http://127.0.0.1:{port}${v.path || "/"}`).replace(
        /\{port\}/g,
        String(port)
      );
      o.write(`$ ${v.serveCmd}   (PORT=${port})\n`);
      if (!(await waitForHttp(pageUrl, Math.min(60000, left())))) {
        o.write(out.slice(-4000));
        return result(false, "visual check: the app did not start");
      }
    } else {
      const { server, port } = await startStaticServer(o.dir);
      cleanups.push(() => server.close());
      pageUrl = `http://127.0.0.1:${port}${v.path || "/"}`;
    }
    o.write(`# opening ${pageUrl.replace(/:\d+/, ":<port>")} at phone size\n`);

    // 2. Start a headless browser with a throwaway profile inside the copy.
    const profile = o.profileDir || path.join(o.dir, ".ccam-browser");
    fs.mkdirSync(profile, { recursive: true });
    const bp = spawn(
      browser,
      [
        "--headless=new",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        "--disable-component-update",
        "--mute-audio",
        "--enable-unsafe-swiftshader",
        "--use-angle=swiftshader",
        "about:blank",
      ],
      { stdio: "ignore", windowsHide: true, detached: process.platform !== "win32" }
    );
    exits.push(exitOf(bp));
    cleanups.push(() => o.proc.killTree(bp));
    const portFile = path.join(profile, "DevToolsActivePort");
    let devPort = null;
    for (let i = 0; i < 100 && !devPort; i++) {
      try {
        devPort = Number(fs.readFileSync(portFile, "utf8").split(/\r?\n/)[0]) || null;
      } catch {
        devPort = null;
      }
      // The file can exist before Chrome has written the port into it.
      if (!devPort) await sleep(200);
    }
    if (!devPort) return result(false, "visual check: the browser did not start");
    const targets = await getJson(`http://127.0.0.1:${devPort}/json/list`);
    const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (!page) return result(false, "visual check: no browser page");
    const cdp = await connectCdp(page.webSocketDebuggerUrl, o.cdpTimeoutMs);
    cleanups.push(() => cdp.close());

    let loaded = false;
    cdp.on((msg) => {
      const p = msg.params || {};
      if (msg.method === "Page.loadEventFired") loaded = true;
      else if (msg.method === "Runtime.exceptionThrown") {
        const d = p.exceptionDetails || {};
        errors.push(
          `exception: ${(d.exception && d.exception.description) || d.text || "error"}`.slice(
            0,
            500
          )
        );
      } else if (msg.method === "Runtime.consoleAPICalled" && p.type === "error") {
        const text = (p.args || [])
          .map((a) => (a.value !== undefined ? String(a.value) : a.description || ""))
          .join(" ");
        errors.push(`console.error: ${text}`.slice(0, 500));
      } else if (
        msg.method === "Log.entryAdded" &&
        p.entry &&
        p.entry.level === "error" &&
        // The browser asks for /favicon.ico on its own; a missing one is not the app's error.
        !/\/favicon\.ico(\?|$)/.test(p.entry.url || "")
      ) {
        errors.push(
          `${p.entry.source || "log"}: ${p.entry.text} ${p.entry.url || ""}`.slice(0, 500)
        );
      }
    });
    const width = Math.round(v.width || 390);
    const height = Math.round(v.height || 844);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await cdp.send("Page.navigate", { url: pageUrl });
    for (let i = 0; i < 300 && !loaded && Date.now() < until; i++) await sleep(100);
    if (!loaded) return result(false, "visual check: the page did not finish loading");
    // Let the app draw (3D scenes, fonts, first data load). With a readyExpr, wait until it is
    // true (at most waitMs) and then a moment more; without one, wait waitMs.
    const waitMs = Math.min(Math.max(0, Number(v.waitMs) || 5000), left());
    let readyOk = true;
    if (v.readyExpr) {
      const check = async () => {
        try {
          const r = await cdp.send("Runtime.evaluate", {
            expression: `(() => { try { return !!(${v.readyExpr}); } catch (e) { return false; } })()`,
            returnByValue: true,
          });
          return Boolean(r.result && r.result.value);
        } catch {
          return false;
        }
      };
      const stop = Date.now() + waitMs;
      readyOk = await check();
      while (!readyOk && Date.now() < stop) {
        await sleep(500);
        readyOk = await check();
      }
      if (readyOk) await sleep(1500);
    } else {
      await sleep(waitMs);
    }

    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    const png = Buffer.from(shot.data || "", "base64");
    if (png.length) {
      fs.writeFileSync(o.screenshotPath, png);
      screenshot = true;
    }
    variety = pngVariety(png);

    errors.splice(MAX_ERRORS);
    for (const e of errors) o.write(`  ✗ ${e}\n`);
    o.write(
      `# screenshot: ${screenshot ? "saved" : "missing"}, variety ${
        variety == null ? "?" : variety.toFixed(3)
      }, page errors: ${errors.length}${v.readyExpr ? `, ready check: ${readyOk ? "yes" : "no"}` : ""}\n`
    );
    const minVariety = Number.isFinite(v.minVariety) ? v.minVariety : 0.01;
    if (errors.length) return result(false, `visual check: ${errors.length} error(s) on the page`);
    if (variety == null || variety < minVariety)
      return result(false, "visual check: the screen is blank");
    if (!readyOk) return result(false, "visual check: the page is not ready (readyExpr)");
    return result(true, null);
  } catch (e) {
    return result(false, `visual check: ${String((e && e.message) || e).slice(0, 200)}`);
  } finally {
    for (const fn of cleanups.reverse()) {
      try {
        fn();
      } catch {
        /* best effort */
      }
    }
    // Wait until the browser and the app server have really exited (they hold files in the copy,
    // which the runner deletes next), then a moment more for their helper processes.
    await Promise.race([Promise.all(exits), sleep(15000)]);
    await sleep(1000);
  }
}

/** Resolves when a child process has exited (or failed to start). */
function exitOf(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
}

module.exports = { runVisualCheck, findBrowser, startStaticServer, decodePng, pngVariety };
