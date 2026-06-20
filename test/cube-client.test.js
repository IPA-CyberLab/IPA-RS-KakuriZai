import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CubeSandboxClient } from "../src/cube/client.js";

test("cube client prefers cubemastercli in auto mode", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-cube-client-"));
  await fakeBinary(path.join(tmp, "cubemastercli"));
  await fakeBinary(path.join(tmp, "cubecli"));
  const originalPath = process.env.PATH;
  process.env.PATH = `${tmp}${path.delimiter}${originalPath || ""}`;
  try {
    const client = new CubeSandboxClient({ mode: "auto", mastercli: "cubemastercli", cubecli: "cubecli" });
    assert.equal(client.available().mode, "master");
  } finally {
    process.env.PATH = originalPath;
  }
});

test("cube client does not fall back to cubecli when master mode is explicit", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-cube-client-"));
  await fakeBinary(path.join(tmp, "cubecli"));
  const originalPath = process.env.PATH;
  process.env.PATH = `${tmp}${path.delimiter}${originalPath || ""}`;
  try {
    const client = new CubeSandboxClient({
      mode: "master",
      mastercli: "missing-kakurizai-cubemastercli",
      cubecli: "cubecli"
    });
    assert.deepEqual(client.available(), { available: false, reason: "cubemastercli not found" });
  } finally {
    process.env.PATH = originalPath;
  }
});

test("cube client accepts absolute cubemastercli paths", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kakurizai-cube-client-"));
  const mastercli = path.join(tmp, "cubemastercli-root");
  await fakeBinary(mastercli);
  const client = new CubeSandboxClient({ mode: "master", mastercli });
  assert.equal(client.available().binary, mastercli);
});

async function fakeBinary(file) {
  await fs.writeFile(file, "#!/bin/sh\nexit 0\n", "utf8");
  await fs.chmod(file, 0o755);
}
