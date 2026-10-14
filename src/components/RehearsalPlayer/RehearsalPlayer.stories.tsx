import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { RehearsalPlayer } from './RehearsalPlayer';

const meta = {
  id: 'layouts-rehearsal-player',
  title: 'Макеты/Плеер репетиции',
  component: RehearsalPlayer,
  parameters: {
    layout: 'fullscreen',
    docs: { description: { component: 'Пять дорожек на общей сетке из четырёх тактов 4/4. Курсор, Solo/Mute, громкость, повтор тактов 2–3 и визуальный метроном работают на локальных моках. Звук не воспроизводится.' } },
  },
  args: { initialTime: 0, initialPlaying: false, initialLoop: false },
} satisfies Meta<typeof RehearsalPlayer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  name: 'Репетиция',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole('group', { name: /^Партия:/ })).toHaveLength(5);
    await userEvent.click(canvas.getByRole('button', { name: 'Воспроизвести' }));
    await expect(canvas.getByRole('button', { name: 'Пауза' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Пауза' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Вернуться к началу' }));
    await expect(canvas.getByRole('slider', { name: 'Позиция воспроизведения' })).toHaveValue('0');
    const repeat = canvas.getByRole('button', { name: 'Повтор фрагмента' });
    await userEvent.click(repeat);
    await expect(repeat).toHaveAttribute('aria-pressed', 'true');
    await expect(canvas.getByText('Повтор: такты 2–3')).toBeVisible();
    await userEvent.click(repeat);
    const metronome = canvas.getByRole('button', { name: 'Метроном' });
    await userEvent.click(metronome);
    await expect(metronome).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(metronome);
  },
};

export const Playing: Story = { name: 'Воспроизведение', args: { initialPlaying: true, initialTime: 1 } };
export const FragmentLoop: Story = { name: 'Повтор фрагмента', args: { initialLoop: true, initialTime: 4 } };
export const Mobile: Story = {
  name: 'Мобильный · 360 px',
  globals: { viewport: { value: 'mobile360', isRotated: false } },
};
export const Desktop: Story = {
  name: 'Десктоп · 1280 px',
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
};
