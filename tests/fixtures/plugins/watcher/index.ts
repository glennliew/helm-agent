import { definePlugin } from '@helm-agent/plugin-sdk';
const seen: Array<{ event: string; payload: unknown }> = [];
const record = (event: string) => (payload: unknown) => { seen.push({ event, payload }); };
export default definePlugin({
  tools: { seen: () => JSON.stringify(seen) },
  hooks: { 'message.user': record('message.user'), 'tool.before': record('tool.before'), 'tool.after': record('tool.after') },
});
