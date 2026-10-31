import type { ComponentPropsWithRef, CSSProperties } from 'react';
import styles from './RangeSlider.module.css';

export type RangeSliderProps = Omit<ComponentPropsWithRef<'input'>, 'type' | 'value' | 'defaultValue'> & {
  value: number;
  variant?: 'volume' | 'seek';
  orientation?: 'horizontal' | 'vertical';
  tone?: 'accent' | 'soprano' | 'alto' | 'tenor' | 'bass' | 'backing';
  /** Приглушает цвет фейдера, не блокируя изменение громкости. */
  muted?: boolean;
};

/** Controlled native range. Values, units and interaction handlers stay with the caller. */
export function RangeSlider({ className, style, value, min = 0, max = 100, variant = 'volume', orientation = 'horizontal', tone = 'accent', muted = false, ...props }: RangeSliderProps) {
  const fill = Math.min(100, Math.max(0, (value - Number(min)) / (Number(max) - Number(min) || 1) * 100));
  return <input {...props} type="range" min={min} max={max} value={value} aria-orientation={orientation}
    data-orientation={orientation} data-tone={tone} data-muted={muted}
    style={{ ...style, '--range-fill': `${fill}%` } as CSSProperties}
    className={[styles.slider, styles[variant], className].filter(Boolean).join(' ')} />;
}
