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

import { mountKey } from '../../utils/key_prefix.ts'
import { describe, expect, it } from 'vitest'

import { PathSpec } from '../../types.ts'
import { virtualKeyFor } from './path.ts'

function ps(virtual: string, prefix = ''): PathSpec {
  return new PathSpec({ virtual, directory: virtual, resourcePath: mountKey(virtual, prefix) })
}

describe('virtualKeyFor', () => {
  it('maps the mount root', () => {
    expect(virtualKeyFor(ps('/knowledge', '/knowledge'))).toBe('/knowledge')
    expect(virtualKeyFor(ps('/knowledge/', '/knowledge'))).toBe('/knowledge')
  })

  it('keeps prefixed paths', () => {
    expect(virtualKeyFor(ps('/knowledge/guides/auth.md', '/knowledge'))).toBe(
      '/knowledge/guides/auth.md',
    )
  })

  it('prefixes mount-relative paths', () => {
    expect(virtualKeyFor(ps('/knowledge/guides/auth.md', '/knowledge'))).toBe(
      '/knowledge/guides/auth.md',
    )
    expect(virtualKeyFor(ps('/knowledge', '/knowledge'))).toBe('/knowledge')
  })

  it('normalizes when no prefix is set', () => {
    expect(virtualKeyFor(ps('/guides/'))).toBe('/guides')
    expect(virtualKeyFor(ps('/'))).toBe('/')
  })

  it('uses the directory for glob patterns', () => {
    const spec = new PathSpec({
      virtual: '/knowledge/guides/*.md',
      directory: '/knowledge/guides/',
      pattern: '*.md',
      resolved: false,
      resourcePath: mountKey('/knowledge/guides/*.md', '/knowledge'),
    })
    expect(virtualKeyFor(spec)).toBe('/knowledge/guides')
  })
})
