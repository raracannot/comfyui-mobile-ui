/* Minimal Chrome DevTools Protocol driver - no dependencies.
 * The browser_* tools need the bsk CLI, which is not installed here, so tests
 * drive a headless Chrome directly instead.
 */

export async function connect(port = 9222) {
  let list = null;
  for (let i = 0; i < 40; i++) {
    try {
      list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      if (list.length) break;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!list || !list.length) throw new Error("no debug target on " + port);
  const page = list.find((t) => t.type === "page") || list[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws error")); });

  let seq = 0;
  const pending = new Map();
  const consoleLines = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) rej(new Error(m.error.message + " " + JSON.stringify(m.error.data || "")));
      else res(m.result);
      return;
    }
    if (m.method === "Page.javascriptDialogOpening") {
      // The page asks before unloading with unsaved edits; a native dialog
      // blocks every later Runtime.evaluate, so dismiss it here.
      ws.send(JSON.stringify({ id: ++seq, method: "Page.handleJavaScriptDialog", params: { accept: true } }));
      consoleLines.push("DIALOG: " + m.params.message);
    }
    if (m.method === "Runtime.consoleAPICalled") {
      consoleLines.push((m.params.args || []).map((a) => a.value ?? a.description ?? "").join(" "));
    }
    if (m.method === "Runtime.exceptionThrown") {
      consoleLines.push("EXCEPTION: " + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    }
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++seq;
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Console.enable").catch(() => {});

  const api = {
    send,
    consoleLines,
    async viewport(w, h, dsf = 2) {
      await send("Emulation.setDeviceMetricsOverride", {
        width: w, height: h, deviceScaleFactor: dsf, mobile: true,
      });
      await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    },
    async goto(url) {
      await send("Page.navigate", { url });
      await new Promise((r) => setTimeout(r, 600));
    },
    async eval(expression) {
      const r = await send("Runtime.evaluate", {
        expression, awaitPromise: true, returnByValue: true, userGesture: true,
      });
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      }
      return r.result.value;
    },
    async waitFor(expression, timeout = 15000) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        try { if (await api.eval(expression)) return true; } catch (_) {}
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error("timeout waiting for: " + expression);
    },
    async tap(x, y) {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
      await new Promise((r) => setTimeout(r, 60));
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
      await new Promise((r) => setTimeout(r, 120));
    },
    /* Real touch, not a synthesised mouse: this is what the phone actually sends
     * and it takes different paths through the browser's gesture handling. */
    async touchTap(x, y, holdMs = 70) {
      await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, radiusX: 8, radiusY: 8, force: 1 }] });
      await new Promise((r) => setTimeout(r, holdMs));
      await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await new Promise((r) => setTimeout(r, 200));
    },
    async touchDrag(x1, y1, x2, y2, steps = 10) {
      await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x1, y: y1, radiusX: 8, radiusY: 8, force: 1 }] });
      for (let i = 1; i <= steps; i++) {
        await send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: x1 + ((x2 - x1) * i) / steps, y: y1 + ((y2 - y1) * i) / steps, radiusX: 8, radiusY: 8, force: 1 }],
        });
        await new Promise((r) => setTimeout(r, 18));
      }
      await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await new Promise((r) => setTimeout(r, 200));
    },
    async drag(x1, y1, x2, y2, steps = 8) {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x1, y: y1, buttons: 0 });
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: x1, y: y1, button: "left", buttons: 1, clickCount: 1 });
      for (let i = 1; i <= steps; i++) {
        const x = x1 + ((x2 - x1) * i) / steps;
        const y = y1 + ((y2 - y1) * i) / steps;
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
        await new Promise((r) => setTimeout(r, 16));
      }
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x2, y: y2, button: "left", buttons: 0, clickCount: 1 });
      await new Promise((r) => setTimeout(r, 150));
    },
    async shot(path) {
      const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      const fs = await import("node:fs");
      const pathMod = await import("node:path");
      fs.mkdirSync(pathMod.dirname(pathMod.resolve(path)), { recursive: true });
      fs.writeFileSync(path, Buffer.from(r.data, "base64"));
      return path;
    },
  };
  return api;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
