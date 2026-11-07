import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fireEvent, userEvent, waitFor, within } from 'storybook/test';
import { WorkflowPrototype } from './WorkflowPrototype';

const meta = {
  id: 'workflows-design', title: 'Сценарии/Преподаватель и администратор',
  component: WorkflowPrototype,
  parameters: { layout: 'fullscreen', docs: { description: { component: 'Первый интерактивный UX-вариант. Только вымышленные данные в памяти Storybook: нет API-запросов, загрузки аудио или настоящих учётных записей. Ссылки example.invalid — образцы. Учитель и администратор показаны отдельными stories.' } } },
  args: { role: 'teacher', initialScreen: 'songs', scenario: 'ready' },
} satisfies Meta<typeof WorkflowPrototype>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Teacher: Story = { name: 'Преподаватель · рабочий флоу' };
async function listSettings(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: 'Действия со ссылкой: elena@example.invalid' }));
  await userEvent.click(canvas.getByRole('button', { name: 'Настройки ссылки' }));
  const dialog = within(await canvas.findByRole('dialog'));
  await dialog.findByRole('textbox', { name: 'Адрес для учеников' });
  return dialog;
}
export const Sharing: Story = { name: 'Ссылка на репертуар · настройки', play: async ({ canvasElement }) => { await listSettings(canvasElement); } };
export const Administrator: Story = { name: 'Администратор · аккаунты', args: { role: 'admin', initialScreen: 'accounts' } };
export const Mobile: Story = { name: 'Преподаватель · 360 px', globals: { viewport: { value: 'mobile360', isRotated: false } } };
export const MobileAccounts: Story = { name: 'Аккаунты · 360 px', args: { role: 'admin', initialScreen: 'accounts' }, globals: { viewport: { value: 'mobile360', isRotated: false } } };
export const Empty: Story = { name: 'Песен пока нет', args: { scenario: 'empty' } };
export const Loading: Story = { name: 'Загрузка песен', args: { scenario: 'loading' } };
export const Error: Story = { name: 'Ошибка загрузки · повтор', args: { scenario: 'error' } };
export const AccountsEmpty: Story = { name: 'Первый преподаватель', args: { role: 'admin', initialScreen: 'accounts', scenario: 'empty' } };
export const AccountsLoading: Story = { name: 'Загрузка аккаунтов', args: { role: 'admin', initialScreen: 'accounts', scenario: 'loading' } };
export const AccountsError: Story = { name: 'Ошибка загрузки аккаунтов', args: { role: 'admin', initialScreen: 'accounts', scenario: 'error' } };
// UI boundary: confirms a teacher understands the scope and can cancel a destructive action.
// Existing runtime tests own server authorization, revocation and persistence.
export const ShareFlow: Story = { name: 'Проверка · состав списка и отмена отзыва', play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  let dialog = await listSettings(canvasElement);
  await userEvent.click(dialog.getByRole('button', { name: 'Посмотреть как ученик' }));
  const list = within(canvas.getByRole('list', { name: 'Песни' }));
  await expect(list.getByRole('button', { name: /Тихий вечер/ })).toBeVisible();
  await expect(list.queryByRole('button', { name: /Утро/ })).not.toBeInTheDocument();
  await expect(list.queryByRole('button', { name: /Весенняя песня/ })).not.toBeInTheDocument();
  await userEvent.click(canvas.getByRole('button', { name: /Завершить предпросмотр/ }));
  dialog = await listSettings(canvasElement);
  const before = (dialog.getByRole('textbox', { name: 'Адрес для учеников' }) as HTMLInputElement).value;
  await userEvent.click(dialog.getByRole('button', { name: 'Отключить ссылку' }));
  await expect(dialog.getByRole('button', { name: 'Отмена' })).toHaveFocus();
  await userEvent.tab();
  await expect(dialog.getByRole('button', { name: 'Закрыть настройки ссылки' })).toHaveFocus();
  await userEvent.tab({ shift: true });
  await expect(dialog.getByRole('button', { name: 'Отмена' })).toHaveFocus();
  await expect(dialog.getByText('elena@example.invalid')).toBeVisible();
  await userEvent.click(dialog.getByRole('button', { name: 'Отмена' }));
  await expect(dialog.getByRole('textbox', { name: 'Адрес для учеников' })).toHaveValue(before);
  // Synthetic keyboard events cannot invoke the browser's native dialog default.
  fireEvent(canvas.getByRole('dialog'), new Event('cancel', { cancelable: true }));
  await waitFor(() => expect(canvas.queryByRole('dialog')).not.toBeInTheDocument());
  await waitFor(() => expect(canvas.getByRole('button', { name: 'Действия со ссылкой: elena@example.invalid' })).toHaveFocus());
} };
// UI boundary: the confirmation must name the target; cancelling must leave access unchanged.
export const AccountFlow: Story = { name: 'Проверка · блокировка и восстановление', args: { role: 'admin', initialScreen: 'accounts' }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: /elena@example.invalid/ }));
  await userEvent.click(canvas.getByRole('button', { name: 'Заблокировать' }));
  await expect(canvas.getByRole('alert')).toHaveTextContent('elena@example.invalid');
  await userEvent.click(canvas.getByRole('button', { name: 'Отмена' }));
  await expect(canvas.getByText('Активен', { exact: true })).toBeVisible();
  await userEvent.click(canvas.getByRole('button', { name: 'Заблокировать' }));
  await userEvent.click(canvas.getByRole('button', { name: 'Подтвердить блокировку' }));
  await expect(canvas.getByText('Заблокирован', { exact: true })).toBeVisible();
  await userEvent.click(canvas.getByRole('button', { name: 'Разблокировать' }));
  await expect(canvas.getByText('Активен', { exact: true })).toBeVisible();
} };




