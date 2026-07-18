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
import { RAMResource } from '../resource/ram/ram.ts'
import { PathSpec } from '../types.ts'
import { RAMSessionStore } from './session/ram.ts'
import { toStateDict } from './snapshot/state.ts'
import { Workspace } from './workspace.ts'

class ProbeRAMResource extends RAMResource {
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
  it('leaves resources shared with another workspace open', async () => {
    const resource = new ProbeRAMResource()
    const ws = new Workspace({ '/data': resource })
    await resource.writeFile(PathSpec.fromStrPath('/a.txt'), new TextEncoder().encode('seed'))

    const state = await toStateDict(ws)
    const replica = await Workspace.fromState(state, {}, { '/data': resource })
    await replica.close()
    expect(resource.closeCalls).toBe(0)
    const body = await resource.readFile(PathSpec.fromStrPath('/a.txt'))
    expect(new TextDecoder().decode(body)).toBe('seed')

    await ws.close()
    expect(resource.closeCalls).toBe(1)
  })

  it('does not close a caller-passed session store', async () => {
    const sessionStore = new ProbeSessionStore()
    const ws = new Workspace({ '/data': new RAMResource() }, { sessionStore })
    await ws.close()
    expect(sessionStore.closeCalls).toBe(0)
  })
})
