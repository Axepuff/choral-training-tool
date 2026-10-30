import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent } from 'storybook/test';
import { ActionLink } from './ActionLink';

const meta = { title: 'UI/ActionLink', component: ActionLink, tags: ['autodocs'] } satisfies Meta<typeof ActionLink>;
export default meta;
type Story = StoryObj<typeof meta>;
export const NativeNavigation: Story = {
  args: { href: '#song-editor', variant: 'primary', children: 'Создать песню' },
  play: async ({ canvas }) => {
    const link = canvas.getByRole('link', { name: 'Создать песню' });
    await userEvent.click(link);
    await expect(link.ownerDocument.defaultView?.location.hash).toBe('#song-editor');
    await expect(link).toHaveFocus();
  },
};
