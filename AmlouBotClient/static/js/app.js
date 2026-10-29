(() => {
  "use strict";

  const POLL_INTERVAL   = 900;
  const SERVO_DEBOUNCE  = 60;
  const SERVO_HOME      = [105, 180, 110, 60];
  const STOP_LATCH_MS   = 180;
  const LOG_LIMIT       = 200;
  const HOLD_MS         = 350;
  const JOY_DEADZONE    = 0.28;
  const MODE_KEY        = "amloubot.mode.v2";
  const THEME_KEY       = "amloubot.theme";
  const VALID_MODES     = new Set(["pad", "stick"]);
  const KIND_CHAR       = { tx: "→", rx: "←", err: "×", sys: "·" };
  const THEME_COLORS    = { light: "#ece3d0", dark: "#1a1612" };

  const dom = {
    body:          document.body,
    html:          document.documentElement,
    status:        document.getElementById("status"),
    statusText:    document.getElementById("statusText"),
    console:       document.getElementById("console"),
    clearLog:      document.getElementById("clearConsole"),
    downloadLog:   document.getElementById("downloadLog"),
    btnTheme:      document.getElementById("btnTheme"),
    btnFullscreen: document.getElementById("btnFullscreen"),
    servos:        [0, 1, 2, 3].map(i => document.getElementById(`s${i}`)),
    readouts:      [0, 1, 2, 3].map(i => document.getElementById(`v${i}`)),
    btnHome:       document.getElementById("btnHome"),
    btnSend:       document.getElementById("btnSend"),
    joystick:      document.getElementById("joystick"),
    modeBtns:      Array.from(document.querySelectorAll(".mode-btn")),
    keyCaps:       Object.fromEntries(
      Array.from(document.querySelectorAll("kbd[data-key]"))
        .map(k => [k.dataset.key, k])
    ),
  };

  const log = (kind, message) => {
    const time = new Date().toLocaleTimeString("en-GB", { hour12: false });

    const line = document.createElement("div");
    line.className = `line ${kind}`;

    const timeEl = document.createElement("span");
    timeEl.className = "line-time";
    timeEl.textContent = time;

    const msgEl = document.createElement("span");
    msgEl.className = "line-msg";
    msgEl.textContent = message;

    line.append(timeEl, msgEl);
    dom.console.appendChild(line);
    dom.console.scrollTop = dom.console.scrollHeight;

    while (dom.console.childElementCount > LOG_LIMIT) {
      dom.console.removeChild(dom.console.firstChild);
    }
  };

  dom.clearLog.addEventListener("click", () => {
    dom.console.innerHTML = "";
    log("sys", "console cleared");
  });

  const pad2 = (n) => String(n).padStart(2, "0");

  const downloadLog = () => {
    const rows = dom.console.querySelectorAll(".line");
    if (rows.length === 0) {
      log("sys", "nothing to save");
      return;
    }

    const text = Array.from(rows).map((line) => {
      const kind = Array.from(line.classList).find(c => c !== "line") || "sys";
      const time = line.querySelector(".line-time")?.textContent || "";
      const msg  = line.querySelector(".line-msg")?.textContent  || "";
      return `[${time}] ${KIND_CHAR[kind] || " "} ${msg}`;
    }).join("\n") + "\n";

    const d = new Date();
    const stamp =
      `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
      `-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
    const filename = `amloubot-log-${stamp}.txt`;

    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url  = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();

    setTimeout(() => URL.revokeObjectURL(url), 1000);
    log("sys", `log saved · ${rows.length} lines · ${filename}`);
  };

  dom.downloadLog.addEventListener("click", downloadLog);

  const setLink = (online) => {
    dom.status.classList.toggle("online", online);
    dom.statusText.textContent = online ? "Online" : "Offline";
  };

  async function send(cmd) {
    log("tx", cmd);
    try {
      const res = await fetch("/api/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cmd }),
      });
      const data = await res.json();
      if (!data.ok) log("err", `not delivered: ${cmd}`);
    } catch {
      log("err", `network error: ${cmd}`);
    }
  }

  const Movement = (() => {
    let current = null;
    let queued  = undefined;
    let inFlight = false;
    let heartbeat = null;

    const flush = async () => {
      if (inFlight) return;
      if (queued === undefined) return;

      const cmd = queued;
      queued = undefined;
      inFlight = true;

      try { await send(cmd === null ? "STOP" : cmd); }
      finally {
        inFlight = false;
        flush();
      }
    };

    const request = (cmd) => {
      queued = cmd;
      flush();
    };

    const beat = () => {
      if (current === null) return;
      request(current);
    };

    const set = (cmd) => {
      if (cmd === current) return;
      current = cmd;

      if (cmd === null) {
        if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
        request(null);
      } else {
        request(cmd);
        if (!heartbeat) heartbeat = setInterval(beat, HOLD_MS);
      }
    };

    return {
      set,
      get current() { return current; },
      cancel() {
        if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
        current = null;
        request(null);
      },
    };
  })();

  function bindMoveButton(el) {
    const cmd = el.dataset.cmd;
    let held = false;

    const press = (event) => {
      if (held) return;
      held = true;
      event.preventDefault();

      if (event.isTrusted && event.pointerId !== undefined) {
        try { el.setPointerCapture(event.pointerId); } catch {}
      }
      el.classList.add("active");
      Movement.set(cmd);
    };

    const release = () => {
      if (!held) return;
      held = false;
      el.classList.remove("active");
      Movement.set(null);
    };

    el.addEventListener("pointerdown", press);
    el.addEventListener("pointerup", release);
    el.addEventListener("pointercancel", release);
    el.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  function bindStopButton(el) {
    el.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      el.classList.add("active");
      Movement.set(null);
      send("STOP");
      setTimeout(() => el.classList.remove("active"), STOP_LATCH_MS);
    });
    el.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  document.querySelectorAll("[data-cmd]").forEach(el => {
    if (el.dataset.cmd === "STOP") bindStopButton(el);
    else bindMoveButton(el);
  });

  (function bindJoystick() {
    const stick = dom.joystick;
    if (!stick) return;
    const knob = stick.querySelector(".joystick-knob");

    let activePointerId = null;

    const setKnob = (dx, dy) => {
      knob.style.transform =
        `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    };

    const resetKnob = () => setKnob(0, 0);

    const setTickHints = (dir) => {
      stick.classList.remove("dir-n", "dir-s", "dir-w", "dir-e");
      if (!dir) return;
      if (dir.includes("F")) stick.classList.add("dir-n");
      if (dir.includes("B")) stick.classList.add("dir-s");
      if (dir.includes("L")) stick.classList.add("dir-w");
      if (dir.includes("R")) stick.classList.add("dir-e");
    };

    const dirFromVector = (dx, dy, mag, maxR) => {
      if (mag / maxR < JOY_DEADZONE) return null;

      const angle = Math.atan2(dy, dx) * 180 / Math.PI;

      if (angle >= -22.5  && angle <  22.5) return "R";
      if (angle >=  22.5  && angle <  67.5) return "BR";
      if (angle >=  67.5  && angle < 112.5) return "B";
      if (angle >= 112.5  && angle < 157.5) return "BL";
      if (angle >= 157.5  || angle < -157.5) return "L";
      if (angle >= -157.5 && angle < -112.5) return "FL";
      if (angle >= -112.5 && angle <  -67.5) return "F";
      if (angle >=  -67.5 && angle <  -22.5) return "FR";
      return null;
    };

    const update = (clientX, clientY) => {
      const rect = stick.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;

      let dx = clientX - cx;
      let dy = clientY - cy;
      const dist = Math.hypot(dx, dy);
      const maxR = rect.width / 2 - knob.offsetWidth / 2 - 4;

      if (dist > maxR) {
        const k = maxR / dist;
        dx *= k;
        dy *= k;
      }
      setKnob(dx, dy);

      const dir = dirFromVector(dx, dy, dist, maxR);
      setTickHints(dir);
      Movement.set(dir);
    };

    const onDown = (event) => {
      if (activePointerId !== null) return;
      event.preventDefault();
      activePointerId = event.pointerId;

      try { stick.setPointerCapture(event.pointerId); } catch {}
      stick.classList.add("dragging");
      update(event.clientX, event.clientY);
    };

    const onMove = (event) => {
      if (event.pointerId !== activePointerId) return;
      event.preventDefault();
      update(event.clientX, event.clientY);
    };

    const onUp = (event) => {
      if (event.pointerId !== activePointerId) return;
      activePointerId = null;
      stick.classList.remove("dragging");
      resetKnob();
      setTickHints(null);
      Movement.set(null);
      try { stick.releasePointerCapture(event.pointerId); } catch {}
    };

    stick.addEventListener("pointerdown", onDown);
    stick.addEventListener("pointermove", onMove);
    stick.addEventListener("pointerup", onUp);
    stick.addEventListener("pointercancel", onUp);
    stick.addEventListener("contextmenu", (e) => e.preventDefault());
    stick.addEventListener("dragstart", (e) => e.preventDefault());

    resetKnob();
  })();

  const Keyboard = (() => {
    const keys = { up: false, down: false, left: false, right: false };
    const rot  = { left: false, right: false };

    const KEY_TO_DIR = {
      KeyW: "up",    ArrowUp:    "up",
      KeyS: "down",  ArrowDown:  "down",
      KeyA: "left",  ArrowLeft:  "left",
      KeyD: "right", ArrowRight: "right",
    };

    const KEY_TO_ROT = {
      KeyQ: "left",
      KeyE: "right",
    };

    const rotButtons = {
      left:  document.querySelector('[data-cmd="RL"]'),
      right: document.querySelector('[data-cmd="RR"]'),
    };

    const isStickMode = () => document.body.dataset.mode === "stick";

    const paintCaps = () => {
      const map = {
        up:    keys.up,
        down:  keys.down,
        left:  keys.left,
        right: keys.right,
      };
      for (const [k, on] of Object.entries(map)) {
        const el = dom.keyCaps[k];
        if (el) el.classList.toggle("active", on);
      }
      if (rotButtons.left) {
        rotButtons.left.classList.toggle("active", rot.left && isStickMode());
      }
      if (rotButtons.right) {
        rotButtons.right.classList.toggle("active", rot.right && isStickMode());
      }
    };

    const computeDir = () => {
      if (isStickMode()) {
        const rotL = rot.left  && !rot.right;
        const rotR = rot.right && !rot.left;
        if (rotL) return "RL";
        if (rotR) return "RR";
      }

      const fwd = keys.up    && !keys.down;
      const bwd = keys.down  && !keys.up;
      const lft = keys.left  && !keys.right;
      const rgt = keys.right && !keys.left;

      if (fwd && rgt) return "FR";
      if (fwd && lft) return "FL";
      if (bwd && rgt) return "BR";
      if (bwd && lft) return "BL";
      if (fwd) return "F";
      if (bwd) return "B";
      if (rgt) return "R";
      if (lft) return "L";
      return null;
    };

    const apply = () => {
      paintCaps();
      Movement.set(computeDir());
    };

    const reset = () => {
      for (const k of Object.keys(keys)) keys[k] = false;
      rot.left = rot.right = false;
      paintCaps();
      Movement.set(null);
    };

    window.addEventListener("keydown", (event) => {
      if (event.code === "Space") {
        event.preventDefault();
        Movement.set(null);
        send("STOP");
        return;
      }

      const rotKey = KEY_TO_ROT[event.code];
      if (rotKey) {
        if (!isStickMode()) return;
        event.preventDefault();
        if (event.repeat) return;
        rot[rotKey] = true;
        apply();
        return;
      }

      const dir = KEY_TO_DIR[event.code];
      if (!dir) return;

      event.preventDefault();
      if (event.repeat) return;

      keys[dir] = true;
      apply();
    });

    window.addEventListener("keyup", (event) => {
      const rotKey = KEY_TO_ROT[event.code];
      if (rotKey) {
        event.preventDefault();
        rot[rotKey] = false;
        apply();
        return;
      }

      const dir = KEY_TO_DIR[event.code];
      if (!dir) return;
      event.preventDefault();

      keys[dir] = false;
      apply();
    });

    window.addEventListener("blur", reset);

    return { reset };
  })();

  (function bindFullscreen() {
    const btn = dom.btnFullscreen;
    if (!btn) return;

    const isFs = () =>
      !!(document.fullscreenElement || document.webkitFullscreenElement);

    const enterFs = () => {
      const el = document.documentElement;
      const fn = el.requestFullscreen || el.webkitRequestFullscreen;
      if (fn) fn.call(el).catch(() => {});
    };

    const exitFs = () => {
      const fn = document.exitFullscreen || document.webkitExitFullscreen;
      if (fn) fn.call(document).catch(() => {});
    };

    const sync = () => {
      dom.body.classList.toggle("is-fullscreen", isFs());
      const label = isFs() ? "Exit fullscreen" : "Enter fullscreen";
      btn.setAttribute("aria-label", label);
      btn.setAttribute("title", label);
    };

    btn.addEventListener("click", () => {
      if (isFs()) exitFs();
      else enterFs();
    });

    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    sync();
  })();

  (function bindTheme() {
    const btn = dom.btnTheme;
    if (!btn) return;

    const current = () =>
      dom.html.dataset.theme === "dark" ? "dark" : "light";

    const apply = (theme) => {
      dom.html.dataset.theme = theme;
      try { localStorage.setItem(THEME_KEY, theme); } catch {}

      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", THEME_COLORS[theme]);

      const label = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
      btn.setAttribute("aria-label", label);
      btn.setAttribute("title", label);
    };

    btn.addEventListener("click", () => {
      apply(current() === "dark" ? "light" : "dark");
    });

    try {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const onChange = (e) => {
        let saved = null;
        try { saved = localStorage.getItem(THEME_KEY); } catch {}
        if (saved === "dark" || saved === "light") return;
        dom.html.dataset.theme = e.matches ? "dark" : "light";
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute("content", THEME_COLORS[e.matches ? "dark" : "light"]);
      };
      if (mq.addEventListener) mq.addEventListener("change", onChange);
      else if (mq.addListener) mq.addListener(onChange);
    } catch {}

    const initial = current();
    btn.setAttribute("aria-label",
      initial === "dark" ? "Switch to light theme" : "Switch to dark theme");
  })();

  const setMode = (mode) => {
    if (!VALID_MODES.has(mode)) mode = "pad";

    const changed = dom.body.dataset.mode !== mode;

    if (changed) {
      Movement.set(null);
      Keyboard.reset();
      dom.body.dataset.mode = mode;
      log("sys", `mode: ${mode}`);
    }

    dom.modeBtns.forEach(btn => {
      btn.setAttribute("aria-selected", String(btn.dataset.mode === mode));
    });

    try { localStorage.setItem(MODE_KEY, mode); } catch {}
  };

  dom.modeBtns.forEach(btn => {
    btn.addEventListener("click", () => setMode(btn.dataset.mode));
  });

  (function initMode() {
    let saved = null;
    try { saved = localStorage.getItem(MODE_KEY); } catch {}
    setMode(saved || "pad");
  })();

  const TELEMETRY_MAX_AGE = 6;

  const sensorValEls = {};
  const sensorCardEls = {};
  const sensorsAgeEl = document.getElementById("sensorsAge");

  document.querySelectorAll("[data-val]").forEach((el) => {
    sensorValEls[el.dataset.val] = el;
  });
  document.querySelectorAll(".sensor[data-key]").forEach((el) => {
    sensorCardEls[el.dataset.key] = el;
  });

  const SENSOR_FORMAT = {
    t:    (v) => v.toFixed(2),
    h:    (v) => v.toFixed(2),
    dp:   (v) => v.toFixed(2),
    p:    (v) => v.toFixed(2),
    alt:  (v) => v.toFixed(2),
    dist: (v) => Math.round(v).toString(),
    bv:   (v) => v.toFixed(2),
    c:    (v) => Math.round(v).toString(),
    pw:   (v) => Math.round(v).toString(),
    lat:  (v) => v.toFixed(6),
    lon:  (v) => v.toFixed(6),
    galt: (v) => v.toFixed(1),
    spd:  (v) => v.toFixed(1),
    crs:  (v) => v.toFixed(1),
    sats: (v) => Math.round(v).toString(),
    lux:  (v) => v.toFixed(1),
    uvi:  (v) => v.toFixed(2),
    als:  (v) => Math.round(v).toString(),
    uvs:  (v) => Math.round(v).toString(),
  };

  const fmtSensor = (key, v) => {
    if (typeof v !== "number" || !Number.isFinite(v)) return "—";
    const fn = SENSOR_FORMAT[key];
    return fn ? fn(v) : v.toFixed(2);
  };

  function applyTelemetry(telem, ts) {
    telem = telem || {};
    const age = ts ? (Date.now() / 1000 - ts) : null;
    const stale = age === null || age > TELEMETRY_MAX_AGE;

    const LOG_TELEMETRY = true;
    if (LOG_TELEMETRY && !stale && age !== null && age < 1.5) {
      log("rx",
        `T=${fmtSensor("t", telem.t)}°C ` +
        `H=${fmtSensor("h", telem.h)}% ` +
        `P=${fmtSensor("p", telem.p)}hPa ` +
        `D=${fmtSensor("dist", telem.dist)}mm`
      );
    }

    for (const key of Object.keys(sensorValEls)) {
      sensorValEls[key].textContent = fmtSensor(key, telem[key]);
      const card = sensorCardEls[key];
      if (card) {
        card.classList.toggle("live", !stale);
        card.classList.toggle("stale", stale);
      }
    }


    if (sensorsAgeEl) {
      if (age === null) {
        sensorsAgeEl.textContent = "waiting…";
      } else if (stale) {
        sensorsAgeEl.textContent = `stale · ${age.toFixed(1)}s ago`;
      } else {
        sensorsAgeEl.textContent = `updated ${age.toFixed(1)}s ago`;
      }
    }


    // Light status badge
    const lightStatusEl = document.getElementById("lightStatus");
    if (lightStatusEl) {
      const lux = Number(telem.lux);
      let cls = "", txt = "—";
      if (!Number.isFinite(lux)) {
        cls = ""; txt = "—";
      } else if (telem.dark === 1) {
        cls = "light-dark"; txt = "dark";
      } else if (lux < 500) {
        cls = "light-dark"; txt = `dim · ${lux.toFixed(0)} lx`;
      } else if (lux < 5000) {
        cls = "light-bright"; txt = `bright · ${lux.toFixed(0)} lx`;
      } else {
        cls = "light-sunny"; txt = `sunny · ${lux.toFixed(0)} lx`;
      }
      lightStatusEl.textContent = txt;
      lightStatusEl.classList.remove("light-dark", "light-bright", "light-sunny");
      if (cls) lightStatusEl.classList.add(cls);
    }

    if (window.__syncLightsFromTelemetry) window.__syncLightsFromTelemetry(telem);
    const gpsFixEl = document.getElementById("gpsFix");
    if (gpsFixEl) {
      const fix = Number(telem.gfix) || 0;
      const sats = Number(telem.sats) || 0;
      const hdop = Number(telem.hdop);
      let cls = "fix-none", txt = "no fix";
      if (fix === 1) {
        if (sats >= 8 && (!Number.isFinite(hdop) || hdop < 2)) {
          cls = "fix-strong"; txt = `strong · ${sats} sats`;
        } else if (sats >= 4) {
          cls = "fix-ok";     txt = `ok · ${sats} sats`;
        } else {
          cls = "fix-weak";   txt = `weak · ${sats} sats`;
        }
      }
      gpsFixEl.textContent = txt;
      gpsFixEl.classList.remove("fix-none", "fix-weak", "fix-ok", "fix-strong");
      gpsFixEl.classList.add(cls);
    }

  }

  let lastOnline = null;
  async function poll() {
    try {
      const res = await fetch("/api/status", { cache: "no-store" });
      const data = await res.json();

      if (data.connected !== lastOnline) {
        lastOnline = data.connected;
        setLink(data.connected);
        log("sys", data.connected ? "robot link up" : "robot link down");
      }

      (data.replies || []).forEach((text) => log("rx", text));
      applyTelemetry(data.telemetry, data.telemetry_ts);

    } catch {
      if (lastOnline !== false) {
        lastOnline = false;
        setLink(false);
        log("err", "server unreachable");
      }
    } finally {
      setTimeout(poll, POLL_INTERVAL);
    }
  }

  let servoDebounce = null;

  const paintSlider = (input) => {
    const pct = ((input.value - input.min) / (input.max - input.min)) * 100;
    input.style.setProperty("--fill", `${pct}%`);
  };

  const sendServos = () => {
    const [a, b, c, d] = dom.servos.map((input) => parseInt(input.value, 10));
    send(`SV${a},${b},${c},${d}`);
  };

  dom.servos.forEach((input, index) => {
    paintSlider(input);

    input.addEventListener("input", () => {
      dom.readouts[index].textContent = input.value;
      paintSlider(input);
      clearTimeout(servoDebounce);
      servoDebounce = setTimeout(sendServos, SERVO_DEBOUNCE);
    });

    input.addEventListener("change", () => {
      clearTimeout(servoDebounce);
      sendServos();
    });
  });

  dom.btnHome.addEventListener("click", () => {
    SERVO_HOME.forEach((value, index) => {
      dom.servos[index].value = value;
      dom.readouts[index].textContent = value;
      paintSlider(dom.servos[index]);
    });
    clearTimeout(servoDebounce);
    sendServos();
  });

  dom.btnSend.addEventListener("click", () => {
    clearTimeout(servoDebounce);
    sendServos();
  });

  /* ---------- Scan module ---------- */
  (function initScan() {
    const canvas   = document.getElementById("scanCanvas");
    const statusEl = document.getElementById("scanStatus");
    const countEl  = document.getElementById("scanCount");
    const validEl  = document.getElementById("scanValid");
    const maxEl    = document.getElementById("scanMax");
    const stepEl   = document.getElementById("scanStep");
    const btnStart = document.getElementById("btnScanStart");
    const btnStop  = document.getElementById("btnScanStop");

    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    let state = { active: false, n: 0, count: 0, points: [] };

    function sizeCanvas() {
      const rect = canvas.getBoundingClientRect();
      const dpr  = window.devicePixelRatio || 1;
      const w    = Math.max(1, Math.round(rect.width));
      const h    = Math.max(1, Math.round(rect.height));
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width  = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { w, h };
    }

    function render() {
      const { w, h } = sizeCanvas();
      const oX    = w / 2;
      const oY    = h - 24;
      const maxR  = Math.min(h - 40, w / 2 - 30);

      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "#1c1810";
      ctx.fillRect(0, 0, w, h);

      // decide range scale
      let maxD = 500;
      for (const p of state.points) {
        if (p.d && p.d > maxD) maxD = p.d;
      }
      maxD = Math.ceil(maxD / 500) * 500;

      // range rings
      ctx.lineWidth = 1;
      ctx.font = "10px 'JetBrains Mono', monospace";
      ctx.textAlign = "center";
      for (let i = 1; i <= 4; i++) {
        const r = (maxR * i) / 4;
        ctx.strokeStyle = "rgba(232, 217, 184, 0.14)";
        ctx.beginPath();
        ctx.arc(oX, oY, r, Math.PI, 2 * Math.PI, false);
        ctx.stroke();
        ctx.fillStyle = "rgba(232, 217, 184, 0.32)";
        ctx.fillText(`${Math.round(maxD * i / 4)}`, oX, oY - r + 11);
      }

      // radial spokes
      ctx.strokeStyle = "rgba(232, 217, 184, 0.09)";
      for (const a of [0, 30, 60, 90, 120, 150, 180]) {
        const t = a * Math.PI / 180;
        ctx.beginPath();
        ctx.moveTo(oX, oY);
        ctx.lineTo(oX + maxR * Math.cos(t), oY - maxR * Math.sin(t));
        ctx.stroke();
        ctx.fillStyle = "rgba(232, 217, 184, 0.4)";
        ctx.fillText(`${a}°`, oX + (maxR + 14) * Math.cos(t),
                             oY - (maxR + 14) * Math.sin(t) + 3);
      }

      // placeholder
      if (state.points.length === 0) {
        ctx.fillStyle = "rgba(232, 217, 184, 0.32)";
        ctx.font = "12px 'JetBrains Mono', monospace";
        ctx.fillText("no scan data — press START", oX, oY - maxR * 0.55);
      }

      // polyline for valid points
      if (state.points.length > 1) {
        ctx.beginPath();
        let started = false;
        for (const p of state.points) {
          if (!p.d || p.ang == null) { started = false; continue; }
          const t = p.ang * Math.PI / 180;
          const r = (p.d / maxD) * maxR;
          const x = oX + r * Math.cos(t);
          const y = oY - r * Math.sin(t);
          if (!started) { ctx.moveTo(x, y); started = true; }
          else          { ctx.lineTo(x, y); }
        }
        ctx.strokeStyle = "rgba(232, 93, 26, 0.5)";
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }

      // dots
      for (const p of state.points) {
        if (!p.d || p.ang == null) continue;
        const t = p.ang * Math.PI / 180;
        const r = (p.d / maxD) * maxR;
        const x = oX + r * Math.cos(t);
        const y = oY - r * Math.sin(t);
        ctx.beginPath();
        ctx.arc(x, y, 2.6, 0, Math.PI * 2);
        ctx.fillStyle = "#ff7a2a";
        ctx.fill();
      }

      // origin dot (the robot)
      ctx.beginPath();
      ctx.arc(oX, oY, 4, 0, Math.PI * 2);
      ctx.fillStyle = "#e85d1a";
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "#1c1810";
      ctx.stroke();

      // sweep line
      if (state.active && state.points.length > 0) {
        const last = state.points[state.points.length - 1];
        if (last.ang != null) {
          const t = last.ang * Math.PI / 180;
          ctx.beginPath();
          ctx.moveTo(oX, oY);
          ctx.lineTo(oX + maxR * Math.cos(t), oY - maxR * Math.sin(t));
          ctx.strokeStyle = "rgba(255, 122, 42, 0.75)";
          ctx.lineWidth = 1.6;
          ctx.stroke();
        }
      }

      // stats
      const validCount = state.points.filter(p => p.d != null).length;
      countEl.textContent = `${state.count}/${state.n}`;
      validEl.textContent = `${validCount}`;
      maxEl.textContent   = maxD >= 1000 ? `${(maxD / 1000).toFixed(1)} m` : `${maxD} mm`;

      if (state.active) {
        statusEl.textContent  = `scanning… ${state.count}/${state.n}`;
        statusEl.style.color  = "#ff7a2a";
      } else if (state.count > 0 && state.count === state.n) {
        statusEl.textContent  = `complete · ${validCount}/${state.n} valid`;
        statusEl.style.color  = "#4ec98a";
      } else {
        statusEl.textContent  = "idle";
        statusEl.style.color  = "";
      }

      btnStart.disabled = state.active;
      btnStop.disabled  = !state.active;
    }

    async function pollScan() {
      try {
        const res  = await fetch("/api/scan", { cache: "no-store" });
        const data = await res.json();
        state = {
          active: !!data.active,
          n:      data.n     || 0,
          count:  data.count || 0,
          points: data.points || [],
        };
        render();
      } catch {
        /* server unreachable — keep last state */
      } finally {
        setTimeout(pollScan, state.active ? 100 : 1500);
      }
    }

    btnStart.addEventListener("click", () => {
      const step = parseInt(stepEl.value, 10) || 2;
      send(`SCAN,${step}`);
    });

    btnStop.addEventListener("click", () => {
      send("SCAN,STOP");
    });

    window.addEventListener("resize", render);

    render();
    pollScan();
  })();

  (function initLights() {
    const buttons = Array.from(document.querySelectorAll("[data-led]"));
    const stateEl = document.getElementById("lightsState");
    if (!buttons.length) return;

    const ONE_SHOT = {
      "LED,BLINK": 500,
      "LED,ALT":  1300,
    };

    let persistentActive = null;
    const oneShotTimers = new WeakMap();

    let syncGraceUntil = 0;

    const setStateLabel = (label, cmd) => {
      if (!stateEl) return;
      stateEl.textContent = label;
      stateEl.style.color = (cmd === "LED,OFF") ? "" : "var(--orange)";
    };

    const setPersistent = (btn) => {
      if (persistentActive === btn) return;
      if (persistentActive) persistentActive.classList.remove("active");
      if (btn) btn.classList.add("active");
      persistentActive = btn;
    };

    const getBtn = (led) => buttons.find((b) => b.dataset.led === led);

    buttons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const led = btn.dataset.led;

        // ---- AUTO button: toggle -------------------------------
        if (led === "AUTO") {
          const isOn = btn.classList.contains("active");
          const cmd  = isOn ? "AUTO,OFF" : "AUTO,ON";

          send(cmd);
          syncGraceUntil = Date.now() + 1500;

          if (isOn) {
            // Turning auto OFF → drop back to OFF persistent state
            setPersistent(getBtn("LED,OFF"));
            setStateLabel("off", "LED,OFF");
          } else {
            setPersistent(btn);
            setStateLabel("auto", "AUTO,ON");
          }
          return;
        }

        send(led);
        setStateLabel(led.replace("LED,", "").toLowerCase(), led);
        syncGraceUntil = Date.now() + 1500;

        const pending = oneShotTimers.get(btn);
        if (pending) {
          clearTimeout(pending);
          oneShotTimers.delete(btn);
        }

        if (led in ONE_SHOT) {
          // One-shot: highlight for a moment, don't touch persistent state
          btn.classList.add("active");
          const t = setTimeout(() => {
            btn.classList.remove("active");
            oneShotTimers.delete(btn);
          }, ONE_SHOT[led]);
          oneShotTimers.set(btn, t);
        } else {
          // Persistent (ON, OFF)
          setPersistent(btn);
        }
      });
    });

    // Boot default: OFF highlighted
    setPersistent(getBtn("LED,OFF"));
    if (stateEl) {
      stateEl.textContent = "off";
      stateEl.style.color = "";
    }

    window.__syncLightsFromTelemetry = (telem) => {
      if (Date.now() < syncGraceUntil) return;

      const autoBtn = getBtn("AUTO");
      const offBtn  = getBtn("LED,OFF");
      if (!autoBtn) return;

      const autoOn = Number(telem.auto) === 1;

      if (autoOn && persistentActive !== autoBtn) {
        setPersistent(autoBtn);
        setStateLabel("auto", "AUTO,ON");
      } else if (!autoOn && persistentActive === autoBtn) {
        setPersistent(offBtn);
        setStateLabel("off", "LED,OFF");
      }
    };
  })();


  log("sys", "control deck ready");
  log("sys", `endpoint {{ esp }}`);
  poll();
})();

