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
import { PolicyDenied } from '../policy/errors.ts'
import { Policies } from '../policy/policies.ts'
import type { Policy } from '../policy/base.ts'
import type { VfsContext } from '../policy/types.ts'
import { Limit, MountMode, PathSpec } from '../types.ts'
import { OpBoundary } from './boundary.ts'

const sealed: Policy = {
  preVfs: (ctx: VfsContext) =>
    ctx.path.virtual.startsWith('/d/sec') ? { kind: 'deny', reason: 'sealed' } : null,
}

const capped: Policy = { postVfs: () => new Limit({ maxBytes: 3 }) }

function path(virtual: string): PathSpec {
  return PathSpec.fromStrPath(virtual)
}

describe('OpBoundary', () => {
  it('admit raises a coded deny as EACCES', async () => {
    const boundary = new OpBoundary(new Policies([sealed]), '/d/', MountMode.WRITE)
    await boundary.admit('read', path('/d/pub'), false)
    const refused = boundary.admit('read', path('/d/sec/k'), false)
    await expect(refused).rejects.toBeInstanceOf(PolicyDenied)
    await expect(refused).rejects.toMatchObject({ code: 'EACCES', virtualPath: '/d/sec/k' })
  })

  it('admit holds the mount mode', async () => {
    const boundary = new OpBoundary(new Policies(), '/ro/', MountMode.READ)
    await boundary.admit('read', path('/ro/f'), false)
    await expect(boundary.admit('write', path('/ro/f'), true)).rejects.toThrow(/read-only/)
  })

  it('complete applies the postVfs limit', async () => {
    const data = new TextEncoder().encode('abcdef')
    const capped3 = new OpBoundary(new Policies([capped]), '/d/')
    expect(await capped3.complete('read', path('/d/f'), false, data)).toEqual(
      new TextEncoder().encode('abc'),
    )
    const bare = new OpBoundary(new Policies(), '/d/')
    expect(await bare.complete('read', path('/d/f'), false, data)).toEqual(data)
  })
})
