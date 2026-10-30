import { definePlugin } from '@helm-agent/plugin-sdk';

export default definePlugin({
  hooks: {
    'tool.before': () => {
      throw new Error('policy engine exploded');
    },
  },
});
