// GitHub issue and pull request URLs, exactly: no sub-pages such as /files, and no fragments.
const REFERENCE = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})\/(?:pull|issues)\/(\d+)\/?(?:\?[^\s#]*)?$/

// Code blocks, code spans, and Markdown links are kept as written; <url> and bare URLs are candidates.
const TOKENS = /(```|~~~)[\s\S]*?(?:\1|$)|(`+)[\s\S]*?\2|!?\[[^\]\n]*\]\([^)\n]*\)|<(https?:\/\/[^\s>]+)>|https?:\/\/[^\s<>()[\]`]+/g
const TRAILING = /[.,;:!?'"*_~]+$/

/** `owner/repo#42` for a GitHub issue or pull request URL, or undefined for any other text. */
export function shortReference(url: string): string | undefined {
  const match = REFERENCE.exec(url)
  return match ? `${match[1]}/${match[2]}#${match[3]}` : undefined
}

/**
 * Turn GitHub issue and pull request URLs in Markdown into short `owner/repo#42`
 * links. Other hosts, sub-pages, fragments, code, and links with their own label
 * stay as written.
 */
export function linkReferences(markdown: string): string {
  return markdown.replace(TOKENS, (token, _fence, _ticks, bracketed: string | undefined) => {
    if (bracketed !== undefined) {
      const label = shortReference(bracketed)
      return label ? `[${label}](${bracketed})` : token
    }
    if (!/^https?:/.test(token)) return token
    const trailing = TRAILING.exec(token)?.[0] ?? ''
    const url = token.slice(0, token.length - trailing.length)
    const label = shortReference(url)
    return label ? `[${label}](${url})${trailing}` : token
  })
}
