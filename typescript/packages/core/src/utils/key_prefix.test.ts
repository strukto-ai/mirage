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
import { PathSpec } from '../types.ts'
import { childSpec, normalize, rawPathOf, sameMountSpec } from './key_prefix.ts'

// The one key-prefix rule, mirrored by python/tests/utils/test_key_prefix.py.
// A root-spelled prefix is no prefix: '/' used to normalize to '/', and every
// s3 or gridfs key then began with a slash.
const NORMALIZE: readonly [string | undefined, string][] = [
  ['/team/x/', 'team/x/'],
  ['team/x', 'team/x/'],
  ['//team/x', 'team/x/'],
  ['', ''],
  [undefined, ''],
  ['/', ''],
  ['//', ''],
]

describe('normalize', () => {
  it.each(NORMALIZE)('%j -> %j', (raw, expected) => {
    expect(normalize(raw)).toBe(expected)
  })
})

describe('childSpec', () => {
  it('appends to the VFS key', () => {
    const parent = new PathSpec({ virtual: '/m/d', directory: '/m', vfsPath: 'd' })
    const child = childSpec(parent, 'x')
    expect(child.virtual).toBe('/m/d/x')
    expect(child.vfsPath).toBe('d/x')
    const root = new PathSpec({ virtual: '/m', directory: '/', vfsPath: '' })
    expect(childSpec(root, 'x').vfsPath).toBe('x')
  })
})

describe('sameMountSpec', () => {
  it('keys a virtual path on the template mount', () => {
    const template = new PathSpec({ virtual: '/m/d', directory: '/m', vfsPath: 'd' })
    const spec = sameMountSpec('/m/e/f', template)
    expect(spec.virtual).toBe('/m/e/f')
    expect(spec.directory).toBe('/m/e/f')
    expect(spec.vfsPath).toBe('e/f')
    expect(spec.resolved).toBe(false)
  })
})

describe('rawPathOf', () => {
  it.each([
    ['/nc/docs/a.txt', 'docs/a.txt', '/docs/a.txt'],
    ['/nc', '', '/'],
    ['/nc/', '', '/'],
    ['/nc/docs/', 'docs', '/docs/'],
    ['/a.txt', 'a.txt', '/a.txt'],
  ])('%s (key %s) keeps the typed spelling below the mount', (virtual, vfsPath, raw) => {
    expect(rawPathOf(new PathSpec({ virtual, directory: virtual, vfsPath }))).toBe(raw)
  })
})
