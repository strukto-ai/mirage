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
import { RAMVFS } from '../vfs/ram/ram.ts'
import { PathSpec } from '../types.ts'
import { RAMSessionStore } from './session/ram.ts'
import { toStateDict } from './snapshot/state.ts'
import { Workspace } from './workspace/workspace.ts'

class ProbeRAMVFS extends RAMVFS {
  closeCalls = 0

  override async close(): Promise<void> {
    this.closeCalls += 1
    await super.close()
  }
}

class ProbeSessionStore extends RAMSessionStore {
  closeCalls = 0

  override close(): Promise<void> {
    this.closeCalls += 1
    return Promise.resolve()
  }
}

describe('workspace close ownership', () => {
  it('leaves mounts shared with another workspace open', async () => {
    const vfs = new ProbeRAMVFS()
    const ws = new Workspace({ '/data': vfs })
    await vfs.writeFile(PathSpec.fromStrPath('/a.txt'), new TextEncoder().encode('seed'))

    const state = await toStateDict(ws)
    const replica = await Workspace.fromState(state, {}, { '/data': vfs })
    await replica.close()
    expect(vfs.closeCalls).toBe(0)
    const body = await vfs.readFile(PathSpec.fromStrPath('/a.txt'))
    expect(new TextDecoder().decode(body)).toBe('seed')

    await ws.close()
    expect(vfs.closeCalls).toBe(1)
  })

  it.each([false, true])('unmount leaves borrowed mounts open (used=%s)', async (used) => {
    const vfs = new ProbeRAMVFS()
    const ws = new Workspace({ '/data': vfs })
    const state = await toStateDict(ws)
    const replica = await Workspace.fromState(state, {}, { '/data': vfs })
    try {
      if (used) await replica.resolve('/data')
      await replica.unmount('/data')
      expect(vfs.closeCalls).toBe(0)
      await replica.close()
      expect(vfs.closeCalls).toBe(0)
      await ws.close()
      expect(vfs.closeCalls).toBe(1)
    } finally {
      await replica.close()
      await ws.close()
    }
  })

  it('does not close a caller-passed session store', async () => {
    const sessionStore = new ProbeSessionStore()
    const ws = new Workspace({ '/data': new RAMVFS() }, { sessionStore })
    await ws.close()
    expect(sessionStore.closeCalls).toBe(0)
  })
})
