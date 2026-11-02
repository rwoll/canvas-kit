import { describe, expect, it } from 'vitest'
import { linkReferences, shortReference } from './references.ts'

describe('GitHub references', () => {
  it('shortens issue and pull request URLs', () => {
    expect(shortReference('https://github.com/octo/widgets/pull/42')).toBe('octo/widgets#42')
    expect(shortReference('https://github.com/octo/my.repo_x/issues/7/')).toBe('octo/my.repo_x#7')
    expect(shortReference('https://github.com/octo/widgets/pull/42?w=1')).toBe('octo/widgets#42')
    for (const url of [
      'https://github.com/octo/widgets/pull/42/files',
      'https://github.com/octo/widgets/issues/42#issuecomment-1',
      'https://github.example.com/octo/widgets/pull/42',
      'http://github.com/octo/widgets/pull/42',
      'https://github.com@evil.example/octo/widgets/pull/42',
      'https://github.com/octo/widgets/pull/x',
    ]) {
      expect(shortReference(url)).toBeUndefined()
    }
  })

  it('links bare and bracketed URLs, keeping punctuation after them', () => {
    expect(linkReferences('Fixed in https://github.com/octo/widgets/pull/42.')).toBe(
      'Fixed in [octo/widgets#42](https://github.com/octo/widgets/pull/42).',
    )
    expect(linkReferences('See <https://github.com/octo/widgets/issues/7>, then ship')).toBe(
      'See [octo/widgets#7](https://github.com/octo/widgets/issues/7), then ship',
    )
    expect(linkReferences('**https://github.com/octo/widgets/pull/1**')).toBe('**[octo/widgets#1](https://github.com/octo/widgets/pull/1)**')
  })

  it('leaves code, labeled links, other URLs, and short forms as written', () => {
    const unchanged = [
      '`https://github.com/octo/widgets/pull/42`',
      '```\nhttps://github.com/octo/widgets/pull/42\n```',
      '[the fix](https://github.com/octo/widgets/pull/42)',
      'https://github.com/octo/widgets/pull/42/files',
      'https://example.com/a',
      '#42 and octo/widgets#42',
    ]
    for (const text of unchanged) expect(linkReferences(text)).toBe(text)
  })
})
