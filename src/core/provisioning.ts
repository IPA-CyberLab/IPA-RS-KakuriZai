// @ts-nocheck
import { CubeSandboxClient } from "../cube/client.js";
import { bootstrapKubernetesLab } from "./kubernetes.js";
import { WorldStore } from "./store.js";
import { ensureWorldProvisioned } from "./worlds.js";

export async function reconcilePendingWorlds(config, options = {}) {
  const client = options.client || new CubeSandboxClient(config.cube || {});
  const availability = client.provisioningAvailability();
  if (!availability.available) return { skipped: true, reason: availability.reason, provisioned: [], failed: [] };
  const store = new WorldStore(config);
  const provisioned = [];
  const failed = [];
  const worlds = await store.list();
  for (const world of worlds) {
    options.signal?.throwIfAborted();
    if (world.backend !== "cube-sandbox-overlay") continue;
    const retry = world.sandbox?.provisioning;
    const pending = world.status === "pending-cube" && world.sandbox?.status === "planned";
    const retryable = world.status === "failed" && !world.sandbox?.id && retry?.automatic === true;
    if ((!pending && !retryable) || Number(retry?.nextRetryAt || 0) > Date.now()) continue;
    try {
      const ready = await ensureWorldProvisioned(config, world.id);
      provisioned.push(ready.id);
    } catch (error) {
      const latest = await store.get(world.id, { exactId: true });
      const attempts = Number(retry?.attempts || 0) + 1;
      latest.sandbox = {
        ...(latest.sandbox || {}),
        provisioning: {
          automatic: true,
          attempts,
          nextRetryAt: Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(attempts, 6)),
          reason: error.message || String(error)
        }
      };
      await store.save(latest);
      failed.push({ id: world.id, reason: error.message || String(error) });
    }
  }
  const clusters = new Map();
  for (const world of await store.list()) {
    const k = world.backendConfig?.kubernetes;
    if (world.backend !== "cube-sandbox-overlay" || !k?.enabled || k.bootstrap === false) continue;
    const group = clusters.get(k.clusterName) || [];
    group.push(world);
    clusters.set(k.clusterName, group);
  }
  const kubernetes = [];
  for (const [cluster, nodes] of clusters) {
    options.signal?.throwIfAborted();
    if (nodes.every((world) => world.sandbox?.kubernetesBootstrap?.status === "ready")) continue;
    if (nodes.some((world) => Number(world.sandbox?.kubernetesBootstrap?.nextRetryAt || 0) > Date.now())) continue;
    kubernetes.push({ cluster, ...(await bootstrapKubernetesLab(config, nodes, { signal: options.signal })) });
  }
  return { skipped: false, provisioned, failed, kubernetes };
}

export function startProvisioningController(config, options = {}) {
  if (config.provisioning?.enabled === false || options.enabled === false) return { stop() {}, tick: async () => ({ skipped: true }) };
  const requestedInterval = Number(options.intervalMs || config.provisioning?.intervalMs || 5000);
  const intervalMs = Number.isFinite(requestedInterval) ? Math.max(25, requestedInterval) : 5000;
  const abort = new AbortController();
  let running = null;
  const tick = () => {
    if (abort.signal.aborted) return Promise.resolve({ skipped: true });
    if (running) return running;
    running = reconcilePendingWorlds(config, { ...options, signal: abort.signal })
      .catch((error) => {
        if (error.name !== "AbortError") options.onError?.(error);
        return { skipped: true, reason: error.message || String(error) };
      })
      .finally(() => { running = null; });
    return running;
  };
  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref?.();
  void tick();
  return {
    tick,
    stop() {
      clearInterval(timer);
      abort.abort();
      return running;
    }
  };
}
