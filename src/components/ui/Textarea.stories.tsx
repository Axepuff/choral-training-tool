import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent } from 'storybook/test';
import { Textarea } from './Textarea';

const meta = { title: 'UI/Textarea', component: Textarea, tags: ['autodocs'] } satisfies Meta<typeof Textarea>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Notes: Story = {
  args: { 'aria-label': 'Заметки', name: 'notes', rows: 4, maxLength: 1000, placeholder: 'Вступления, дыхание…' },
  play: async ({ canvas }) => {
    const notes = canvas.getByRole('textbox', { name: 'Заметки' });
    await userEvent.type(notes, 'Вступление — мягко.{Enter}Дыхание перед третьим тактом.');
    await expect(notes).toHaveValue('Вступление — мягко.\nДыхание перед третьим тактом.');
  },
};
