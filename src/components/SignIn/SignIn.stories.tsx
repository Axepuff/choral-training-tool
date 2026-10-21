import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { SignIn } from './SignIn';
import type { SignInResult } from './SignIn';

const meta = {
  id: 'pages-sign-in',
  title: 'Страницы/Вход',
  component: SignIn,
  parameters: {
    layout: 'fullscreen',
    docs: { description: { component: 'Email + пароль для преподавателя и администратора. Роль определяется сервером, участники слушают по ссылке без входа. Все ответы в stories — явные моки без передачи данных и сессий. Приложение использует отдельный реальный API-адаптер.' } },
  },
} satisfies Meta<typeof SignIn>;
export default meta;
type Story = StoryObj<typeof meta>;

async function fillAndSubmit(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.type(canvas.getByLabelText('Email', { exact: true }), 'teacher@example.com');
  await userEvent.type(canvas.getByLabelText('Пароль', { exact: true }), 'storybook-example');
  await userEvent.click(canvas.getByRole('button', { name: 'Войти' }));
}

export const Default: Story = { name: 'Вход' };
export const Mobile: Story = {
  name: 'Мобильный · 360 px',
  globals: { viewport: { value: 'mobile360', isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const password = canvas.getByLabelText('Пароль', { exact: true });
    const toggle = canvas.getByRole('button', { name: 'Показать пароль' });
    await userEvent.type(password, 'storybook-example');
    await userEvent.click(toggle);
    await expect(password).toHaveAttribute('type', 'text');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(toggle);
    await expect(password).toHaveAttribute('type', 'password');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await userEvent.clear(password);
  },
};
export const Checking: Story = {
  name: 'Проверка данных',
  args: { onSignIn: fn(() => new Promise<SignInResult>(() => {})) },
  play: async ({ canvasElement, args }) => {
    await fillAndSubmit(canvasElement);
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: 'Входим…' })).toBeDisabled();
    await expect(canvas.getByRole('form')).toHaveAttribute('aria-busy', 'true');
    await expect(args.onSignIn).toHaveBeenCalledTimes(1);
    await expect(canvas.getByRole('status')).toHaveTextContent('Проверяем данные');
  },
};
export const InvalidCredentials: Story = {
  name: 'Неверные данные',
  args: { onSignIn: fn(async () => 'invalid-credentials' as const) },
  play: async ({ canvasElement }) => {
    await fillAndSubmit(canvasElement);
    await expect(within(canvasElement).getByRole('alert')).toHaveTextContent('Неверный email или пароль');
  },
};
export const Unavailable: Story = {
  name: 'Ошибка соединения',
  args: { onSignIn: fn(async () => { throw new Error('Mock connection error'); }) },
  play: async ({ canvasElement }) => {
    await fillAndSubmit(canvasElement);
    await expect(within(canvasElement).getByRole('alert')).toHaveTextContent('Не удалось войти');
  },
};
export const Success: Story = {
  name: 'Успешный ответ · мок',
  args: { onSignIn: fn(async () => 'authenticated' as const) },
  play: async ({ canvasElement }) => {
    await fillAndSubmit(canvasElement);
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status')).toHaveTextContent('Вход выполнен');
    await expect(canvas.getByLabelText('Пароль', { exact: true })).toHaveValue('');
  },
};
export const Demo: Story = {
  name: 'Без подключённого backend',
  play: async ({ canvasElement }) => {
    await fillAndSubmit(canvasElement);
    await expect(within(canvasElement).getByRole('status')).toHaveTextContent('Это макет: данные не отправлены');
  },
};
