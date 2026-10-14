import type { Preview } from '@storybook/react-vite';
import '../src/styles/tokens.css';
import '../src/styles/global.css';

const preview: Preview = {
  tags: ['autodocs'],
  parameters: {
    layout: 'padded',
    backgrounds: {
      options: {
        light: { name: 'Светлый', value: '#f6f7fb' },
        white: { name: 'Белый', value: '#ffffff' },
      },
    },
    viewport: {
      options: {
        mobile360: { name: 'Мобильный · 360 px', styles: { width: '360px', height: '800px' }, type: 'mobile' },
        mobile390: { name: 'Мобильный · 390 px', styles: { width: '390px', height: '844px' }, type: 'mobile' },
        tablet768: { name: 'Планшет · 768 px', styles: { width: '768px', height: '1024px' }, type: 'tablet' },
        desktop1280: { name: 'Десктоп · 1280 px', styles: { width: '1280px', height: '900px' }, type: 'desktop' },
      },
    },
  },
  initialGlobals: { backgrounds: { value: 'light' } },
};

export default preview;
