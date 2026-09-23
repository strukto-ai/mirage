import { describe, expect, it } from 'vitest'
import { classCharacters, translateClasses } from './posix.ts'

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
    const compiled = new RegExp(translateClasses(`^[[:${name}:]]$`))
    const expanded = classCharacters(name)
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
  })
  it.each(['[[:bogus:]]', '[[:constructor:]]', '[[:digit:]'])('rejects %s', (pattern) => {
    expect(() => translateClasses(pattern)).toThrow(SyntaxError)
  })
  it('preserves escapes and mixed brackets', () => {
    expect(new RegExp(translateClasses(String.raw`\[\[:digit:\]\]`)).test('[[:digit:]]')).toBe(true)
    const compiled = new RegExp(translateClasses('^[][:digit:]_]+$'))
    expect(compiled.test(']_123')).toBe(true)
    expect(compiled.test('abc')).toBe(false)
  })
})
