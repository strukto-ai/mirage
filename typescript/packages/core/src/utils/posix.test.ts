import { describe, expect, it } from 'vitest'
import { classCharacters, compilePosixRegex, translateBracket } from './posix.ts'

function bracket(pattern: string): string {
  const out: string[] = []
  const end = translateBracket(pattern, 0, out)
  expect(end).toBe(pattern.length)
  return out.join('')
}

describe('POSIX character classes', () => {
  it.each([
    ['alnum', 'aZ09', '_! '],
    ['alpha', 'aZ', '09_'],
    ['blank', ' \t', '\nA'],
    ['cntrl', '\x00\x1f\x7f', ' A'],
    ['digit', '09', 'aF_'],
    ['graph', '!AZ09~', ' \t'],
    ['lower', 'az', 'AZ0'],
    ['print', ' AZ09~', '\t\n'],
    ['punct', '![]-_', 'aZ0 '],
    ['space', ' \t\n\r\f\v', 'a0'],
    ['upper', 'AZ', 'az0'],
    ['xdigit', '09aAfF', 'gG_'],
  ])('%s membership', (name, yes, no) => {
    const compiled = new RegExp(`^${bracket(`[[:${name}:]]`)}$`)
    const expanded = classCharacters(name) ?? ''
    for (const char of yes) {
      expect(compiled.test(char)).toBe(true)
      expect(expanded.includes(char)).toBe(true)
    }
    for (const char of no) {
      expect(compiled.test(char)).toBe(false)
      expect(expanded.includes(char)).toBe(false)
    }
  })
  it('orders classes for translation', () => {
    expect(classCharacters('space')).toBe('\t\n\v\f\r ')
    expect(classCharacters('lower')).toBe('abcdefghijklmnopqrstuvwxyz')
    expect(classCharacters('bogus')).toBeNull()
  })
  it.each(['[[:bogus:]]', '[[:constructor:]]', '[[:digit:]'])('rejects %s', (pattern) => {
    expect(() => bracket(pattern)).toThrow(SyntaxError)
  })
  it('reads a leading ] and a class together', () => {
    const compiled = new RegExp(`^${bracket('[][:digit:]_]')}+$`)
    expect(compiled.test(']_123')).toBe(true)
    expect(compiled.test('abc')).toBe(false)
  })
})

describe('C-locale case folding', () => {
  it.each([
    ['élan', 'ÉLAN', false],
    ['Élan', 'ÉLAN', true],
    ['σ', 'Σ', false],
    ['k', 'K', false],
    ['i', 'İ', false],
    ['s', 'ſ', false],
    ['[A-Z]+', 'MiXeD', true],
    ['[^A-Z]', 'a', false],
    ['[^a]', 'A', false],
    ['[Z-a]+', 'ZA[', true],
    ['[Z-a]', 'B', false],
    ['[É]', 'é', false],
    ['[^É]', 'é', true],
    ['\\D[A-Z]', '!a', true],
    ['\\x41\\u0042', 'ab', true],
    ['([A-Z]+)-\\1', 'Ab-aB', true],
    ['(É)-\\1', 'É-é', false],
    ['(É)-\\1', 'É-É', true],
  ])('matches %s against %s', (source, text, expected) => {
    expect(compilePosixRegex(`^(?:${source})$`, 'i').test(text)).toBe(expected)
  })
  it('preserves captures, offsets and global state', () => {
    const regex = compilePosixRegex('(a)(b)?', 'ig')
    const first = regex.exec('ÉAb a')
    expect([...(first ?? [])]).toEqual(['Ab', 'A', 'b'])
    expect(first?.index).toBe(1)
    expect(first?.input).toBe('ÉAb a')
    expect(first?.indices).toBeUndefined()
    expect(regex.lastIndex).toBe(3)
    expect([...(regex.exec('ÉAb a') ?? [])]).toEqual(['a', 'a', undefined])
    expect(regex.exec('ÉAb a')).toBeNull()
    expect(regex.lastIndex).toBe(0)
  })
  it('preserves named captures, lookarounds and explicit indices', () => {
    const regex = compilePosixRegex('(?<=É)(?<Letter>A)(?=b)', 'di')
    const match = regex.exec('ÉAb')
    expect(match?.groups).toEqual({ Letter: 'A' })
    expect(match?.indices?.groups).toEqual({ Letter: [1, 2] })
  })
  it('preserves replacement spelling and matchAll cloning', () => {
    const regex = compilePosixRegex('(a)(b)', 'ig')
    expect('Ab aB'.replace(regex, '$2$1')).toBe('bA Ba')
    expect([...'Ab aB'.matchAll(regex)].map((m) => m[0])).toEqual(['Ab', 'aB'])
    expect('Aéa'.replace(compilePosixRegex('a*', 'ig'), 'X')).toBe('XXéXX')
  })
  it('keeps case-sensitive compilation and rejects invalid ranges', () => {
    expect(compilePosixRegex('A').test('a')).toBe(false)
    expect(() => compilePosixRegex('[z-a]', 'i')).toThrow(SyntaxError)
  })
})

it.each(['', 'i'])('keeps C-locale whitespace with flags %s', (flags) => {
  for (const source of [String.raw`\s`, String.raw`[\s]`, String.raw`[^\S]`]) {
    expect(compilePosixRegex(source, flags).test(' ')).toBe(true)
    expect(compilePosixRegex(source, flags).test('\u00a0')).toBe(false)
  }
  expect(compilePosixRegex(String.raw`\S`, flags).test('\u00a0')).toBe(true)
  expect(compilePosixRegex(String.raw`\\s`, flags).test(String.raw`\s`)).toBe(true)
})
