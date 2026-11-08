import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
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
    await expect(canvas.getByText('Выбрано новых файлов: 2')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Создать песню' }));
    await expect(canvas.getByText(/Это макет: песня не сохранена/)).toHaveTextContent('Это макет: песня не сохранена');
  },
};
export const MissingFiles: Story = {
  name: 'Не выбраны файлы', args: { initialFilled: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Создать песню' }));
    await expect(canvas.getByText('Выберите файл для каждого трека.')).toBeVisible();
  },
};

export const Processing: Story = { name: 'Обработка аудио', args: { live: true, initialFilled: true, busy: true, status: 'Сопрано: обработка…' },
  play: async ({ canvasElement }) => { const c = within(canvasElement); await expect(c.getAllByText('Сопрано: обработка…')[0]).toBeVisible(); await expect(c.getByRole('button', { name: 'Сопрано: обработка…' })).toBeDisabled(); } };
export const UploadError: Story = { name: 'Ошибка замены файла', args: { live: true, initialFilled: true, error: 'Файл повреждён. Старая готовая дорожка сохранена.' },
  play: async ({ canvasElement }) => { await expect(within(canvasElement).getByRole('alert')).toHaveTextContent('Старая готовая дорожка сохранена'); } };

const editorSong = { title: 'Тихий вечер', bpm: 84, beatsPerBar: 4, beatUnit: 4, notes: '', tracks: [
  { id: 'voice', name: 'Сопрано', existingFileName: 'Сопрано — исходная запись с длинным названием для проверки мобильной формы и замены файла.wav' },
  { id: 'legacy', name: 'Альт', existingFileName: 'Исходное имя недоступно' },
] };
export const ReadyEditor: Story = { name: 'Редактор · имена и действия', args: { live: true, initialSong: editorSong, trackStates: [{ phase: 'ready' }, { phase: 'ready' }], publication: 'draft', audioReady: true, canListen: true, onListen: () => {}, onPublish: () => {} },
 play: async ({ canvasElement }) => { const c = within(canvasElement); await expect(c.getByText(/Исходное имя недоступно/)).toBeVisible(); await expect(c.getByRole('button', { name: 'Слушать песню' })).toBeEnabled(); } };
const failedFile = new File([], 'Неудачная замена.wav');
const completedFile = new File([], 'Альт — новая запись.mp3');
export const ReplacementFailed: Story = { name: 'Редактор · отказ замены', args: { ...ReadyEditor.args,
 initialSong: { ...editorSong, tracks: [{ ...editorSong.tracks[0]!, file: failedFile, audioReady: true }, editorSong.tracks[1]!] },
 trackStates: [{ phase: 'error', file: failedFile, detail: 'Файл повреждён. Выберите другой файл.' }, { phase: 'ready' }], onRetryFile: fn() },
 play: async ({ canvasElement, args }) => { const c = within(canvasElement);
   await expect(c.getByText('Новый файл:').parentElement).toHaveTextContent('Неудачная замена.wav');
   await userEvent.click(c.getByRole('button', { name: 'Повторить загрузку' }));
   await expect(args.onRetryFile).toHaveBeenCalledWith(0, failedFile);
   await userEvent.click(c.getByRole('button', { name: 'Отменить выбор файла трека 1' }));
   await expect(c.queryByText('Новый файл:')).not.toBeInTheDocument();
   await expect(c.getByText(/Сопрано — исходная запись/)).toBeVisible();
 } };
export const TrackProcessing: Story = { name: 'Редактор · загрузка и обработка', args: { ...ReadyEditor.args,
 initialSong: { ...editorSong, tracks: [{ ...editorSong.tracks[0]!, file: failedFile }, { ...editorSong.tracks[1]!, file: completedFile }] },
 busy: true, trackStates: [{ phase: 'uploading', file: failedFile, progress: 48, locked: true }, { phase: 'waiting', file: completedFile }], audioReady: false, canListen: false, status: 'Загружаем файлы…' } };
export const MixedResult: Story = { name: 'Замены · готово 2 из 3', args: { ...ReplacementFailed.args,
 initialSong: { ...editorSong, tracks: [{ ...editorSong.tracks[0]!, file: failedFile, audioReady: true }, { id: 'alto', name: 'Альт', file: completedFile, existingFileName: completedFile.name, audioReady: true }, { id: 'bass', name: 'Бас', file: completedFile, existingFileName: 'Бас.mp3', audioReady: true }] },
 trackStates: [{ phase: 'error', file: failedFile, detail: 'Файл повреждён. Выберите другой файл.' }, { phase: 'ready', file: completedFile }, { phase: 'ready', file: completedFile }],
 }, play: async ({ canvas, args }) => {
   await expect(canvas.getByRole('progressbar', { name: 'Готовность новых файлов' })).toHaveAttribute('value', '2');
   await userEvent.click(canvas.getByRole('button', { name: 'К проблеме' }));
   await expect(document.activeElement).toContainElement(canvas.getByRole('button', { name: 'Повторить загрузку' }));
   await userEvent.click(canvas.getByRole('button', { name: 'Повторить загрузку' }));
   await expect(args.onRetryFile).toHaveBeenCalledWith(0, failedFile);
 } };
export const UnknownResult: Story = { name: 'Замена · результат неизвестен', args: { ...ReplacementFailed.args, trackStates: [{ phase: 'unknown', file: failedFile, locked: true, detail: 'Проверьте соединение и запросите результат ещё раз.' }, { phase: 'ready' }] },
 play: async ({ canvas, args }) => {
   await expect(canvas.queryByRole('button', { name: 'Отменить выбор файла трека 1' })).not.toBeInTheDocument();
   await expect(canvas.getByRole('button', { name: 'Заменить файл трека 1' })).toBeDisabled();
   await userEvent.click(canvas.getByRole('button', { name: 'Проверить ещё раз' }));
   await expect(args.onRetryFile).toHaveBeenCalledWith(0, failedFile);
 } };
export const ServerProcessing: Story = { name: 'Сервер · очередь и обработка', args: { ...ReadyEditor.args, trackStates: [{ phase: 'queued', locked: true }, { phase: 'processing', locked: true }] } };
export const EmptyEditor: Story = { name: 'Редактор · без аудио', args: { ...ReadyEditor.args, initialSong: { ...editorSong, tracks: [{ id: 'empty', name: 'Сопрано' }] }, trackStates: [{ phase: 'empty' }], audioReady: false, canListen: false } };
