#!/usr/bin/env python3
"""Actual provider stdio/restart + host-shaped interrupted process reply.

No executable/provider invocation occurs: the private host returns a fixture login
and the exact SDK3 post-dispatch error contract. This tests the receiver's durable
classification; the host supervisor's real process fixtures qualify cleanup.
"""
import json
import os
from pathlib import Path
import queue
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time

BINARY = Path(sys.argv[1]).resolve()
CALLER = {"packageId": "fixture.consumer", "packageDigest": "b" * 64, "incarnation": 1}


class Provider:
    def __init__(self, root):
        self.root, self.sequence, self.generation_calls = root, 0, 0
        self.frames = queue.Queue()
        environment = dict(os.environ, CODEX_HOME=str(root / "private-codex-home"))
        self.process = subprocess.Popen([str(BINARY), "--data-dir", str(root)], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=environment)
        self.reader = threading.Thread(target=self.read, daemon=True)
        self.reader.start()

    def read(self):
        for line in self.process.stdout:
            self.frames.put(json.loads(line))

    def send(self, value):
        self.process.stdin.write(json.dumps(value) + "\n")
        self.process.stdin.flush()

    def host(self, frame):
        method, params = frame.get("method"), frame.get("params", {})
        if method == "event":
            return True
        if method == "host.process.release":
            self.send({"jsonrpc": "2.0", "id": frame["id"], "result": None})
            return True
        if method != "host.process.run":
            return False
        if params["args"] == ["login", "status"]:
            stdout, stderr = self.root / "login.stdout", self.root / "login.stderr"
            stdout.write_text("Logged in using ChatGPT\n")
            stderr.write_text("")
            result = {"handle": "fixture-login", "status": 0, "stdout": str(stdout), "stderr": str(stderr)}
            self.send({"jsonrpc": "2.0", "id": frame["id"], "result": result})
        else:
            self.generation_calls += 1
            self.send({"jsonrpc": "2.0", "id": frame["id"], "error": {"code": -32000,
                       "message": "Owned plugin process did not provide a complete result", "data": {"code": "interrupted"}}})
        return True

    def rpc(self, method, params):
        self.sequence += 1
        self.send({"jsonrpc": "2.0", "id": self.sequence, "method": method, "params": params})
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            frame = self.frames.get(timeout=max(.01, deadline - time.monotonic()))
            if self.host(frame):
                continue
            assert frame.get("id") == self.sequence and "result" in frame, frame
            return frame["result"]
        raise AssertionError("Provider RPC did not complete")

    def activate(self):
        self.rpc("initialize", {"protocolVersion": 1, "processService": True, "serviceService": {"version": 1},
                 "artifactService": {"version": 1}, "credentialService": {"version": 1}, "jobService": {"version": 1},
                 "hostControl": {"token": "a" * 64}})
        self.rpc("lifecycle.activate", {})

    def close(self):
        if self.process.poll() is None:
            self.process.kill()
        self.process.wait(timeout=3)
        self.process.stdin.close()
        self.reader.join(timeout=3)
        assert not self.reader.is_alive()
        self.process.stdout.close()
        self.process.stderr.close()


with tempfile.TemporaryDirectory(prefix="te-provider-process-uncertainty-") as directory:
    root = Path(directory)
    (root / "private-codex-home").mkdir()
    program = root / "fixture-codex"
    program.write_text("#!/bin/sh\nexit 91\n")
    program.chmod(0o700)
    provider = Provider(root)
    try:
        provider.activate()
        configuration = provider.rpc("settings.save", {"expectedRevision": 0, "configuration": {
            "schemaVersion": 1, "documentRevision": 0, "defaultConnectionId": "fixture-cli", "profiles": [{
                "id": "fixture-cli", "name": "Private fixture", "recipeRevision": "", "transport": "codex-cli",
                "executablePath": str(program), "modelSelection": False, "credential": {"kind": "cli_saved_login"}}]}})
        request = {"operationId": "original-interrupted", "connectionId": "fixture-cli", "expectedConnectionRevision":
                   configuration["profiles"][0]["recipeRevision"], "model": None, "prompt": "Fixture original prompt", "inputs": [],
                   "options": {"size": "1024x1024", "quality": "auto", "background": "auto", "resolution": None, "aspectRatio": None}}
        prepared = provider.rpc("services.image-generation.v1.prepare", {"caller": CALLER, "request": request})
        request.update(preparationToken=prepared["preparationToken"], effectiveRecipeDigest=prepared["effectiveRecipeDigest"])
        provider.rpc("services.image-generation.v1.start", {"caller": CALLER, "request": request})
        for _ in range(100):
            status = provider.rpc("services.image-generation.v1.status", {"caller": CALLER, "request": {"operationId": request["operationId"]}})
            if status["execution"]["state"] not in ("accepted", "running"):
                break
            time.sleep(.01)
        assert status["execution"]["state"] == "unknown", status
        assert status["execution"]["error"]["code"] == "interrupted" and status["delivery"] == {"state": "none"}
        assert provider.generation_calls == 1
        with sqlite3.connect(root / "operations.sqlite") as connection:
            stored = json.loads(connection.execute("SELECT status FROM operations WHERE operation=?", (request["operationId"],)).fetchone()[0])
        assert stored == status
    finally:
        provider.close()
    restarted = Provider(root)
    try:
        restarted.activate()
        recovered = restarted.rpc("services.image-generation.v1.status", {"caller": CALLER, "request": {"operationId": request["operationId"]}})
        repeated = restarted.rpc("services.image-generation.v1.start", {"caller": CALLER, "request": request})
        assert recovered == status and repeated == status
        assert restarted.generation_calls == 0, "Original ambiguous operation was replayed"
    finally:
        restarted.close()
print("PASS interrupted owned process stays durable Unknown; duplicate Start/restart perform zero new generation")
