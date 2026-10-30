// Entry point the host launches for every Node plugin:
//   node [permission flags] bootstrap.ts <plugin entry>
// 1. Keeps stdout reserved for the protocol (console.* goes to stderr).
// 2. Maps `@helm-agent/plugin-sdk` to this folder, so plugins need no node_modules.
// 3. Loads the plugin's default export and runs the protocol loop.
import { pathToFileURL } from 'node:url';
import util from 'node:util';
import './register.ts';

const realWrite = process.stdout.write.bind(process.stdout) as (s: string) => boolean;
const toStderr = (...a: unknown[]) => { process.stderr.write(util.format(...a) + '\n'); };
console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;
// Anything else that writes to stdout directly is redirected too, so it can't corrupt the protocol.
(process.stdout as unknown as { write: (chunk: unknown, ...rest: unknown[]) => boolean }).write = (chunk: unknown) => {
  process.stderr.write(typeof chunk === 'string' || chunk instanceof Uint8Array ? chunk : String(chunk));
  return true;
};

process.on('uncaughtException', (e) => {
  process.stderr.write(`[sdk] uncaught exception: ${e?.stack ?? e}\n`);
  process.exit(70);
});
process.on('unhandledRejection', (e) => {
  process.stderr.write(`[sdk] unhandled promise rejection: ${(e as Error)?.stack ?? e}\n`);
});

const entry = process.argv[2];
if (!entry) {
  process.stderr.write('[sdk] usage: bootstrap.ts <plugin entry>\n');
  process.exit(64);
}

const mod = await import(pathToFileURL(entry).href).catch((e: Error) => {
  process.stderr.write(`[sdk] failed to load ${entry}: ${e?.stack ?? e}\n`);
  process.exit(65);
});
const def = mod.default ?? mod.plugin;
if (!def || typeof def !== 'object') {
  process.stderr.write(`[sdk] ${entry} must "export default definePlugin({...})"\n`);
  process.exit(65);
}

const { runPlugin } = await import('./runtime.ts');
runPlugin(def, { write: realWrite, input: process.stdin });
