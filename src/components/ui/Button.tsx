import type { ComponentPropsWithRef } from 'react';
import styles from './Button.module.css';

export interface ButtonAppearance {
  variant?: 'neutral' | 'primary' | 'text' | 'danger' | 'dangerText' | 'solo' | 'mute' | 'play' | 'tab' | 'row' | 'title' | 'switch' | undefined;
  size?: 'normal' | 'small' | 'form' | 'icon' | undefined;
  /** Layout only; appearance belongs to this module. */
  className?: string | undefined;
}

export function buttonClassName({ variant = 'neutral', size = 'normal', className }: ButtonAppearance) {
  return [styles.button, styles[variant], styles[size], className].filter(Boolean).join(' ');
}

export type ButtonProps = ComponentPropsWithRef<'button'> & ButtonAppearance;

/** Native button. Busy does not disable it; form owners explicitly choose submit. */
export function Button({ variant, size, className, type = 'button', ...props }: ButtonProps) {
  return <button {...props} type={type} className={buttonClassName({ variant, size, className })} />;
}
