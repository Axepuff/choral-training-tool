import { cp } from 'node:fs/promises';

// Run after building both the app and Storybook. Keep Storybook at the site root.
await cp(new URL('../dist/', import.meta.url), new URL('../storybook-static/app/', import.meta.url), { recursive: true });
