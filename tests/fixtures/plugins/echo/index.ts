import fs from 'node:fs';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { definePlugin } from '@helm-agent/plugin-sdk';

export default definePlugin({
  tools: {
    echo: ({ text }: { text: string }) => `echo: ${text}`,
    slow: ({ ms = 1000 }: { ms?: number }, ctx) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve(`slept ${ms}`), ms);
        ctx.signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('cancelled')); });
      }),
    spin: () => { for (;;) { /* wedge the event loop */ } },
    crash: () => { process.exit(3); },
    noisy: () => {
      // Bypass the SDK's stdout guard on purpose by writing to fd 1 directly.
      for (let i = 0; i < 30; i++) fs.writeSync(1, `garbage line ${i}\n`);
      return 'done';
    },
    read_home: ({ path }: { path: string }) => {
      try { return `read ${fs.readFileSync(path, 'utf8').length} bytes`; } catch (e) { return `blocked: ${(e as NodeJS.ErrnoException).code}`; }
    },
    direct_net: () =>
      new Promise((resolve) => {
        try {
          const s = net.connect(443, '1.1.1.1');
          s.on('connect', () => { s.destroy(); resolve('connected'); });
          s.on('error', (e: NodeJS.ErrnoException) => resolve(`blocked: ${e.code}`));
        } catch (e) { resolve(`blocked: ${(e as NodeJS.ErrnoException).code}`); }
      }),
    spawn: () => {
      try { return `ran: ${execFileSync('/usr/bin/id', { encoding: 'utf8' }).trim()}`; } catch (e) { return `blocked: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message.slice(0, 80)}`; }
    },
    peek_secret: async ({ name }: { name: string }, ctx) => {
      try { return `got ${(await ctx.secrets.get(name)).length} chars`; } catch (e) { return `denied: ${(e as Error).message}`; }
    },
    env: () => JSON.stringify(Object.keys(process.env).sort()),
    hog: () => { const keep: string[] = []; for (;;) keep.push('x'.repeat(1024 * 1024) + Math.random()); },
  },
  commands: {
    hello: () => 'hello from echo',
  },
});
