import type { ReactNode } from 'react'

export interface MarkdownProps {
  /** Markdown, such as notes the agent writes. Raw HTML is shown as text, never run. */
  children: string
  /** Accessible name. With it, the notes are a labeled region. */
  label?: string
}

/**
 * Markdown the agent writes, in the marketplace's theme: headings, paragraphs,
 * lists, task lists, quotes, code, rules, bold, italic, strikethrough, inline code,
 * and http(s) or mailto links. It builds React elements directly, so nothing in
 * the text can inject HTML.
 */
export function Markdown({ children, label }: MarkdownProps) {
  return (
    <div className="ui-markdown" role={label ? 'region' : undefined} aria-label={label}>
      {blocks(children)}
    </div>
  )
}

const FENCE = /^\s*(```|~~~)/
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/
const QUOTE = /^\s*>\s?(.*)$/
const ITEM = /^\s*([-*+]|\d{1,9}[.)])\s+(.*)$/
const TASK = /^\[([ xX])\]\s+(.*)$/

function blocks(source: string): ReactNode[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const out: ReactNode[] = []
  let i = 0
  const startsBlock = (line: string) => FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || ITEM.test(line)

  while (i < lines.length) {
    const line = lines[i]!
    const key = out.length
    if (!line.trim()) {
      i += 1
    } else if (FENCE.test(line)) {
      const fence = FENCE.exec(line)![1]!
      const code: string[] = []
      for (i += 1; i < lines.length && !lines[i]!.trim().startsWith(fence); i += 1) code.push(lines[i]!)
      i += 1
      out.push(
        <pre key={key}>
          <code>{code.join('\n')}</code>
        </pre>,
      )
    } else if (HEADING.test(line)) {
      const [, hashes, text] = HEADING.exec(line)!
      // The canvas title is the page's h1, so `#` becomes h2.
      const Tag = `h${Math.min(hashes!.length + 1, 6)}` as 'h2'
      out.push(<Tag key={key}>{inline(text!)}</Tag>)
      i += 1
    } else if (RULE.test(line)) {
      out.push(<hr key={key} />)
      i += 1
    } else if (QUOTE.test(line)) {
      const quoted: string[] = []
      for (; i < lines.length && QUOTE.test(lines[i]!); i += 1) quoted.push(QUOTE.exec(lines[i]!)![1]!)
      out.push(<blockquote key={key}>{blocks(quoted.join('\n'))}</blockquote>)
    } else if (ITEM.test(line)) {
      const ordered = /^\d/.test(ITEM.exec(line)![1]!)
      const items: string[] = []
      for (; i < lines.length; i += 1) {
        const next = lines[i]!
        const item = ITEM.exec(next)
        if (item && /^\d/.test(item[1]!) === ordered) items.push(item[2]!)
        // An indented line continues the item above it.
        else if (items.length > 0 && /^\s{2,}\S/.test(next) && !item) items[items.length - 1] += ` ${next.trim()}`
        else break
      }
      const List = ordered ? 'ol' : 'ul'
      out.push(
        <List key={key}>
          {items.map((text, index) => {
            const task = TASK.exec(text)
            if (!task) return <li key={index}>{inline(text)}</li>
            return (
              <li key={index} className="task">
                <input type="checkbox" checked={task[1] !== ' '} readOnly disabled aria-label={task[2]} />
                <span>{inline(task[2]!)}</span>
              </li>
            )
          })}
        </List>,
      )
    } else {
      const text: string[] = []
      for (; i < lines.length && lines[i]!.trim() && !startsBlock(lines[i]!); i += 1) text.push(lines[i]!.trim())
      out.push(<p key={key}>{inline(text.join(' '))}</p>)
    }
  }
  return out
}

const INLINE =
  /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([\s\S]+?)\*\*|(?<![\w])__([\s\S]+?)__(?![\w])|~~([\s\S]+?)~~|\*(?!\s)([\s\S]+?)\*|(?<![\w])_(?!\s)([\s\S]+?)_(?![\w])|\[([^\]]+)\]\(\s*([^)\s]+)\s*\)/g

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  for (const match of text.matchAll(INLINE)) {
    const index = match.index
    if (index > last) out.push(text.slice(last, index))
    const [whole, ticks, code, bold, bold2, strike, italic, italic2, label, url] = match
    if (ticks) out.push(<code key={index}>{code!.trim()}</code>)
    else if (bold ?? bold2) out.push(<strong key={index}>{inline((bold ?? bold2)!)}</strong>)
    else if (strike) out.push(<del key={index}>{inline(strike)}</del>)
    else if (italic ?? italic2) out.push(<em key={index}>{inline((italic ?? italic2)!)}</em>)
    else {
      const href = safeHref(url!)
      out.push(
        href ? (
          <a key={index} href={href} target="_blank" rel="noreferrer">
            {inline(label!)}
          </a>
        ) : (
          whole
        ),
      )
    }
    last = index + whole.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/** Only web and mail links; anything else, such as `javascript:`, stays as text. */
function safeHref(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    return ['http:', 'https:', 'mailto:'].includes(parsed.protocol) ? parsed.href : undefined
  } catch {
    return undefined
  }
}
