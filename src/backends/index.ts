// @ts-nocheck
import { CubeSandboxOverlayBackend } from "./cubeSandboxOverlay.js";
import { FuchsiaBackend } from "./fuchsia.js";
import { GVisorBackend } from "./gvisor.js";
import { IsolatedAgentBackend } from "./isolatedAgent.js";

export const BACKENDS = [
  "apfs-clone",
  "windows-block-clone",
  "linux-native",
  "systemd-nspawn",
  "btrfs",
  "path-preserving-overlay",
  "windows-minifilter-overlay",
  "cube-sandbox-overlay",
  "gvisor",
  "fuchsia"
];

export function getBackend(config, name) {
  if (name === "cube-sandbox-overlay") return new CubeSandboxOverlayBackend(config);
  if (name === "gvisor") return new GVisorBackend(config);
  if (name === "fuchsia") return new FuchsiaBackend(config);
  if (BACKENDS.includes(name)) return new IsolatedAgentBackend(config, name);
  throw new Error(`unsupported backend: ${name}`);
}
