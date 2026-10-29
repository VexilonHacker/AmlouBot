import socket
import threading
import time
import json 
from collections import deque

from flask import Flask, jsonify, render_template, request

ESP_HOST = "192.168.1.1"
# ESP_HOST = "0.0.0.0"
ESP_PORT = 19820
WEB_HOST = "0.0.0.0"
WEB_PORT = 1337 # >:]
RECONNECT_DELAY = 3.0

_state = {"sock": None, "connected": False}
_lock = threading.Lock()
_stop = threading.Event()

_replies = deque(maxlen=200)
_replies_lock = threading.Lock()
_latest_telemetry = {}
_telemetry_lock = threading.Lock()
_telemetry_ts = 0.0 
_scan = {"active": False, "n": 0, "points": []}
_scan_lock = threading.Lock()


def _close_locked():
    sock = _state["sock"]
    if sock is not None:
        try:
            sock.close()
        except OSError:
            pass
    _state["sock"] = None
    _state["connected"] = False


def _send(command):
    payload = (command.strip() + "\n").encode("ascii", errors="ignore")
    with _lock:
        sock = _state["sock"]
        if not _state["connected"] or sock is None:
            return False
        try:
            sock.sendall(payload)
            return True
        except OSError:
            _close_locked()
            return False

def _handle_telemetry(text):
    cleaned = text.replace("nan", "null")
    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError as e:
        print(f"[esp] bad json: {e}  raw={text!r}")
        return

    if data.get("scan") == 1:
        _handle_scan(data)
        return

    global _telemetry_ts
    with _telemetry_lock:
        _latest_telemetry.clear()
        _latest_telemetry.update(data)
        _telemetry_ts = time.time()


def _handle_scan(data):
    if data.get("done"):
        with _scan_lock:
            n = _scan["n"]
            pts = list(_scan["points"])
            _scan["active"] = False
        print(f"\n[scan] done  {len(pts)}/{n} points")
        return

    with _scan_lock:
        if not _scan["active"]:
            _scan["active"] = True
            _scan["n"] = data.get("n", 0)
            _scan["points"] = []
            print(f"\n[scan] start  n={_scan['n']}")

        pt = {
            "ang": data.get("ang"),
            "d":   data.get("d"),
            "sig": data.get("sig", 0.0),
            "st":  data.get("st", -1),
        }
        _scan["points"].append(pt)
        i = data.get("i", len(_scan["points"]) - 1)
        n = _scan["n"]

    if pt["d"] is None:
        print(f"[scan] {i+1:>3}/{n}  ang={pt['ang']:>3}°  ------ mm  (st={pt['st']:>2}, sig={pt['sig']:.2f})")
    else:
        print(f"[scan] {i+1:>3}/{n}  ang={pt['ang']:>3}°  {pt['d']:>5.0f} mm  (sig={pt['sig']:.2f})")





def _drain(sock):
    buf = b""
    while not _stop.is_set():
        try:
            chunk = sock.recv(1024)
        except OSError:
            return
        if not chunk:
            return
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            text = line.decode("ascii", errors="ignore").strip()
            if not text:
                continue
            if text.startswith("{"):
                _handle_telemetry(text)
            else:
                with _replies_lock:
                    _replies.append(text)


def _link_loop():
    while not _stop.is_set():
        try:
            sock = socket.create_connection((ESP_HOST, ESP_PORT), timeout=5.0)
            sock.settimeout(None)
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            with _lock:
                _state["sock"] = sock
                _state["connected"] = True
            _drain(sock)
        except OSError:
            pass
        finally:
            with _lock:
                _close_locked()
        if not _stop.is_set():
            time.sleep(RECONNECT_DELAY)


app = Flask(__name__)


@app.route("/")
def index():
    return render_template("index.html", esp=f"{ESP_HOST}:{ESP_PORT}")


@app.route("/api/status")
def status():
    with _lock:
        connected = _state["connected"]
    with _replies_lock:
        replies = list(_replies)
        _replies.clear()
    with _telemetry_lock:
        telemetry = dict(_latest_telemetry)
        ts = _telemetry_ts
    data = {
        "connected": connected,
        "replies": replies,
        "telemetry": telemetry,
        "telemetry_ts": ts,
    }
    return jsonify(data)


@app.route("/api/scan")
def scan_state():
    with _scan_lock:
        return jsonify({
            "active": _scan["active"],
            "n":      _scan["n"],
            "count":  len(_scan["points"]),
            "points": list(_scan["points"]),
        })

@app.route("/api/command", methods=["POST"])
def command():
    data = request.get_json(silent=True) or request.form or {}
    cmd = str(data.get("cmd", "")).strip()
    if not cmd:
        return jsonify({"ok": False, "error": "empty"}), 400
    return jsonify({"ok": _send(cmd), "cmd": cmd})


def main():
    threading.Thread(target=_link_loop, name="robot-link", daemon=True).start()
    app.run(host=WEB_HOST, port=WEB_PORT, debug=False, threaded=True)


if __name__ == "__main__":
    main()
