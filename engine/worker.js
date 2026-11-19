"use strict";
(() => {
  // apps/mobile/src/runtime/device/worker/engineHost.ts
  var INVALID_COMMAND = { code: "invalid_command", message_key: "errors.invalid_command" };
  function isRecord(value) {
    return typeof value === "object" && value !== null;
  }
  function engineError(id, error) {
    if (isRecord(error) && typeof error.code === "string" && typeof error.message_key === "string") {
      return { id, ok: false, error: { code: error.code, message_key: error.message_key } };
    }
    return { id, ok: false, error: INVALID_COMMAND };
  }
  function handleApplyRequest(python, request, onError = () => void 0) {
    try {
      const stateJson = request.state === null ? "" : JSON.stringify(request.state);
      const parsed = JSON.parse(python(stateJson, JSON.stringify(request.command)));
      if (isRecord(parsed) && parsed.ok === true) {
        return { id: request.id, ok: true, state: parsed.state, events: parsed.events ?? [] };
      }
      return engineError(request.id, isRecord(parsed) ? parsed.error : void 0);
    } catch (cause) {
      onError(cause);
      return engineError(request.id, void 0);
    }
  }

  // apps/mobile/src/runtime/device/worker/engineWorker.ts
  var BASE = new URL("./", self.location.href).href;
  var PYTHON_BOOT = `
import json
from engine import sandbox
from engine.sandbox.state import to_json

sandbox.configure(json.loads(_bb_content_json))

def _bb_apply(state_json, command_json):
    state = json.loads(state_json) if state_json else None
    return to_json(sandbox.apply(state, json.loads(command_json)))
`;
  async function fetchOk(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`failed to load ${url}: ${response.status}`);
    return response;
  }
  async function boot() {
    const indexURL = `${BASE}pyodide/`;
    importScripts(`${indexURL}pyodide.js`);
    const pyodide = await loadPyodide({ indexURL });
    const manifest = await (await fetchOk(`${BASE}manifest.json`)).json();
    await pyodide.loadPackage(manifest.pyodide_packages);
    const micropip = pyodide.pyimport("micropip");
    for (const wheel of manifest.wheels) {
      const bytes = new Uint8Array(await (await fetchOk(`${BASE}wheels/${wheel}`)).arrayBuffer());
      pyodide.FS.writeFile(`/tmp/${wheel}`, bytes);
      await micropip.install.callKwargs(`emfs:/tmp/${wheel}`, { deps: false });
    }
    pyodide.globals.set("_bb_content_json", await (await fetchOk(`${BASE}content.json`)).text());
    pyodide.runPython(PYTHON_BOOT);
    const apply = pyodide.globals.get("_bb_apply");
    return { python: (stateJson, commandJson) => apply(stateJson, commandJson), manifest };
  }
  function isApplyRequest(data) {
    return typeof data === "object" && data !== null && data.op === "apply" && typeof data.id === "string";
  }
  function logError(cause) {
    console.error("engine worker error", cause);
  }
  async function main() {
    try {
      const { python, manifest } = await boot();
      self.onmessage = (event) => {
        if (isApplyRequest(event.data)) {
          self.postMessage(handleApplyRequest(python, event.data, logError));
        }
      };
      self.postMessage({
        op: "ready",
        ok: true,
        engine_version: manifest.engine_version,
        content_version: manifest.content_version,
        weights_version: manifest.weights_version
      });
    } catch (cause) {
      logError(cause);
      self.postMessage({
        op: "ready",
        ok: false,
        error: { code: "engine_not_ready", message_key: "errors.engine_not_ready" }
      });
    }
  }
  void main();
})();
