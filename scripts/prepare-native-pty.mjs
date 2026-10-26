import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

// The macOS prebuilt helper in node-pty 1.1.0 is packaged without its execute bit.
// Fix the installed helper, without compiling or running dependency install scripts.
if (process.platform === "darwin") {
  const require = createRequire(import.meta.url);
  const root = path.dirname(require.resolve("node-pty/package.json"));
  const helper = path.join(root, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
  try {
    const stat = await fs.stat(helper);
    await fs.chmod(helper, stat.mode | 0o111);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
