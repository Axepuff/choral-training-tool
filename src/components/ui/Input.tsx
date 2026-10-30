import type { ComponentPropsWithRef } from 'react';
import styles from './Field.module.css';

export type InputProps = Omit<ComponentPropsWithRef<'input'>, 'type'> & {
  type?: 'text' | 'email' | 'password' | 'search' | 'number';
  density?: 'normal' | 'large';
  decoration?: 'leadingIcon' | 'trailingAction';
};

/** Native text/numeric field; file, checkbox and range have separate contracts. */
export function Input({ className, density = 'normal', decoration, ...props }: InputProps) {
  return <input {...props} className={[styles.field, density === 'large' && styles.large, decoration && styles[decoration], className].filter(Boolean).join(' ')} />;
}