// A newly created teacher must be visible even when the initial list has no teachers.
export const FirstTeacherFlow: Story = { name: 'Проверка · создать первого преподавателя', args: { role: 'admin', initialScreen: 'accounts', scenario: 'empty' }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: 'Преподаватель' }));
  const setValue = (input: HTMLElement, value: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    fireEvent.input(input, { bubbles: true });
  };
  setValue(canvas.getByRole('textbox', { name: 'Email преподавателя' }), 'new.teacher@example.invalid');
  setValue(canvas.getByLabelText('Временный пароль'), 'Fictional password 2026');
  await userEvent.click(canvas.getByRole('button', { name: 'Создать преподавателя' }));
  await expect(canvas.getByRole('button', { name: /new.teacher@example.invalid/ })).toBeVisible();
  await userEvent.click(canvas.getByRole('button', { name: /new.teacher@example.invalid/ }));
  await userEvent.click(canvas.getByRole('button', { name: 'Сбросить пароль' }));
  await expect(canvas.getByLabelText('Временный пароль')).toHaveValue('');
  setValue(canvas.getByLabelText('Временный пароль'), 'short');
  await userEvent.click(canvas.getByRole('button', { name: 'Сбросить пароль' }));
  await expect(canvas.getByRole('alert')).toHaveTextContent('от 12 до 128');
  setValue(canvas.getByLabelText('Временный пароль'), 'Different fictional password');
  await userEvent.click(canvas.getByRole('button', { name: 'Сбросить пароль' }));
  await expect(canvas.getByRole('status')).toHaveTextContent('при входе потребуется сменить пароль');
} };
export const PublishFlow: Story = { name: 'Проверка · переключатель публикации', play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole('switch', { name: 'Публикация: Весенняя песня' })).toBeDisabled();
  const morning = canvas.getByRole('switch', { name: 'Публикация: Утро' });
  await expect(morning).not.toBeChecked();
  await userEvent.click(morning);
  await expect(morning).toBeChecked();
  await expect(canvas.getByRole('heading', { name: /^Песни/ })).toBeVisible();
  await expect(canvas.getByRole('status')).toHaveTextContent('«Утро» опубликована');
  const dialog = await listSettings(canvasElement);
  await userEvent.click(dialog.getByRole('button', { name: 'Посмотреть как ученик' }));
  await expect(canvas.getByRole('list')).toHaveTextContent('Утро');
  await expect(canvas.getByRole('list')).not.toHaveTextContent('Весенняя песня');
  await expect(canvas.queryByRole('switch')).not.toBeInTheDocument();
  await userEvent.click(canvas.getByRole('button', { name: /Завершить предпросмотр/ }));
  await userEvent.click(canvas.getByRole('switch', { name: 'Публикация: Утро' }));
  await expect(canvas.getByRole('switch', { name: 'Публикация: Утро' })).not.toBeChecked();
  await listSettings(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: 'Посмотреть как ученик' }));
  await expect(canvas.getByRole('list')).not.toHaveTextContent('Утро');
} };

// Saved edits can make previously published audio incomplete; sharing must recheck readiness.
export const PublishedEditFlow: Story = { name: 'Проверка · неготовая партия после публикации', play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: 'Редактировать: Тихий вечер' }));
  await userEvent.selectOptions(canvas.getByRole('combobox', { name: 'Количество треков' }), '6');
  await expect(canvas.getByText('Выбрано файлов: 5 из 6')).toBeVisible();
  await userEvent.click(canvas.getByRole('button', { name: 'Сохранить изменения' }));
  const dialog = await listSettings(canvasElement);
  await userEvent.click(dialog.getByRole('button', { name: 'Посмотреть как ученик' }));
  await expect(canvas.getByRole('list')).not.toHaveTextContent('Тихий вечер');
  await expect(canvas.getByRole('list')).toHaveTextContent('Дорога домой');
  await expect(canvas.queryByRole('button', { name: 'Тихий вечер' })).not.toBeInTheDocument();
  await expect(canvas.getByRole('button', { name: 'Дорога домой' })).toBeVisible();
} };
