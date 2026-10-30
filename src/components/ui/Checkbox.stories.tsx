import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent } from 'storybook/test';
import { Checkbox } from './Checkbox';

const meta = { title: 'UI/Checkbox', component: Checkbox, args: { children: 'Показать пароль' }, tags: ['autodocs'] } satisfies Meta<typeof Checkbox>;
export default meta;
type Story = StoryObj<typeof meta>;
export const LabelAndKeyboard: Story = {
  render: function LabelAndKeyboard() {
    const [checked, setChecked] = useState(false);
    return <div><Checkbox checked={checked} onChange={event => setChecked(event.target.checked)}>Показать пароль</Checkbox>
      <Checkbox disabled>Недоступно</Checkbox></div>;
  },
  play: async ({ canvas }) => {
    const checkbox = canvas.getByRole('checkbox', { name: 'Показать пароль' });
    await userEvent.click(canvas.getByText('Показать пароль'));
    await expect(checkbox).toBeChecked();
    await userEvent.keyboard(' ');
    await expect(checkbox).not.toBeChecked();
    await expect(canvas.getByRole('checkbox', { name: 'Недоступно' })).toBeDisabled();
  },
};
