import json
import queue
import time
from collections import deque
from flask import Flask, Response, jsonify, request, send_from_directory

app = Flask(__name__, static_folder=None)

current_state = {
    "stage": "idle",
    "ear": None,
    "mar": None,
    "gps": None,
    "sessionTime": 0,
    "lastUpdate": 0,
}
incidents = deque(maxlen=50)
subscribers: list[queue.Queue] = []


def broadcast(message: dict) -> None:
    dead = []
    for q in subscribers:
        try:
            q.put_nowait(message)
        except queue.Full:
            dead.append(q)
    for q in dead:
        if q in subscribers:
            subscribers.remove(q)


@app.route("/")
def index():
    return send_from_directory(".", "index.html")


@app.route("/drive/")
def drive_index():
    return send_from_directory("drive", "index.html")


@app.route("/drive/<path:filename>")
def drive_static(filename):
    return send_from_directory("drive", filename)


@app.route("/watch/")
def watch_index():
    return send_from_directory("watch", "index.html")


@app.route("/watch/<path:filename>")
def watch_static(filename):
    return send_from_directory("watch", filename)


@app.route("/api/state", methods=["POST"])
def post_state():
    data = request.get_json(silent=True) or {}
    current_state.update(data)
    current_state["lastUpdate"] = time.time()
    broadcast({"type": "state", "data": current_state})
    return jsonify({"ok": True})


@app.route("/api/incident", methods=["POST"])
def post_incident():
    data = request.get_json(silent=True) or {}
    data["id"] = f"inc-{int(time.time() * 1000)}"
    data["timestamp"] = time.time()
    incidents.appendleft(data)
    broadcast({"type": "incident", "data": data})
    return jsonify({"ok": True, "id": data["id"]})


@app.route("/api/snapshot")
def get_snapshot():
    return jsonify({"state": current_state, "incidents": list(incidents)})


@app.route("/api/reset", methods=["POST"])
def reset():
    incidents.clear()
    current_state.update(
        {"stage": "idle", "ear": None, "mar": None, "gps": None, "sessionTime": 0}
    )
    broadcast({"type": "reset"})
    return jsonify({"ok": True})


@app.route("/api/stream")
def stream():
    def generate():
        q: queue.Queue = queue.Queue(maxsize=100)
        subscribers.append(q)
        try:
            initial = {
                "type": "snapshot",
                "data": {"state": current_state, "incidents": list(incidents)},
            }
            yield f"data: {json.dumps(initial)}\n\n"
            while True:
                try:
                    msg = q.get(timeout=15)
                    yield f"data: {json.dumps(msg)}\n\n"
                except queue.Empty:
                    yield ": keepalive\n\n"
        finally:
            if q in subscribers:
                subscribers.remove(q)

    return Response(generate(), mimetype="text/event-stream")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000, threaded=True, debug=False)
