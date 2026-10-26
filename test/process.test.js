import assert from "node:assert/strict";
import test from "node:test";
import { runCommand } from "../dist/src/core/process.js";

test("command timeout terminates descendants that keep stdout open", async () => {
  const start = Date.now();
  const result = await runCommand(process.execPath, ["-e", `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 1, 2] });
    setInterval(() => {}, 1000);
  `], { timeoutMs: 120, allowFailure: true, killProcessGroup: true });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.code, 0);
  assert.ok(Date.now() - start < 3000, "a child process must not defeat the timeout by keeping a pipe open");
});

test("abort cancels an executing command", async () => {
  const controller = new AbortController();
  const result = runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { signal: controller.signal, killProcessGroup: true });
  controller.abort();
  await assert.rejects(result, { name: "AbortError" });
});
