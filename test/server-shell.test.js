import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { WebSocket } from "ws";
import { attachShell } from "../dist/src/server.js";

test("web shell closes only the failed session when resize races with PTY exit", () => {
  const socket = new FakeWebSocket();
  const terminal = fakeTerminal({
    resize() {
      const error = new Error("ioctl(2) failed, EBADF");
      error.code = "EBADF";
      throw error;
    }
  });

  attachShell(
    { name: "stopped-gvisor" },
    socket,
    { command: "fake-shell", args: [], env: {} },
    () => terminal
  );

  assert.doesNotThrow(() => {
    socket.emit("message", Buffer.from(JSON.stringify({
      type: "resize",
      cols: 120,
      rows: 40
    })));
  });
  assert.equal(socket.readyState, WebSocket.CLOSED);
  assert.match(socket.messages.join(""), /session unavailable: ioctl\(2\) failed, EBADF/);
});

test("web shell tolerates a PTY that closes before WebSocket cleanup", () => {
  const socket = new FakeWebSocket();
  const terminal = fakeTerminal({
    kill() {
      const error = new Error("pty is already closed");
      error.code = "EBADF";
      throw error;
    }
  });

  attachShell(
    { name: "closed-gvisor" },
    socket,
    { command: "fake-shell", args: [], env: {} },
    () => terminal
  );

  assert.doesNotThrow(() => socket.close());
  assert.equal(socket.readyState, WebSocket.CLOSED);
});

class FakeWebSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  messages = [];

  send(message) {
    this.messages.push(String(message));
  }

  close() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }
}

function fakeTerminal(overrides = {}) {
  return {
    onData() {},
    onExit() {},
    resize() {},
    write() {},
    kill() {},
    ...overrides
  };
}
