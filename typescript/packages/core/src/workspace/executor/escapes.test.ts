// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { describe, expect, it } from 'vitest'
import { interpretEchoEscapes } from './builtins/text.ts'

// Direct port of tests/workspace/executor/test_escapes.py, which covers
// Python's _interpret_escapes in mirage/workspace/executor/builtins/text.py.
// This file used to import tr's reader instead, which is how tr ended up
// with echo's grammar: every echo-only rule below (\xHH, \c, \z passing
// through) was asserted against the wrong command. tr's own rules are
// pinned in commands/builtin/utils/escapes.test.ts.
describe('interpretEchoEscapes (port of tests/workspace/executor/test_escapes.py)', () => {
  it('newline', () => {
    expect(interpretEchoEscapes('a\\nb')).toBe('a\nb')
  })

  it('tab', () => {
    expect(interpretEchoEscapes('a\\tb')).toBe('a\tb')
  })

  it('carriage return', () => {
    expect(interpretEchoEscapes('\\r')).toBe('\r')
  })

  it('bell', () => {
    expect(interpretEchoEscapes('\\a')).toBe('\x07')
  })

  it('backspace', () => {
    expect(interpretEchoEscapes('\\b')).toBe('\b')
  })

  it('form feed', () => {
    expect(interpretEchoEscapes('\\f')).toBe('\f')
  })

  it('vertical tab', () => {
    expect(interpretEchoEscapes('\\v')).toBe('\v')
  })

  it('backslash', () => {
    expect(interpretEchoEscapes('a\\\\b')).toBe('a\\b')
  })

  it('escaped backslash does not re-escape the next character', () => {
    expect(interpretEchoEscapes('\\\\n')).toBe('\\n')
  })

  it('hex escape', () => {
    expect(interpretEchoEscapes('\\x41')).toBe('A')
  })

  it('short hex escape', () => {
    expect(interpretEchoEscapes('\\x9')).toBe('\t')
  })

  it('bare \\x is literal', () => {
    expect(interpretEchoEscapes('\\x')).toBe('\\x')
  })

  it('octal escape', () => {
    expect(interpretEchoEscapes('\\0101')).toBe('A')
  })

  it('bare \\0 is NUL', () => {
    expect(interpretEchoEscapes('\\0')).toBe('\0')
  })

  it('\\c stops output', () => {
    expect(interpretEchoEscapes('hello\\cworld')).toBe('hello')
  })

  it('unknown escape passes through with its backslash', () => {
    expect(interpretEchoEscapes('\\z')).toBe('\\z')
  })

  it('plain text', () => {
    expect(interpretEchoEscapes('hello world')).toBe('hello world')
  })

  it('empty', () => {
    expect(interpretEchoEscapes('')).toBe('')
  })

  it('trailing backslash', () => {
    expect(interpretEchoEscapes('end\\')).toBe('end\\')
  })

  it('mixed', () => {
    expect(interpretEchoEscapes('a\\tb\\nc\\\\d')).toBe('a\tb\nc\\d')
  })
})
