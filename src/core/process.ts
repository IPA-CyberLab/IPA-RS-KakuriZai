// @ts-nocheck
import { spawn } from "node:child_process";

export function runCommand(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
      stdio: options.inherit ? "inherit" : [options.input ? "pipe" : "ignore", "pipe", "pipe"]
    });
    const timeout = options.timeoutMs
      ? setTimeout(() => {
        if (!settled) child.kill(options.timeoutSignal || "SIGTERM");
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
      settled = true;
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (timeout) clearTimeout(timeout);
      settled = true;
      const result = { code, signal, stdout, stderr };
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
