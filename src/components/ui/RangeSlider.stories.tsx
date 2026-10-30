import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fireEvent } from 'storybook/test';
import { RangeSlider } from './RangeSlider';

const meta = { title: 'UI/RangeSlider', component: RangeSlider, args: { value: 4 }, tags: ['autodocs'] } satisfies Meta<typeof RangeSlider>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Controlled: Story = {
  render: function Controlled() {
    const [value, setValue] = useState(4);
    return <label>Позиция<RangeSlider variant="seek" aria-label="Позиция" min={2} max={10} step={2} value={value}
      aria-valuetext={`${value} секунд`} onChange={event => setValue(event.currentTarget.valueAsNumber)} /><output>{value} секунд</output></label>;
  },
  play: async ({ canvas }) => {
    const slider = canvas.getByRole('slider', { name: 'Позиция' });
    fireEvent.input(slider, { target: { value: '8' } });
    await expect(canvas.getByRole('status')).toHaveTextContent('8 секунд');
    await expect(slider).toHaveAttribute('aria-valuetext', '8 секунд');
  },
};
export const Faders: Story = {
  render: () => <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24 }}>
    <RangeSlider aria-label="Громкость" value={75} onChange={() => {}} />
    <RangeSlider aria-label="Альт" orientation="vertical" tone="alto" value={60} onChange={() => {}} />
    <RangeSlider aria-label="Бас" orientation="vertical" tone="bass" value={30} disabled />
  </div>,
};
