import { useEffect, useMemo, useRef } from 'react';
import { WheelPicker, WheelPickerWrapper } from '@ncdai/react-wheel-picker';
import '@ncdai/react-wheel-picker/style.css';
import styles from './RehearsalPlayer.module.css';

/** Adapt the library's focusable wheel to a labelled numeric control. */
export function BarWheel({ label, value, count, onChange }: {
  label: string; value: number; count: number; onChange: (value: number) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const safeValue = Number.isInteger(value) ? Math.min(count, Math.max(1, value)) : 1;
  // Keep long scores light without taking any bar out of reach. Overlapping
  // windows move only at block boundaries, preserving normal wheel inertia.
  const first = count <= 1000 ? 1 : Math.max(1, Math.min(count - 299, Math.floor((safeValue - 1) / 100) * 100 - 99));
  const optionCount = Math.min(count, count <= 1000 ? 1000 : 300);
  const options = useMemo(() => Array.from({ length: optionCount }, (_, i) => ({ value: first + i, label: String(first + i) })), [first, optionCount]);
  useEffect(() => {
    // v1.2.3 does not forward ARIA props to its keyboard-focusable element.
    const wheel = root.current?.querySelector('[data-rwp]');
    if (!wheel) return;
    for (const [name, content] of Object.entries({ role: 'spinbutton', 'aria-label': label,
      'aria-valuemin': '1', 'aria-valuemax': String(count), 'aria-valuenow': String(safeValue) })) {
      wheel.setAttribute(name, content);
    }
    for (const child of wheel.children) child.setAttribute('aria-hidden', 'true');
  }, [label, count, safeValue]);
  return <div ref={root} className={styles.barWheel} onKeyDownCapture={event => {
    // Commit keyboard steps immediately, without racing the library's inertia
    // against a controlled range update from the other wheel or the player.
    const next = { ArrowUp: safeValue + 1, ArrowDown: safeValue - 1, Home: 1, End: count }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    onChange(Math.min(count, Math.max(1, next)));
  }}>
    <span className={styles.wheelLabel} title={label}>{label === 'По такт включительно' ? 'По такт вкл.' : label}</span>
    <WheelPickerWrapper>
      <WheelPicker options={options} value={safeValue} onValueChange={onChange}
        infinite={false} visibleCount={8} optionItemHeight={44} scrollSensitivity={20}
        classNames={{ optionItem: styles.wheelOption!, highlightWrapper: styles.wheelHighlight!, highlightItem: styles.wheelSelected! }} />
    </WheelPickerWrapper>
  </div>;
}
