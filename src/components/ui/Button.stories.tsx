import type { Meta, StoryObj } from '@storybook/react-vite';
import { useRef, useState } from 'react';
import { expect, userEvent } from 'storybook/test';
import { Button } from './Button';

const meta = { title: 'UI/Button', component: Button, tags: ['autodocs'] } satisfies Meta<typeof Button>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Variants: Story = {
  render: () => <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
    <Button>Обычная</Button><Button variant="primary">Сохранить</Button>
    <Button variant="text">Назад</Button><Button variant="danger">Удалить</Button><Button variant="dangerText">Отозвать</Button>
    <Button variant="play" aria-label="Воспроизвести">▶</Button>
    <Button variant="solo" size="icon" aria-pressed>S</Button><Button variant="mute" size="icon" aria-pressed>M</Button>
    <Button aria-pressed>Повтор</Button><Button variant="tab" aria-current="page">Песни</Button>
    <Button variant="row">teacher@example.invalid</Button><Button variant="title">Тихий вечер</Button>
    <Button variant="switch" size="icon" role="switch" aria-checked aria-label="Публикация"><span><span /></span></Button>
    <Button disabled>Недоступно</Button><Button variant="primary" size="form" disabled aria-busy>Сохраняем…</Button>
  </div>,
};

export const NativeForm: Story = {
  render: function NativeForm() {
    const [submitted, setSubmitted] = useState(0);
    const [paused, setPaused] = useState(false);
    const button = useRef<HTMLButtonElement>(null);
    return <form onSubmit={event => { event.preventDefault(); setSubmitted(value => value + 1); }}>
      <Button ref={button} aria-busy onClick={() => { setPaused(true); button.current?.focus(); }}>Пауза</Button>
      <Button type="submit" variant="primary">Отправить</Button><Button disabled>Недоступно</Button>
      <output>{submitted} отправок · {paused ? 'Пауза' : 'Загрузка'}</output>
    </form>;
  },
  play: async ({ canvas }) => {
    const pause = canvas.getByRole('button', { name: 'Пауза' });
    await userEvent.click(pause);
    await expect(pause).toHaveFocus();
    await expect(canvas.getByText('0 отправок · Пауза')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Отправить' }));
    await expect(canvas.getByText('1 отправок · Пауза')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Недоступно' })).toBeDisabled();
  },
};
