// @ts-nocheck
import { spawn } from "node:child_process";

export function runCommand(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      return reject(Object.assign(new Error("command aborted"), { name: "AbortError" }));
    }
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let escalation = null;
    const grouped = options.killProcessGroup === true && process.platform !== "win32";
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
      stdio: options.inherit ? "inherit" : [options.input ? "pipe" : "ignore", "pipe", "pipe"],
      detached: grouped
    });
    const kill = (signal) => {
      try {
        if (grouped && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    };
    const terminate = () => {
      if (settled || escalation) return;
      kill(options.timeoutSignal || "SIGTERM");
      escalation = setTimeout(() => kill("SIGKILL"), 1000);
      escalation.unref?.();
    };
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = options.timeoutMs
      ? setTimeout(() => {
        timedOut = true;
        terminate();
      }, Number(options.timeoutMs))
      : null;
    let stdout = "";
    let stderr = "";
    if (!options.inherit) {
      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });
    }
    if (options.input && child.stdin) {
      child.stdin.end(options.input);
    }
    child.on("error", (error) => {
      if (timeout) clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
      options.signal?.removeEventListener("abort", onAbort);
      settled = true;
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (timeout) clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
      options.signal?.removeEventListener("abort", onAbort);
      settled = true;
      const result = { code, signal, stdout, stderr, timedOut };
      if (aborted) return reject(Object.assign(new Error("command aborted"), { name: "AbortError", result }));
      if (code === 0 || options.allowFailure) {
        resolve(result);
      } else {
        const error = new Error(`${command} ${args.join(" ")} failed with code ${code}`);
        error.result = result;
        reject(error);
      }
    });
  });
}

export function spawnDetached(command, args = [], options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env || {}) },
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  return child.pid;
}
