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

export const Processing: Story = { name: 'Обработка аудио', args: { live: true, initialFilled: true, busy: true, status: 'Сопрано: обработка…' },
  play: async ({ canvasElement }) => { const c = within(canvasElement); await expect(c.getByRole('status')).toHaveTextContent('обработка'); await expect(c.getByRole('button', { name: 'Создать песню' })).toBeDisabled(); } };
export const UploadError: Story = { name: 'Ошибка замены файла', args: { live: true, initialFilled: true, error: 'Файл повреждён. Старая готовая дорожка сохранена.' },
  play: async ({ canvasElement }) => { await expect(within(canvasElement).getByRole('alert')).toHaveTextContent('Старая готовая дорожка сохранена'); } };

const editorSong = { title: 'Тихий вечер', bpm: 84, beatsPerBar: 4, beatUnit: 4, notes: '', tracks: [
  { id: 'voice', name: 'Сопрано', existingFileName: 'Сопрано — исходная запись с длинным названием для проверки мобильной формы и замены файла.wav' },
  { id: 'legacy', name: 'Альт', existingFileName: 'Исходное имя недоступно' },
] };
export const ReadyEditor: Story = { name: 'Редактор · имена и действия', args: { live: true, initialSong: editorSong, trackStates: ['Готово', 'Готово'], publication: 'draft', audioReady: true, canListen: true, onListen: () => {}, onPublish: () => {} },
 play: async ({ canvasElement }) => { const c = within(canvasElement); await expect(c.getByText('Исходное имя недоступно')).toBeVisible(); await expect(c.getByRole('button', { name: 'Слушать песню' })).toBeEnabled(); } };
export const ReplacementFailed: Story = { name: 'Редактор · отказ замены', args: { ...ReadyEditor.args, trackStates: ['Ошибка обработки. Сохранённый файл не изменён.', 'Готово'], error: 'Не удалось обработать замену. Выберите другой файл.' },
 play: async ({ canvasElement }) => { const c = within(canvasElement);
   await userEvent.upload(c.getByLabelText('Аудиофайл трека 1'), new File([], 'Неудачная замена.wav'));
   await expect(c.getByText('Неудачная замена.wav')).toBeVisible();
   await expect(c.getByText('Сохранённый файл: ' + editorSong.tracks[0]!.existingFileName)).toBeVisible();
   await userEvent.click(c.getByRole('button', { name: 'Убрать файл трека 1' }));
   await expect(c.queryByText('Неудачная замена.wav')).not.toBeInTheDocument();
   await expect(c.getByText(editorSong.tracks[0]!.existingFileName)).toBeVisible();
 } };
export const TrackProcessing: Story = { name: 'Редактор · загрузка и обработка', args: { ...ReadyEditor.args, busy: true, trackStates: ['Загрузка 48%', 'Обработка…'], audioReady: false, canListen: false, status: 'Сохраняем данные…' } };
export const EmptyEditor: Story = { name: 'Редактор · без аудио', args: { ...ReadyEditor.args, initialSong: { ...editorSong, tracks: [{ id: 'empty', name: 'Сопрано' }] }, trackStates: ['Файл не загружен'], audioReady: false, canListen: false } };
