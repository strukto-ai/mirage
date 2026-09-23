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

import { IOResult } from '../../io/types.ts'
import type { DispatchFn } from '../../runtime/types.ts'
import { PathSpec } from '../../types.ts'
import { SessionState } from '../session/session.ts'
import { createFile } from './create.ts'

const SCOPE = new PathSpec({ virtual: '/data/f', directory: '/data/', vfsPath: '' })

class FakeDispatch {
  readonly calls: [string, Record<string, unknown>][] = []

  constructor(private readonly exists: boolean) {}

  readonly fn: DispatchFn = async (op, _path, _args, kwargs) => {
    this.calls.push([op, kwargs ?? {}])
    await Promise.resolve()
    if (op === 'stat' && !this.exists) {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }
    return [null, new IOResult()]
  }

  ops(): string[] {
    return this.calls.map(([op]) => op)
  }
}

function sessionWithUmask(umask: number): SessionState {
  const session = new SessionState({ sessionId: 's' })
  session.umask = umask
  return session
}

// Both `echo x > f` and `exec > f` route here, so the mode a fresh file
// gets is decided once: 0666 masked by the session's umask, and left
// alone under the default mask because a fresh file already reads 644.
describe('createFile', () => {
  it('never probes or sets a mode under the default umask', async () => {
    const d = new FakeDispatch(false)
    await createFile(d.fn, new SessionState({ sessionId: 's' }), SCOPE, new Uint8Array(0))
    expect(d.ops()).toEqual(['write'])
  })

  it('gives a created file the masked mode', async () => {
    const d = new FakeDispatch(false)
    await createFile(d.fn, sessionWithUmask(0o077), SCOPE, new Uint8Array(0))
    expect(d.ops()).toEqual(['stat', 'write', 'setattr'])
    expect(d.calls[2]?.[1].mode).toBe(0o600)
  })

  it('leaves an existing file its mode', async () => {
    const d = new FakeDispatch(true)
    await createFile(d.fn, sessionWithUmask(0o077), SCOPE, new Uint8Array(0))
    expect(d.ops()).toEqual(['stat', 'write'])
  })
})
