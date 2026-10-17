import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { SongLibrary } from './SongLibrary';

const meta = {
  id: 'pages-song-library', title: 'Страницы/Список песен', component: SongLibrary,
  parameters: { layout: 'fullscreen', docs: { description: { component: 'Библиотека на моках. Роли в stories демонстрируют видимость, серверное разграничение прав пока не реализовано. Ссылки открывают макет плеера; реальные публичные токены появятся на backend.' } } },
} satisfies Meta<typeof SongLibrary>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = { name: 'Мои песни' };
export const Mobile: Story = { name: 'Мобильный · 360 px', globals: { viewport: { value: 'mobile360', isRotated: false } } };
export const Admin: Story = { name: 'Все песни · администратор', args: { role: 'admin' } };
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
    await expect(canvas.getByRole('link', { name: 'Тихий вечер' })).toBeVisible();
    await userEvent.clear(search);
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: 'Порядок песен' }), 'title');
    await expect(within(canvas.getAllByRole('listitem')[0]!).getByRole('link', { name: 'Дорога домой' })).toBeVisible();
  },
};
