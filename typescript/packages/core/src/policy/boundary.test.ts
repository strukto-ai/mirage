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
import { PolicyDenied, PolicyError } from './errors.ts'
import { Policies } from './policies.ts'
import type { Policy } from './base.ts'
import type { VfsContext } from './types.ts'
import { Limit, MountMode, PathSpec } from '../types.ts'
import { Boundary } from './boundary.ts'
import { CALLS } from '../workspace/dispatcher/constants.ts'
import type { VfsCall } from '../vfs/types.ts'

function callOf(name: string): VfsCall {
  const call = CALLS.get(name)
  if (call === undefined) throw new Error(`no call ${name}`)
  return call
}

const sealed: Policy = {
  preVfs: (ctx: VfsContext) =>
    ctx.path.virtual.startsWith('/d/sec') ? { kind: 'deny', reason: 'sealed' } : null,
}

const capped: Policy = { postVfs: () => new Limit({ maxBytes: 3 }) }

function path(virtual: string): PathSpec {
  return PathSpec.fromStrPath(virtual)
}

describe('Boundary', () => {
  it('admit raises a coded deny as EACCES', async () => {
    const boundary = new Boundary(new Policies([sealed]), '/d/', MountMode.WRITE)
    await boundary.admit(callOf('read'), path('/d/pub'), false)
    const refused = boundary.admit(callOf('read'), path('/d/sec/k'), false)
    await expect(refused).rejects.toBeInstanceOf(PolicyDenied)
    await expect(refused).rejects.toMatchObject({ code: 'EACCES', virtualPath: '/d/sec/k' })
  })

  it('admit holds the mount mode', async () => {
    const boundary = new Boundary(new Policies(), '/ro/', MountMode.READ)
    await boundary.admit(callOf('read'), path('/ro/f'), false)
    await expect(boundary.admit(callOf('write'), path('/ro/f'), true)).rejects.toThrow(/read-only/)
  })

  it('complete hands the result back whole', async () => {
    const data = new TextEncoder().encode('abcdef')
    const capped3 = new Boundary(new Policies([capped]), '/d/')
    await expect(capped3.complete(callOf('read'), path('/d/f'), false, data)).rejects.toThrow(
      PolicyError,
    )
    const bare = new Boundary(new Policies(), '/d/')
    expect(await bare.complete(callOf('read'), path('/d/f'), false, data)).toEqual(data)
  })
})
