import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { mockSongs } from './mockSongs';
import { SongLibrary } from './SongLibrary';

const meta = {
  args: { role: 'teacher', songs: mockSongs },
  id: 'pages-song-library', title: 'Страницы/Список песен', component: SongLibrary,
  parameters: { layout: 'fullscreen', docs: { description: { component: 'Библиотека на явных fixtures. Роли в stories демонстрируют видимость; сервер проверяет права независимо. Ссылки stories открывают макет плеера, а runtime использует публичные токены.' } } },
} satisfies Meta<typeof SongLibrary>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = { name: 'Песни' };
export const Mobile: Story = { name: 'Мобильный · 360 px', globals: { viewport: { value: 'mobile360', isRotated: false } } };
export const Admin: Story = { name: 'Администратор', args: { role: 'admin' } };
export const Empty: Story = { name: 'Пока нет песен', args: { songs: [] } };
export const NoResults: Story = { name: 'Ничего не найдено', args: { initialQuery: 'Неизвестная песня' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'Песня не найдена' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Сбросить поиск' }));
    await expect(canvas.getAllByRole('listitem')).toHaveLength(3);
  },
};
export const Search: Story = { name: 'Поиск и сортировка',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const search = canvas.getByRole('searchbox', { name: 'Найти песню' });
    await userEvent.type(search, 'ТИХИЙ');
    await expect(canvas.getAllByRole('listitem')).toHaveLength(1);
    await expect(canvas.getByRole('link', { name: 'Открыть: Тихий вечер' })).toBeVisible();
    await userEvent.clear(search);
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: 'Порядок песен' }), 'title');
    await expect(within(canvas.getAllByRole('listitem')[0]!).getByRole('link', { name: 'Открыть: Дорога домой' })).toBeVisible();
  },
};

export const SharedReadOnly: Story = {
  name: 'По ссылке · только просмотр', args: { role: 'guest' },
  globals: { viewport: { value: 'mobile360', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole('link', { name: 'Создать песню' })).not.toBeInTheDocument();
    await expect(canvas.queryByRole('button', { name: /^Редактировать:/ })).not.toBeInTheDocument();
    await expect(canvas.queryByRole('button', { name: 'Ссылка на список' })).not.toBeInTheDocument();
    await expect(canvas.getAllByRole('listitem')).toHaveLength(2);
    await expect(canvas.getByRole('link', { name: 'Открыть: Тихий вечер' })).toBeVisible();
  },
};
export const Editing: Story = {
  name: 'Редактирование песни',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Редактировать: Тихий вечер' }));
    await expect(canvas.getByRole('heading', { name: 'Редактировать песню' })).toBeVisible();
    await expect(canvas.getByRole('textbox', { name: 'Название песни' })).toHaveValue('Тихий вечер');
    await expect(canvas.getByText('Выбрано файлов: 5 из 5')).toBeVisible();
  },
};
export const SaveChanges: Story = {
  name: 'Сохранение изменений · мок',
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Редактировать: Тихий вечер' }));
    const title = canvas.getByRole('textbox', { name: 'Название песни' });
    await userEvent.clear(title); await userEvent.type(title, 'Вечерняя песня');
    await userEvent.click(canvas.getByRole('button', { name: 'Сохранить изменения' }));
    await expect(canvas.getByRole('link', { name: 'Открыть: Вечерняя песня' })).toBeVisible();
    await expect(canvas.getByRole('status')).toHaveTextContent('Изменения сохранены в макете');
  },
};

export const ManySongs: Story = {
  name: 'Длинный список · 360 px',
  globals: { viewport: { value: 'mobile360', isRotated: false } },
  args: { songs: Array.from({ length: 16 }, (_, index) => ({
    id: `demo-${index}`, title: index === 3 ? 'Очень длинное название произведения для репетиции смешанного хора' : `Песня ${index + 1}`,
    bpm: 84, meter: '4/4', tracks: 5, bars: 4 as const,
    owner: 'Преподаватель', updatedAt: '2026-10-17', shared: index % 3 !== 0,
  })) },
};
