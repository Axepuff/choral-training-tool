import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fireEvent, userEvent, waitFor, within } from 'storybook/test';
import { RehearsalPlayer } from './RehearsalPlayer';

const meta = {
  id: 'layouts-rehearsal-player',
  title: 'Макеты/Плеер репетиции',
  component: RehearsalPlayer,
  parameters: {
    layout: 'fullscreen',
    docs: { description: { component: 'Общий таймлайн с наложением пяти цветных волн, верхний транспорт и пять колонок микшера с вертикальными фейдерами. Курсор, Solo/Mute, громкость, выбор тактов повтора и визуальный метроном работают на локальных моках. Звук не воспроизводится.' } },
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
    for (const slider of canvas.getAllByRole('slider', { name: /^Громкость:/ })) {
      await expect(slider).toHaveAttribute('aria-orientation', 'vertical');
    }
    const solos = canvas.getAllByRole('button', { name: /^Solo:/ });
    for (const button of solos.slice(0, -1)) {
      await userEvent.click(button);
      await expect(button).toHaveAttribute('aria-pressed', 'true');
    }
    await userEvent.click(solos[solos.length - 1]!);
    for (const button of solos) await expect(button).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(solos[0]!);
    await expect(solos[0]!).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(solos[0]!);
    await userEvent.click(canvas.getByRole('button', { name: 'Воспроизвести' }));
    await expect(canvas.getByRole('button', { name: 'Пауза' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Пауза' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Вернуться к началу' }));
    await expect(canvas.getByRole('slider', { name: 'Позиция воспроизведения' })).toHaveValue('0');
    const repeat = canvas.getByRole('button', { name: 'Повтор фрагмента' });
    await userEvent.click(repeat);
    await expect(repeat).toHaveAttribute('aria-pressed', 'true');
    await expect(canvas.getByText('Повтор: такты 1–1')).toBeVisible();
    await userEvent.click(repeat);
    const metronome = canvas.getByRole('button', { name: 'Метроном' });
    await userEvent.click(metronome);
    await expect(metronome).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(metronome);
  },
};

export const Playing: Story = { name: 'Воспроизведение', args: { initialPlaying: true, initialTime: 1 } };
export const FragmentLoop: Story = { name: 'Повтор фрагмента', args: { initialLoop: true, initialLoopRange: [2, 3], initialTime: 4 } };
export const Mobile: Story = {
  name: 'Мобильный · 360 px',
  globals: { viewport: { value: 'mobile360', isRotated: false } },
};
export const Desktop: Story = {
  name: 'Десктоп · 1280 px',
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
};

