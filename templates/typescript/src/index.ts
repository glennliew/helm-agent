import { definePlugin, ui } from '@helm-agent/plugin-sdk';

// Every tool/command/panel here must also be declared in helm-plugin.json.
// `helm plugin dev .` reloads this file on save and warns about mismatches.
export default definePlugin({
  async activate(ctx) {
    ctx.log.info(`${ctx.plugin.id} started (isolation: ${ctx.isolation})`);
  },

  tools: {
    hello({ name }: { name: string }, ctx) {
      return `${ctx.config.greeting as string}, ${name}!`;
    },

    async count_lines({ path }: { path: string }, ctx) {
      // ctx.fs is checked against the fs.read grant; anything outside the workspace is refused.
      const text = await ctx.fs.readText(path);
      return `${path} has ${text.split('\n').length} lines`;
    },
  },

  commands: {
    about(_args, ctx) {
      return ui.stack(ui.heading(ctx.plugin.id), ui.keyValue({ version: ctx.plugin.version, workspace: ctx.workspace, isolation: ctx.isolation }));
    },
  },
});
