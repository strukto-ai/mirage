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
import { specOf } from '../../commands/spec/builtins.ts'
import { specWordKinds } from './spec_hints.ts'

describe('specWordKinds', () => {
  it('basic grep pattern and path', () => {
    const [text, path] = specWordKinds(specOf('grep'), ['pattern', 'file.txt'])
    expect(text).toEqual(new Set(['pattern']))
    expect(path).toEqual(new Set(['file.txt']))
  })

  it('collects TEXT flag values', () => {
    const [text, path] = specWordKinds(specOf('find'), ['/data', '-name', '*.txt'])
    expect(text.has('*.txt')).toBe(true)
    expect(path).toEqual(new Set(['/data']))
  })

  it('--flag=value is not a path', () => {
    const [text, path] = specWordKinds(specOf('du'), ['--max-depth=1', '/data'])
    expect(text.has('--max-depth=1')).toBe(false)
    expect(path).toEqual(new Set(['/data']))
  })

  it('mixed cluster value is text, not path', () => {
    const [text, path] = specWordKinds(specOf('grep'), ['-ne', 'pat', '/a.txt'])
    expect(text).toEqual(new Set(['pat']))
    expect(path).toEqual(new Set(['/a.txt']))
  })

  it('repeated -e values are text', () => {
    const [text, path] = specWordKinds(specOf('grep'), ['-e', 'foo', '-e', 'bar', '/a.txt'])
    expect(text.has('foo')).toBe(true)
    expect(text.has('bar')).toBe(true)
    expect(path).toEqual(new Set(['/a.txt']))
  })

  it('numeric shorthand is not a path', () => {
    const [, path] = specWordKinds(specOf('head'), ['-5', 'file.txt'])
    expect(path).toEqual(new Set(['file.txt']))
  })

  it('find ignore tokens are not classified', () => {
    const [text, path] = specWordKinds(specOf('find'), ['/data', '(', '-name', '*.txt', ')'])
    expect(text.has('(')).toBe(false)
    expect(path.has('(')).toBe(false)
    expect(path.has(')')).toBe(false)
  })
})