export const SixteenBars: Story = {
  name: '16 тактов · горизонтальная прокрутка',
  args: { bars: 16 },
  globals: { viewport: { value: 'mobile360', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const viewport = canvas.getByRole('region', { name: 'Прокрутка тактов' });
    await expect(viewport.scrollWidth).toBeGreaterThan(viewport.clientWidth);
    viewport.scrollLeft = viewport.scrollWidth;
    await expect(viewport.scrollLeft).toBeGreaterThan(0);
    const position = canvas.getByRole('slider', { name: 'Позиция воспроизведения' });
    position.focus();
    // userEvent cannot emulate a range input's native End default action.
    fireEvent.input(position, { target: { value: (position as HTMLInputElement).max } });
    await expect(Number((position as HTMLInputElement).value)).toBeGreaterThan(45);
    await userEvent.click(canvas.getByRole('button', { name: 'Вернуться к началу' }));
    await expect(position).toHaveValue('0');
    await expect(viewport.scrollLeft).toBe(0);
  },
};

export const MobileLandscape: Story = {
  name: 'Мобильный · горизонтально · 16 тактов',
  args: { bars: 16 },
  globals: { viewport: { value: 'mobile360', isRotated: true } },
};

export const SingleBar: Story = {
  name: 'Повтор · один такт и сохранение границ',
  args: { initialLoop: true, initialLoopRange: [1, 1] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Настроить' }));
    await expect(canvas.queryByRole('button', { name: 'Ввести номера' })).not.toBeInTheDocument();
    await expect(canvasElement.querySelector('input[type="number"]')).toBeNull();
    await expect(canvas.getByText('Повтор: такты 1–1')).toBeVisible();
    const start = canvas.getByRole('spinbutton', { name: 'С такта' });
    const end = canvas.getByRole('spinbutton', { name: 'По такт включительно' });
    start.focus();
    await userEvent.keyboard('{ArrowUp}');
    await expect(canvas.getByText('Повтор: такты 2–2')).toBeVisible();
    end.focus();
    await userEvent.keyboard('{ArrowUp}');
    const collapse = canvas.getByRole('button', { name: 'Свернуть' });
    collapse.focus();
    await userEvent.keyboard('{Enter}');
    await expect(collapse).toHaveAttribute('aria-expanded', 'false');
    await expect(canvas.queryByRole('spinbutton')).not.toBeInTheDocument();
    await expect(canvas.getByText('Такты 2–3 включительно')).toBeVisible();
    await userEvent.keyboard('{Enter}');
    await expect(canvas.getByRole('spinbutton', { name: 'По такт включительно' })).toHaveAttribute('aria-valuenow', '3');
  },
};
export const FullSongLoop: Story = {
  name: 'Повтор · весь длинный фрагмент',
  args: { bars: 16, initialLoop: true, initialLoopRange: [1, 16] },
  globals: { viewport: { value: 'mobile360', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const repeat = canvas.getByRole('button', { name: 'Повтор фрагмента' });
    await expect(canvas.getByText('Повтор: такты 1–16')).toBeVisible();
    await userEvent.click(repeat);
    await expect(repeat).toHaveAttribute('aria-pressed', 'false');
    await expect(canvas.getByText('Такты 1–16 включительно')).toBeVisible();
    await userEvent.click(repeat);
    await expect(repeat).toHaveAttribute('aria-pressed', 'true');
  },
};

export const ShortSong: Story = {
  name: 'Короткая песня · один такт',
  args: { bars: 1, initialLoop: true, initialLoopRange: [1, 1] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Настроить' }));
    await expect(canvas.getByRole('spinbutton', { name: 'По такт включительно' })).toHaveAttribute('aria-valuemax', '1');
    await userEvent.click(canvas.getByRole('button', { name: 'Повтор фрагмента' }));
    await expect(canvas.getByRole('button', { name: 'Повтор фрагмента' })).toHaveAttribute('aria-pressed', 'false');
  },
};

export const WheelRange: Story = {
  name: 'Барабаны · выбор и границы',
  args: { bars: 16 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Настроить' }));
    const start = canvas.getByRole('spinbutton', { name: 'С такта' });
    const end = canvas.getByRole('spinbutton', { name: 'По такт включительно' });
    start.focus();
    await userEvent.keyboard('{ArrowUp}');
    await waitFor(() => expect(start).toHaveAttribute('aria-valuenow', '2'));
    await expect(end).toHaveAttribute('aria-valuenow', '2');
    end.focus();
    await userEvent.keyboard('{End}');
    await waitFor(() => expect(end).toHaveAttribute('aria-valuenow', '16'), { timeout: 3000 });
    await userEvent.click(canvas.getByRole('button', { name: 'Повтор фрагмента' }));
    await expect(canvas.getByText('Повтор: такты 2–16')).toBeVisible();
    end.focus();
    await userEvent.keyboard('{Home}');
    await waitFor(() => expect(canvas.getByText('Повтор: такты 1–1')).toBeVisible(), { timeout: 3000 });
    await userEvent.keyboard('{ArrowDown}');
    await expect(end).toHaveAttribute('aria-valuenow', '1');
    fireEvent.wheel(end, { deltaY: 100, cancelable: true });
    await waitFor(() => expect(canvas.getByText('Повтор: такты 1–2')).toBeVisible(), { timeout: 3000 });
  },
};

export const LongScoreRange: Story = {
  name: 'Длинная песня · барабаны диапазона',
  args: { initialLoopRange: [199, 199], song: { id: 'long-score-fixture', title: 'Длинная песня', notes: '', bpm: 60,
    beatsPerBar: 1, beatUnit: 4, durationMs: 1001000, tracks: [] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Настроить' }));
    await expect(canvasElement.querySelector('input[type="number"]')).toBeNull();
    const start = canvas.getByRole('spinbutton', { name: 'С такта' });
    const end = canvas.getByRole('spinbutton', { name: 'По такт включительно' });
    // Scrolling across a window boundary must keep adjacent bars reachable.
    for (const value of [200, 201, 202]) {
      fireEvent.wheel(end, { deltaY: 100, cancelable: true });
      await waitFor(() => expect(end).toHaveAttribute('aria-valuenow', String(value)), { timeout: 3000 });
    }
    end.focus();
    await userEvent.keyboard('{End}');
    start.focus();
    await userEvent.keyboard('{End}');
    await userEvent.click(canvas.getByRole('button', { name: 'Повтор фрагмента' }));
    await expect(canvas.getByText('Повтор: такты 1001–1001')).toBeVisible();
    start.focus();
    await userEvent.keyboard('{Home}');
    await expect(canvas.getByText('Повтор: такты 1–1001')).toBeVisible();
    end.focus();
    await userEvent.keyboard('{Home}');
    await expect(canvas.getByText('Повтор: такты 1–1')).toBeVisible();
  },
};
