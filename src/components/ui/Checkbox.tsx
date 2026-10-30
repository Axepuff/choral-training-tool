import type { ComponentPropsWithRef, ReactNode } from 'react';
import styles from './Checkbox.module.css';

export type CheckboxProps = Omit<ComponentPropsWithRef<'input'>, 'type' | 'children'> & { children: ReactNode };

/** The label keeps the native checkbox's whole target at least 44px tall. */
export function Checkbox({ className, children, ...props }: CheckboxProps) {
  return <label className={[styles.label, className].filter(Boolean).join(' ')}>
    <input {...props} type="checkbox" className={styles.input} />{children}
  </label>;
}
