import { describe, expect, it } from 'vitest'

import { splitBacktickRegion } from './backticks.ts'

describe('splitBacktickRegion', () => {
  it('reads a single pair as one command', () => {
    expect(splitBacktickRegion('`cat s`')).toEqual([
      { text: 'cat s', command: true, start: 1, end: 6 },
    ])
  })

  it('splits touching pairs with the text between them', () => {
    const raw = '`cat /data/secret` `echo ok`'
    const segments = splitBacktickRegion(raw)
    expect(segments.map((s) => [s.text, s.command])).toEqual([
      ['cat /data/secret', true],
      [' ', false],
      ['echo ok', true],
    ])
    expect(segments.map((s) => raw.slice(s.start, s.end))).toEqual([
      'cat /data/secret',
      ' ',
      'echo ok',
    ])
  })

  it('resolves escapes in a command while the span stays raw', () => {
    const raw = '`echo \\$x \\`y\\``'
    const [segment] = splitBacktickRegion(raw)
    expect(segment?.text).toBe('echo $x `y`')
    expect(raw.slice(segment?.start, segment?.end)).toBe('echo \\$x \\`y\\`')
  })

  it('does not let an escaped backslash escape the closing backtick', () => {
    const raw = '`echo a\\\\`b'
    expect(splitBacktickRegion(raw)).toEqual([
      { text: 'echo a\\', command: true, start: 1, end: 9 },
      { text: 'b', command: false, start: 10, end: 11 },
    ])
  })
})
