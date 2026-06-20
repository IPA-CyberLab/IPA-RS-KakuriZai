// @ts-nocheck
import { commandExists } from "./fs.js";
import { spawnDetached } from "./process.js";

export function openTarget(world, target) {
  if (target === "file") return openFileBrowser(world);
  if (target === "vscode") return openVSCode(world);
  if (target === "terminal") return openTerminal(world);
  if (target === "agent") return openAgent(world);
  throw new Error(`unsupported open target: ${target}`);
}

function openFileBrowser(world) {
  if (process.platform === "darwin") return spawnDetached("open", [world.sourcePath]);
  if (process.platform === "win32") return spawnDetached("explorer.exe", [world.sourcePath]);
  const opener = commandExists("xdg-open");
  if (!opener) throw new Error("xdg-open is unavailable");
  return spawnDetached(opener, [world.sourcePath]);
}

function openVSCode(world) {
  const code = commandExists("code") || commandExists("code-server");
  if (!code) throw new Error("VS Code/code-server command is unavailable");
  return spawnDetached(code, [world.sourcePath]);
}

function openTerminal(world) {
  const terminal =
    commandExists("x-terminal-emulator") ||
    commandExists("gnome-terminal") ||
    commandExists("konsole") ||
    commandExists("open");
  if (!terminal) throw new Error("terminal launcher is unavailable");
  if (process.platform === "darwin") return spawnDetached("open", ["-a", "Terminal", world.sourcePath]);
  return spawnDetached(terminal, [], { cwd: world.sourcePath });
}

function openAgent(world) {
  const codex = commandExists("codex");
  if (!codex) throw new Error("agent command is unavailable");
  return spawnDetached(codex, [], { cwd: world.sourcePath });
}
