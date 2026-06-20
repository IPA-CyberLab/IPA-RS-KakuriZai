// @ts-nocheck
import { CubeSandboxOverlayBackend } from "./cubeSandboxOverlay.js";
import { IsolatedAgentBackend } from "./isolatedAgent.js";

export const BACKENDS = [
  "apfs-clone",
  "windows-block-clone",
  "linux-native",
  "systemd-nspawn",
  "btrfs",
  "path-preserving-overlay",
  "windows-minifilter-overlay",
  "cube-sandbox-overlay"
];

export function getBackend(config, name) {
  if (name === "cube-sandbox-overlay") return new CubeSandboxOverlayBackend(config);
  if (BACKENDS.includes(name)) return new IsolatedAgentBackend(config, name);
  throw new Error(`unsupported backend: ${name}`);
}
