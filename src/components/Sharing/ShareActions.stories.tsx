import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, spyOn, userEvent, waitFor, within } from 'storybook/test';
import { useState } from 'react';
import { ShareActions } from './ShareActions';
import type { ShareActionsProps } from './ShareActions';
import { sharingFixture } from '../../stories/workflows/sharingFixture';
import type { SharingScenario } from '../../stories/workflows/sharingFixture';
import type { PermanentState, SharingService } from '../../api/shares';
import { SongLibrary } from '../SongLibrary/SongLibrary';
import { Select } from '../ui/Select';
import { Button } from '../ui/Button';
import libraryStyles from '../SongLibrary/SongLibrary.module.css';

function Fixture({ scenario = 'ready', unavailable = false, empty = false, admin = false }: { scenario?: SharingScenario; unavailable?: boolean; empty?: boolean; admin?: boolean }) {
  const [service] = useState(() => sharingFixture(scenario));
  const [owner, setOwner] = useState(admin ? '' : 'elena@example.invalid');
  const songTarget: ShareActionsProps['target'] = { scope: { kind: 'song', songId: 'evening' }, title: 'Тихий вечер — переложение для смешанного хора и фортепиано', ownerLabel: 'elena@example.invalid', unavailable: unavailable ? 'Сначала опубликуйте её в редакторе.' : undefined };
  return <SongLibrary role={admin ? 'admin' : 'teacher'} songs={empty ? [] : [{ id: 'evening', title: songTarget.title!, bpm: 84, meter: '4/4', tracks: 5, bars: 16, owner: 'Преподаватель', updatedAt: '2026-11-07', shared: true }]}
    shareActions={<>{admin && <label className={libraryStyles.shareOwner}>Чей репертуар передать<Select name="shareOwner" value={owner} onChange={event => setOwner(event.target.value)}><option value="">Выберите преподавателя</option><option>elena@example.invalid</option><option>mikhail@example.invalid</option></Select></label>}
      <ShareActions kind="list" service={service} target={owner ? { scope: { kind: 'list', ownerId: owner }, ownerLabel: owner, empty } : null} />
    </>}
    songActions={() => <ShareActions kind="song" service={service} target={songTarget} />} />;
}
const meta = { id: 'sharing', title: 'Ссылки/Постоянный доступ', component: Fixture, parameters: { layout: 'fullscreen', docs: { description: { component: 'Общий прикладной ShareActions: runtime, эти stories и WorkflowPrototype используют один интерфейс и dialog. Только сервис этой story работает с вымышленными данными example.invalid.' } } } } satisfies Meta<typeof Fixture>;
export default meta;
type Story = StoryObj<typeof meta>;
async function settings(canvasElement: HTMLElement, name = 'elena@example.invalid') {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: `Действия со ссылкой: ${name}` }));
  await userEvent.click(canvas.getByRole('button', { name: 'Настройки ссылки' }));
  return within(await canvas.findByRole('dialog'));
}
export const Teacher: Story = {};
export const Administrator: Story = { args: { admin: true } };
// A long copy receipt must not resize the title or split the three row actions.
export const CopiedSong: Story = { name: 'Песня · после копирования', args: { admin: true }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const row = canvas.getByRole('listitem');
  const song = within(row);
  const title = song.getByRole('link');
  const titleWidth = title.getBoundingClientRect().width;
  const copy = song.getByRole('button', { name: /^Скопировать ссылку:/ });
  const clipboard = spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
  try {
    await userEvent.click(copy);
    await expect(await song.findByRole('status')).toHaveTextContent('скопирована');
    await waitFor(() => expect(copy).toBeEnabled());
    await expect(Math.abs(title.getBoundingClientRect().width - titleWidth)).toBeLessThan(1);
    const buttons = song.getAllByRole('button').map(button => button.getBoundingClientRect());
    await expect(Math.max(...buttons.map(button => button.top)) - Math.min(...buttons.map(button => button.top))).toBeLessThan(1);
    const receipt = song.getByRole('status').getBoundingClientRect();
    await expect(receipt.top).toBeGreaterThanOrEqual(Math.max(...buttons.map(button => button.bottom)));
    await expect(receipt.right).toBeLessThanOrEqual(row.getBoundingClientRect().right + 1);
    await expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
  } finally { clipboard.mockRestore(); }
} };
export const Settings: Story = { name: 'Репертуар · настройки', play: async ({ canvasElement }) => { await settings(canvasElement); } };
export const Song: Story = { name: 'Песня · длинное название', play: async ({ canvasElement }) => { await settings(canvasElement, 'Тихий вечер — переложение для смешанного хора и фортепиано'); } };
export const FirstUse: Story = { name: 'Первое создание', args: { scenario: 'first' }, play: async ({ canvasElement }) => { await settings(canvasElement); } };
export const Disabled: Story = { name: 'Отключена · нужен новый адрес', args: { scenario: 'disabled' }, play: async ({ canvasElement }) => { await settings(canvasElement); } };
export const Legacy: Story = { name: 'Ранее созданные ссылки · явный переход', args: { scenario: 'legacy' }, play: async ({ canvasElement }) => { await settings(canvasElement); } };
export const Empty: Story = { name: 'Пустой репертуар', args: { empty: true }, play: async ({ canvasElement }) => { await settings(canvasElement); } };
export const Unpublished: Story = { name: 'Песня ещё не опубликована', args: { unavailable: true }, play: Song.play! };
export const Error: Story = { name: 'Ошибка запроса', args: { scenario: 'error' }, play: async ({ canvasElement }) => { await settings(canvasElement); } };
// UI boundary: rejected clipboard after an async request must still expose the
// same selectable URL, and a fresh user gesture can copy it without replacement.
export const ClipboardFallback: Story = { name: 'Проверка · копирование после отказа', play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const clipboard = spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError')).mockResolvedValue(undefined);
  try {
    await userEvent.click(canvas.getByRole('button', { name: 'Копировать ссылку для учеников' }));
    const modal = within(await canvas.findByRole('dialog'));
    const field = await modal.findByRole('textbox', { name: 'Адрес для учеников' });
    await expect(field).toHaveFocus();
    const url = (field as HTMLInputElement).value;
    await userEvent.click(modal.getByRole('button', { name: 'Копировать' }));
    await expect(await modal.findByRole('status')).toHaveTextContent('Ссылка на репертуар скопирована');
    await expect(clipboard).toHaveBeenLastCalledWith(url);
    await userEvent.click(modal.getByRole('button', { name: 'Закрыть настройки ссылки' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Копировать ссылку для учеников' }));
    await waitFor(() => expect(clipboard).toHaveBeenCalledTimes(3));
    await expect(await canvas.findByRole('status')).toHaveTextContent('Ссылка на репертуар скопирована');
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Копировать ссылку для учеников' })).toBeEnabled());
    await expect(clipboard).toHaveBeenLastCalledWith(url);
  } finally { clipboard.mockRestore(); }
} };

function ScopeRaceFixture() {
  const [owner, setOwner] = useState('elena@example.invalid');
  const [release, setRelease] = useState<(() => void) | null>(null);
  const [service] = useState<SharingService>(() => {
    const fixture = sharingFixture();
    return { ...fixture, get: scope => new Promise<PermanentState>(resolve => { setRelease(() => () => { void fixture.get(scope).then(resolve); setRelease(null); }); }) };
  });
  return <><label>Чей репертуар передать<Select value={owner} onChange={event => setOwner(event.target.value)}><option>elena@example.invalid</option><option>mikhail@example.invalid</option></Select></label><ShareActions kind="list" service={service} target={{ scope: { kind: 'list', ownerId: owner }, ownerLabel: owner }} /><Button disabled={!release} onClick={() => release?.()}>Завершить ответ сервера</Button></>;
}
function LostResponseFixture() {
  const [service] = useState<SharingService>(() => {
    const fixture = sharingFixture();
    return { ...fixture, async rotate(id, version) { await fixture.rotate(id, version); throw new TypeError('Нет соединения с сервером.'); } };
  });
  return <ShareActions kind="list" service={service} target={{ scope: { kind: 'list', ownerId: 'elena@example.invalid' }, ownerLabel: 'elena@example.invalid' }} />;
}
// An uncertain mutation must be reconciled, never silently repeated with a new
// revision. The next visible URL corresponds to exactly one rotation.
export const LostResponse: Story = { name: 'Проверка · потерянный ответ замены', render: () => <LostResponseFixture />, play: async ({ canvasElement }) => {
  const modal = await settings(canvasElement);
  const before = (await modal.findByRole('textbox', { name: 'Адрес для учеников' }) as HTMLInputElement).value;
  await userEvent.click(modal.getByRole('button', { name: 'Заменить адрес' }));
  await userEvent.click(modal.getByRole('button', { name: 'Заменить адрес' }));
  await expect(await modal.findByRole('alert')).toHaveTextContent('Состояние перечитано');
  const after = (modal.getByRole('textbox', { name: 'Адрес для учеников' }) as HTMLInputElement).value;
  await expect(after).not.toBe(before);
  await expect(after).toBe(`${before}-v2`);
  await expect(modal.queryByRole('button', { name: 'Отмена' })).not.toBeInTheDocument();
} };
// A late result for the previous owner must never write their URL to Clipboard.
export const ChangedOwner: Story = { name: 'Проверка · смена владельца во время запроса', render: () => <ScopeRaceFixture />, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const clipboard = spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
  try {
    await userEvent.click(canvas.getByRole('button', { name: 'Копировать ссылку для учеников' }));
    await userEvent.selectOptions(canvas.getByRole('combobox'), 'mikhail@example.invalid');
    await userEvent.click(canvas.getByRole('button', { name: 'Завершить ответ сервера' }));
    await expect(canvas.getByRole('button', { name: 'Завершить ответ сервера' })).toBeDisabled();
    await expect(clipboard).not.toHaveBeenCalled();
    await expect(canvas.queryByRole('status')).not.toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: 'Действия со ссылкой: mikhail@example.invalid' })).toBeEnabled();
  } finally { clipboard.mockRestore(); }
} };
