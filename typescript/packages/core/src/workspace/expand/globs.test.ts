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
import type { Resource } from '../../resource/base.ts'
import { MountMode, PathSpec } from '../../types.ts'
import { MountRegistry } from '../mount/registry.ts'
import { resolveGlobs, type ResourceWithGlob } from './globs.ts'

class PlainResource implements Resource {
  readonly kind = 'plain'
  open(): Promise<void> {
    return Promise.resolve()
  }
  close(): Promise<void> {
    return Promise.resolve()
  }
}

class GlobResource implements ResourceWithGlob {
  readonly kind = 'glob'
  constructor(private readonly results: PathSpec[]) {}
  open(): Promise<void> {
    return Promise.resolve()
  }
  close(): Promise<void> {
    return Promise.resolve()
  }
  glob(): Promise<PathSpec[]> {
    return Promise.resolve(this.results)
  }
}

describe('resolveGlobs', () => {
  it('passes through plain strings', async () => {
    const reg = new MountRegistry({ '/ram': new PlainResource() }, MountMode.WRITE)
    const out = await resolveGlobs(['-l', 'text'], reg)
    expect(out).toEqual(['-l', 'text'])
  })

  it('passes through non-glob PathSpecs', async () => {
    const reg = new MountRegistry({ '/ram': new PlainResource() }, MountMode.WRITE)
    const p = PathSpec.fromStrPath('/ram/x.txt')
    const out = await resolveGlobs([p], reg)
    expect(out).toEqual([p])
  })

  it('passes through glob PathSpecs when the resource lacks glob', async () => {
    const reg = new MountRegistry({ '/ram': new PlainResource() }, MountMode.WRITE)
    const p = new PathSpec({
      resourcePath: 'ram/*.txt',
      virtual: '/ram/*.txt',
      directory: '/ram/',
      pattern: '*.txt',
      resolved: false,
    })
    const out = await resolveGlobs([p], reg)
    expect(out).toHaveLength(1)
    expect(out[0]).toBe(p)
  })

  it('expands glob PathSpecs through resource.glob', async () => {
    const res = new GlobResource([
      PathSpec.fromStrPath('/ram/a.txt'),
      PathSpec.fromStrPath('/ram/b.txt'),
    ])
    const reg = new MountRegistry({ '/ram': res }, MountMode.WRITE)
    const p = new PathSpec({
      resourcePath: 'ram/*.txt',
      virtual: '/ram/*.txt',
      directory: '/ram/',
      pattern: '*.txt',
      resolved: false,
    })
    const out = await resolveGlobs([p], reg)
    expect(out.map((x) => (x instanceof PathSpec ? x.virtual : x))).toEqual([
      '/ram/a.txt',
      '/ram/b.txt',
    ])
  })

  it('keeps the literal word on zero matches (bash nullglob off)', async () => {
    const res = new GlobResource([])
    const reg = new MountRegistry({ '/ram': res }, MountMode.WRITE)
    const p = new PathSpec({
      resourcePath: 'ram/*.nope',
      virtual: '/ram/*.nope',
      directory: '/ram/',
      pattern: '*.nope',
      resolved: false,
    })
    const out = await resolveGlobs([p], reg)
    expect(out).toHaveLength(1)
    const kept = out[0]
    expect(kept).toBeInstanceOf(PathSpec)
    expect((kept as PathSpec).virtual).toBe('/ram/*.nope')
    expect((kept as PathSpec).pattern).toBe('*.nope')
  })
})
