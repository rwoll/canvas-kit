import type { ReactNode } from 'react'

export interface ChecklistItem {
  id: string
  label: string
  done: boolean
  /** Shown at the end of the row, such as a status or a count. */
  note?: ReactNode
}

export interface ChecklistProps {
  /** Accessible name of the list, such as "Blockers". */
  label: string
  items: readonly ChecklistItem[]
  /** Called when a row is checked or unchecked. Without it, the boxes are read-only. */
  onToggle?: (id: string, done: boolean) => void
  /** Shown instead of the list when there are no items. */
  empty?: ReactNode
}

/** A list of items to check off, shared by every canvas that tracks work. */
export function Checklist({ label, items, onToggle, empty = 'Nothing here yet.' }: ChecklistProps) {
  if (items.length === 0) return <p className="ui-empty">{empty}</p>
  return (
    <ul className="ui-checklist" aria-label={label}>
      {items.map((item) => (
        <li key={item.id} className={item.done ? 'done' : undefined}>
          <label>
            <input
              type="checkbox"
              checked={item.done}
              disabled={!onToggle}
              onChange={(event) => onToggle?.(item.id, event.target.checked)}
            />
            <span className="text">{item.label}</span>
            {item.note && <span className="note">{item.note}</span>}
          </label>
        </li>
      ))}
    </ul>
  )
}
