// Writes docs/schemas/plugin-manifest-v1.json from the schema the host validates with, so editors
// can autocomplete helm-plugin.json. tests/unit/manifest.test.ts checks it stays in sync.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifestSchema } from '../packages/core/src/manifest/manifest.ts';

export const SCHEMA_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../docs/schemas/plugin-manifest-v1.json');
export function publishedSchema() {
  return { ...manifestSchema, $schema: 'http://json-schema.org/draft-07/schema#', $id: 'https://helm-agent.dev/schemas/plugin-manifest-v1.json', title: 'Helm plugin manifest (helm-plugin.json), version 1' };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(SCHEMA_FILE, JSON.stringify(publishedSchema(), null, 2) + '\n');
  console.log(`wrote ${path.relative(process.cwd(), SCHEMA_FILE)}`);
}
