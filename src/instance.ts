import net from 'node:net';
import os from 'node:os';

/**
 * Single-instance control over a per-user named pipe. The running app listens on it, and
 * `pnpm start` / `pnpm stop` / the desktop shortcut talk to it ("ping", "quit", "show-log").
 * WISPRCHEAP_INSTANCE gives tests their own pipe so they don't collide with a real instance.
 */
export function pipePath(): string {
  const suffix = process.env.WISPRCHEAP_INSTANCE ? `-${process.env.WISPRCHEAP_INSTANCE}` : '';
  const user = os.userInfo().username.replace(/[^A-Za-z0-9_.-]/g, '_');
  return `\\\\.\\pipe\\wisprcheap-${user}${suffix}`;
}

/** Send one command. Resolves the reply, or null when no instance is running. */
export function sendCommand(command: string, timeoutMs = 2000): Promise<string | null> {
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    const socket = net.connect(pipePath());
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(''));
    socket.on('connect', () => socket.write(`${command}\n`));
    socket.on('data', (chunk) => {
      data += chunk;
      if (data.includes('\n')) finish(data.trim());
    });
    socket.on('end', () => finish(data.trim()));
    socket.on('error', () => finish(null));
  });
}

export type CommandHandler = (command: string) => string;

function listenOnce(handler: CommandHandler): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      let buffer = '';
      socket.on('error', () => {});
      socket.on('data', (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf('\n');
        if (newline >= 0) socket.end(`${handler(buffer.slice(0, newline).trim())}\n`);
      });
    });
    server.once('error', reject);
    server.listen(pipePath(), () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

export class AlreadyRunningError extends Error {}

/** Become the running instance. Waits up to `waitMs` for a previous instance to exit (restart). */
export async function acquireInstance(handler: CommandHandler, waitMs: number): Promise<net.Server> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      return await listenOnce(handler);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      if (Date.now() >= deadline) throw new AlreadyRunningError('wisprcheap is already running.');
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}
