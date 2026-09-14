import assert from "node:assert/strict";
import test from "node:test";

import { defaultConfig, mergeConfig } from "../dist/src/core/config.js";

test("null saved resource values keep current CubeSandbox defaults", () => {
  const base = defaultConfig("/tmp/kakurizai-config-test");
  const config = mergeConfig(base, {
    cube: {
      cpu: null,
      memory: null,
      writableLayerSize: null
    }
  });

  assert.equal(config.cube.cpu, "4000m");
  assert.equal(config.cube.memory, "4000Mi");
  assert.equal(config.cube.writableLayerSize, "20G");
});
