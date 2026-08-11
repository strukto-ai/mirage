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

import { PathSpec } from '@struktoai/mirage-core'
import { describe, expect, it } from 'vitest'
import { setAttrs } from './set_attrs.ts'
import { stat } from './stat.ts'
import { makeFakeAccessor, type FakeSftp } from './_test_utils.ts'

const ENC = new TextEncoder()

function makeState(): FakeSftp {
  return {
    files: new Map([['/a.txt', { data: ENC.encode('abc'), attrs: { atime: 100, mtime: 200 } }]]),
    dirs: new Map([['/', {}]]),
  }
}

function spec(virtual: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual,
    resolved: false,
    resourcePath: virtual,
  })
}

describe('ssh setAttrs', () => {
  it('applies mtime natively with an empty residual', async () => {
    const state = makeState()
    const accessor = makeFakeAccessor(state)
    const residual = await setAttrs(accessor, spec('/a.txt'), {
      mtime: '2020-01-01T00:00:00Z',
    })
    expect(residual).toEqual({})
    const st = await stat(accessor, spec('/a.txt'))
    expect(st.modified).toBe('2020-01-01T00:00:00.000Z')
  })

  it('keeps the untouched atime when only mtime is set', async () => {
    const state = makeState()
    const accessor = makeFakeAccessor(state)
    await setAttrs(accessor, spec('/a.txt'), { mtime: '2020-01-01T00:00:00Z' })
    expect(state.files.get('/a.txt')?.attrs?.atime).toBe(100)
  })

  it('clamps mode to keep owner access', async () => {
    const state = makeState()
    const accessor = makeFakeAccessor(state)
    const residual = await setAttrs(accessor, spec('/a.txt'), { mode: 0o000 })
    expect(residual).toEqual({ mode: 0o000 })
    expect((state.files.get('/a.txt')?.attrs?.mode ?? 0) & 0o7777).toBe(0o600)
  })

  it('applies an unclamped mode cleanly', async () => {
    const state = makeState()
    const accessor = makeFakeAccessor(state)
    const residual = await setAttrs(accessor, spec('/a.txt'), { mode: 0o644 })
    expect(residual).toEqual({})
    expect((state.files.get('/a.txt')?.attrs?.mode ?? 0) & 0o7777).toBe(0o644)
  })

  it('always reports ownership as residual', async () => {
    const state = makeState()
    const accessor = makeFakeAccessor(state)
    const residual = await setAttrs(accessor, spec('/a.txt'), { uid: 7, gid: 8 })
    expect(residual).toEqual({ uid: 7, gid: 8 })
  })

  it('raises enoent for a missing file', async () => {
    const state = makeState()
    const accessor = makeFakeAccessor(state)
    await expect(setAttrs(accessor, spec('/nope.txt'), { mtime: '2020-01-01' })).rejects.toThrow()
  })
})
