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

import { mountKey, stripSlash } from '@struktoai/mirage-core'
import { describe, expect, it } from 'vitest'
import { PathSpec } from '@struktoai/mirage-core'
import { makeFakeAccessor } from './_test_utils.ts'
import { resolveGlob } from './glob.ts'

describe('core/ssh/glob.resolveGlob', () => {
  it('expands a glob pattern into matching paths', async () => {
    const accessor = makeFakeAccessor({
      files: new Map([
        ['/a.json', { data: new Uint8Array() }],
        ['/b.json', { data: new Uint8Array() }],
        ['/c.txt', { data: new Uint8Array() }],
      ]),
      dirs: new Map([['/', {}]]),
    })
    const pattern = new PathSpec({
      resourcePath: stripSlash('/*.json'),
      virtual: '/*.json',
      directory: '/',
      pattern: '*.json',
      resolved: false,
    })
    const out = await resolveGlob(accessor, [pattern])
    const originals = out.map((p) => p.virtual).sort()
    expect(originals).toEqual(['/a.json', '/b.json'])
  })

  it('passes through already-resolved paths unchanged', async () => {
    const accessor = makeFakeAccessor({
      files: new Map([['/c.txt', { data: new Uint8Array() }]]),
      dirs: new Map([['/', {}]]),
    })
    const out = await resolveGlob(accessor, [PathSpec.fromStrPath('/c.txt')])
    expect(out.map((p) => p.virtual)).toEqual(['/c.txt'])
  })

  it('preserves the mount prefix in matched paths', async () => {
    const accessor = makeFakeAccessor({
      files: new Map([
        ['/a.json', { data: new Uint8Array() }],
        ['/b.txt', { data: new Uint8Array() }],
      ]),
      dirs: new Map([['/', {}]]),
    })
    const pattern = new PathSpec({
      virtual: '/mnt/ssh/*.json',
      directory: '/mnt/ssh/',
      pattern: '*.json',
      resolved: false,
      resourcePath: mountKey('/mnt/ssh/*.json', '/mnt/ssh'),
    })
    const out = await resolveGlob(accessor, [pattern])
    expect(out.map((p) => p.virtual)).toEqual(['/mnt/ssh/a.json'])
  })
})
