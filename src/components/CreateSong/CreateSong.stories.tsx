import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { CreateSong } from './CreateSong';

const meta = {
  id: 'pages-create-song',
  title: 'Страницы/Создание песни',
  component: CreateSong,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof CreateSong>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { name: 'Новая песня' };
export const Mobile: Story = {
  name: 'Мобильный · 360 px',
  globals: { viewport: { value: 'mobile360', isRotated: false } },
};
export const Filled: Story = { name: 'Заполненные поля', args: { initialFilled: true } };
export const WithFiles: Story = {
  name: 'Файлы выбраны', args: { initialFilled: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: 'Количество треков' }), '2');
    for (let index = 1; index <= 2; index++) {
      // Empty local fixtures only demonstrate selection; no audio is processed.
      await userEvent.upload(canvas.getByLabelText(`Аудиофайл трека ${index}`), new File([], `Партия-${index}.flac`, { type: 'audio/flac' }));
    }
    await expect(canvas.getByText('Выбрано файлов: 2 из 2')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Создать песню' }));
    await expect(canvas.getByRole('status')).toHaveTextContent('Это макет: песня не сохранена');
  },
};
export const MissingFiles: Story = {
  name: 'Не выбраны файлы', args: { initialFilled: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Создать песню' }));
    await expect(canvas.getByRole('status')).toHaveTextContent('Выберите файл для каждого трека.');
  },
};
