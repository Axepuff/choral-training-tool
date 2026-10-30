import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent } from 'storybook/test';
import { Select } from './Select';

const meta = { title: 'UI/Select', component: Select, tags: ['autodocs'] } satisfies Meta<typeof Select>;
export default meta;
type Story = StoryObj<typeof meta>;
export const NativeChoice: Story = {
  args: { 'aria-label': 'Длительность доли', defaultValue: '4', children: <><option value="4">4</option><option value="8">8</option><option disabled value="16">16 (недоступно)</option></> },
  play: async ({ canvas }) => {
    const select = canvas.getByRole('combobox', { name: 'Длительность доли' });
    await userEvent.selectOptions(select, '8');
    await expect(select).toHaveValue('8');
    await expect(canvas.getByRole('option', { name: '16 (недоступно)' })).toBeDisabled();
  },
};
