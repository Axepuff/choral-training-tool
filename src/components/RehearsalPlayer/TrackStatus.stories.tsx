import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { TrackStatus } from './TrackStatus';

const meta = { title: 'Компоненты/Состояние дорожки', component: TrackStatus, args: { name: 'Верхний', state: 'Готово' } } satisfies Meta<typeof TrackStatus>;
export default meta;
type Story = StoryObj<typeof meta>;

export const States: Story = {
  name: 'Готово, ожидание, загрузка, предупреждение, ошибка',
  render: () => <div style={{ display: 'flex', flexWrap: 'wrap' }}>
    <TrackStatus name="Верхний" state="Готово" />
    <TrackStatus name="Ожидание" />
    <TrackStatus name="Средний" state="Загрузка…" />
    <TrackStatus name="Нижний" state="Готово · волна недоступна" />
    <TrackStatus name="Минус" state="Аудио недоступно. Ссылка могла быть отозвана." />
  </div>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const status = canvas.getByRole('button', { name: 'Состояние: Минус. Аудио недоступно. Ссылка могла быть отозвана.' });
    await userEvent.click(status);
    await expect(canvas.getByText('Аудио недоступно. Ссылка могла быть отозвана.', { exact: true })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Закрыть' }));
    await expect(canvas.getByText('Аудио недоступно. Ссылка могла быть отозвана.', { exact: true })).not.toBeVisible();
  },
};
