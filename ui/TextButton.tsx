import type { ButtonHTMLAttributes } from 'react'

/** A secondary action that reads as a link. */
export function TextButton({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={className ? `ui-text-button ${className}` : 'ui-text-button'} {...props} />
}
