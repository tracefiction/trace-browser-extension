import net from "node:net";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await delay(100); }
  throw Error(`Timed out waiting for ${label}`);
}

// Firefox's built-in Marionette driver avoids a separate WebDriver dependency.
export async function connectFirefox(port) {
  const socket = await until(() => new Promise(resolve => {
    const connection = net.connect(port, "127.0.0.1");
    connection.once("connect", () => resolve(connection));
    connection.once("error", () => { connection.destroy(); resolve(null); });
  }), "headless Firefox driver", 45000);
  let buffer = Buffer.alloc(0), nextId = 0;
  const pending = new Map();
  socket.on("data", data => {
    buffer = Buffer.concat([buffer, data]);
    while (true) {
      const colon = buffer.indexOf(58); if (colon < 0) return;
      const size = Number(buffer.subarray(0, colon).toString());
      if (buffer.length < colon + 1 + size) return;
      const message = JSON.parse(buffer.subarray(colon + 1, colon + 1 + size).toString());
      buffer = buffer.subarray(colon + 1 + size);
      if (!Array.isArray(message)) continue;
      const task = pending.get(message[1]); if (!task) continue;
      pending.delete(message[1]); clearTimeout(task.timeout);
      if (message[2]) task.reject(Error(JSON.stringify(message[2])));
      else task.resolve(message[3]);
    }
  });
  socket.on("error", error => { for (const task of pending.values()) task.reject(error); });
  return {
    close: () => socket.destroy(),
    send: (command, parameters = {}) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timeout = setTimeout(() => { pending.delete(id); reject(Error(`Driver timeout: ${command}`)); }, 20000);
      pending.set(id, { resolve, reject, timeout });
      const payload = JSON.stringify([0, id, command, parameters]);
      socket.write(`${Buffer.byteLength(payload)}:${payload}`);
    }),
  };
}
