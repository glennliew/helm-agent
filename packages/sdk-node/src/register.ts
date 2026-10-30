// Maps `@helm-agent/plugin-sdk` (and `/testing`) to this folder so plugins need no node_modules.
// Used by the plugin bootstrap and by `helm plugin test` (node --import <this file> --test ...).
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const SDK: Record<string, string> = {
  '@helm-agent/plugin-sdk': pathToFileURL(path.join(here, 'index.ts')).href,
  '@helm-agent/plugin-sdk/testing': pathToFileURL(path.join(here, 'testing.ts')).href,
};

registerHooks({
  resolve(specifier, context, next) {
    const url = SDK[specifier];
    if (url) return { url, shortCircuit: true, format: 'module-typescript' };
    return next(specifier, context);
  },
});
