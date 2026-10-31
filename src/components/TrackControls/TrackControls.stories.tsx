import type { Meta, StoryObj } from '@storybook/react-vite';
import { useArgs } from 'storybook/preview-api';
import { expect, fireEvent, fn, userEvent, waitFor, within } from 'storybook/test';
import { TrackControls } from './TrackControls';
import type { TrackControlsProps } from './TrackControls';

// Synthetic key events do not execute the browser’s native range default action.
function setVolume(element: HTMLElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
  fireEvent.input(element, { bubbles: true });
}

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
      <div style={{ width: '100%', maxWidth: args.orientation === 'vertical' ? 112 : 360 }}>
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
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const solo = canvas.getByRole('button', { name: 'Solo: Сопрано' });
    const mute = canvas.getByRole('button', { name: 'Mute: Сопрано' });
    await waitFor(() => expect(solo).toHaveAttribute('aria-pressed', 'false'));
    await userEvent.click(solo);
    await waitFor(() => expect(solo).toHaveAttribute('aria-pressed', 'true'));
    await userEvent.click(mute);
    await waitFor(() => expect(solo).toHaveAttribute('aria-pressed', 'false'));
    await waitFor(() => expect(mute).toHaveAttribute('aria-pressed', 'true'));
    await userEvent.click(solo);
    await waitFor(() => expect(mute).toHaveAttribute('aria-pressed', 'false'));
    await waitFor(() => expect(solo).toHaveAttribute('aria-pressed', 'true'));
    await userEvent.click(solo);
    await waitFor(() => expect(solo).toHaveAttribute('aria-pressed', 'false'));
    const volume = canvas.getByRole('slider', { name: 'Громкость: Сопрано' });
    volume.focus();
    setVolume(volume, '81');
    await waitFor(() => expect(volume).toHaveValue('81'));
    setVolume(volume, '80');
    volume.blur();
  },
};

export const Muted: Story = {
  name: 'Mute', args: { muted: true },
  play: async ({ canvasElement }) => {
    const mute = within(canvasElement).getByRole('button', { name: 'Mute: Сопрано' });
    await waitFor(() => expect(mute).toHaveAttribute('aria-pressed', 'true'));
    await userEvent.click(mute);
    await waitFor(() => expect(mute).toHaveAttribute('aria-pressed', 'false'));
    await userEvent.click(mute);
  },
};

export const Solo: Story = {
  name: 'Solo', args: { solo: true },
  play: async ({ canvasElement }) => {
    const solo = within(canvasElement).getByRole('button', { name: 'Solo: Сопрано' });
    await waitFor(() => expect(solo).toHaveAttribute('aria-pressed', 'true'));
    await userEvent.click(solo);
    await waitFor(() => expect(solo).toHaveAttribute('aria-pressed', 'false'));
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
  play: async ({ canvasElement }) => {
    const volume = within(canvasElement).getByRole('slider', { name: 'Громкость: Сопрано' });
    await expect(volume).toHaveAttribute('aria-orientation', 'vertical');
    volume.focus();
    setVolume(volume, '81');
    await waitFor(() => expect(volume).toHaveValue('81'));
    setVolume(volume, '80');
    await waitFor(() => expect(volume).toHaveValue('80'));
    volume.blur();
  },
};

export const LongName: Story = {
  name: 'Вертикальный фейдер · длинное название',
  args: { orientation: 'vertical', name: 'Сопрано — первый голос концертного хора' },
};
