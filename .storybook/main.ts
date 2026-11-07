import type { StorybookConfig } from '@storybook/react-vite';

const config: StorybookConfig = {
  stories: process.env.CHORAL_STORIES ? JSON.parse(process.env.CHORAL_STORIES) as string[] : ['../src/**/*.stories.tsx'],
  staticDirs: ['../public'],
  framework: '@storybook/react-vite',
  addons: ['@storybook/addon-docs', '@storybook/addon-mcp'],
  features: { componentsManifest: true },
  core: { disableTelemetry: true },
};

export default config;
