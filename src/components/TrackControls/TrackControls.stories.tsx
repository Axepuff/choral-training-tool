import type { Meta, StoryObj } from '@storybook/react-vite';
import { useArgs } from 'storybook/preview-api';
import { expect, fn, userEvent, within } from 'storybook/test';
import { TrackControls } from './TrackControls';
import type { TrackControlsProps } from './TrackControls';

const meta = {
  id: 'components-track-controls',
  title: 'Компоненты/TrackControls',
  component: TrackControls,
  parameters: { docs: { description: { component: 'Управление партией: S — Solo, M — Mute. Кнопки и ползунок имеют области касания не меньше 44 px. Solo и Mute взаимоисключающие: включение одного отключает другое.' } } },
  args: {
    name: 'Сопрано', volume: 80, muted: false, solo: false, loading: false, tone: 'soprano',
    onVolumeChange: fn(), onMuteChange: fn(), onSoloChange: fn(),
  },
  argTypes: {
    volume: { control: { type: 'range', min: 0, max: 100, step: 1 } },
    tone: { control: 'select', options: ['soprano', 'alto', 'tenor', 'bass', 'backing'] },
  },
  render: function Render(args) {
    const [, updateArgs] = useArgs<TrackControlsProps>();
    return (
      <div style={{ width: '100%', maxWidth: args.orientation === 'vertical' ? 88 : 360, padding: 16, background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)' }}>
        <TrackControls {...args}
          onVolumeChange={(volume) => { args.onVolumeChange(volume); updateArgs({ volume }); }}
          onMuteChange={(muted) => { args.onMuteChange(muted); updateArgs({ muted }); }}
          onSoloChange={(solo) => { args.onSoloChange(solo); updateArgs({ solo }); }}
        />
      </div>
    );
  },
} satisfies Meta<typeof TrackControls>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  name: 'Обычное состояние',
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const solo = canvas.getByRole('button', { name: 'Solo: Сопрано' });
    const mute = canvas.getByRole('button', { name: 'Mute: Сопрано' });
    await expect(solo).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(solo);
    await expect(solo).toHaveAttribute('aria-pressed', 'true');
    await expect(args.onSoloChange).toHaveBeenCalledWith(true);
    await userEvent.click(mute);
    await expect(solo).toHaveAttribute('aria-pressed', 'false');
    await expect(mute).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(solo);
    await expect(mute).toHaveAttribute('aria-pressed', 'false');
    await expect(solo).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(solo);
    await expect(solo).toHaveAttribute('aria-pressed', 'false');
    const volume = canvas.getByRole('slider', { name: 'Громкость: Сопрано' });
    volume.focus();
    await userEvent.keyboard('{ArrowRight}');
    await expect(volume).toHaveValue('81');
    await expect(args.onVolumeChange).toHaveBeenCalledWith(81);
    await userEvent.keyboard('{ArrowLeft}');
    volume.blur();
  },
};

export const Muted: Story = {
  name: 'Mute', args: { muted: true },
  play: async ({ canvasElement }) => {
    const mute = within(canvasElement).getByRole('button', { name: 'Mute: Сопрано' });
    await expect(mute).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(mute);
    await expect(mute).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(mute);
  },
};

export const Solo: Story = {
  name: 'Solo', args: { solo: true },
  play: async ({ canvasElement }) => {
    const solo = within(canvasElement).getByRole('button', { name: 'Solo: Сопрано' });
    await expect(solo).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(solo);
    await expect(solo).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(solo);
  },
};

export const Loading: Story = {
  name: 'Загрузка', args: { loading: true },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status', { name: 'Загрузка: Сопрано' })).toBeVisible();
    await expect(canvas.getByRole('slider')).toBeDisabled();
    const solo = canvas.getByRole('button', { name: 'Solo: Сопрано' });
    await expect(solo).toBeDisabled();
    await expect(canvas.getByRole('button', { name: 'Mute: Сопрано' })).toBeDisabled();
    await userEvent.click(solo);
    await expect(args.onSoloChange).not.toHaveBeenCalled();
  },
};

export const Vertical: Story = {
  name: 'Вертикальный фейдер', args: { orientation: 'vertical' },
  play: async ({ canvasElement, args }) => {
    const volume = within(canvasElement).getByRole('slider', { name: 'Громкость: Сопрано' });
    await expect(volume).toHaveAttribute('aria-orientation', 'vertical');
    volume.focus();
    await userEvent.keyboard('{ArrowUp}');
    await expect(volume).toHaveValue('81');
    await expect(args.onVolumeChange).toHaveBeenCalledWith(81);
    await userEvent.keyboard('{ArrowDown}');
    await expect(volume).toHaveValue('80');
    volume.blur();
  },
};
