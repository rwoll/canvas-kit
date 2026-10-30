import type { ReactNode } from 'react'

export interface HeaderProps {
  title: string
  /** A short line under the title, such as the repository and a count. */
  meta?: ReactNode
}

/** The title block every canvas starts with. */
export function Header({ title, meta }: HeaderProps) {
  return (
    <header className="ui-header">
      <h1>{title}</h1>
      {meta && <p>{meta}</p>}
    </header>
  )
}
