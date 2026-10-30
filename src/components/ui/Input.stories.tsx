import type { Meta, StoryObj } from '@storybook/react-vite';
import { useRef, useState } from 'react';
import { expect, userEvent } from 'storybook/test';
import { Input } from './Input';
import { Button } from './Button';

const meta = { title: 'UI/Input', component: Input, tags: ['autodocs'] } satisfies Meta<typeof Input>;
export default meta;
type Story = StoryObj<typeof meta>;
export const NativeForm: Story = {
  render: function NativeForm() {
    const input = useRef<HTMLInputElement>(null);
    const [saved, setSaved] = useState('');
    return <form onSubmit={event => { event.preventDefault(); setSaved(String(new FormData(event.currentTarget).get('title'))); input.current?.focus(); }}>
      <label>Название<Input ref={input} name="title" required maxLength={160} defaultValue="Тихий" /></label>
      <Button type="submit">Сохранить</Button><output>{saved}</output>
    </form>;
  },
  play: async ({ canvas }) => {
    const input = canvas.getByRole('textbox', { name: 'Название' });
    await userEvent.type(input, ' вечер');
    await userEvent.click(canvas.getByRole('button', { name: 'Сохранить' }));
    await expect(canvas.getByRole('status')).toHaveTextContent('Тихий вечер');
    await expect(input).toHaveFocus();
  },
};
export const States: Story = {
  render: () => <div style={{ display: 'grid', gap: 16 }}>
    <label>Email<Input type="email" density="large" placeholder="teacher@example.invalid" /></label>
    <label>Пароль<Input type="password" defaultValue="fictional-example" /></label>
    <label>Поиск<Input type="search" placeholder="Найти песню" /></label>
    <label>Первый такт<Input type="number" min={1} max={16} step={1} defaultValue={2} /></label>
    <label>Ссылка<Input readOnly value="https://example.invalid/songs" /></label>
    <label>Недоступно<Input disabled value="Загрузка" /></label>
    <label>Ошибка<Input aria-invalid aria-describedby="field-error" defaultValue="" /></label>
    <p id="field-error">Укажите название.</p>
  </div>,
};
