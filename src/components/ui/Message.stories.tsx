import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';
import { Message } from './Message';
import { Input } from './Input';

const meta = { title: 'UI/Message', component: Message, tags: ['autodocs'] } satisfies Meta<typeof Message>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Feedback: Story = {
  render: () => <div>
    <label>Название<Input aria-invalid aria-describedby="title-error" /></label>
    <Message id="title-error" role="alert" tone="error" variant="banner">Укажите название песни.</Message>
    <Message role="status" aria-live="polite" aria-atomic="true" tone="info" variant="banner">Изменения сохранены.</Message>
    <Message as="span" role="status" variant="spinner" aria-label="Загрузка аудио" />
    <Message size="small">Файлы обрабатываются.</Message>
  </div>,
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('textbox', { name: 'Название' })).toHaveAccessibleDescription('Укажите название песни.');
    await expect(canvas.getByRole('alert')).toHaveTextContent('Укажите название песни.');
    await expect(canvas.getByRole('status', { name: 'Загрузка аудио' })).toBeVisible();
  },
};
