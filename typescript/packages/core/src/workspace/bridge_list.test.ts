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
import { OpsRegistry } from '../ops/registry.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import type { BridgeDispatchFn } from '../runtime/types.ts'
import type { VFSEntry } from '../runtime/vfs.ts'
import { MountMode } from '../types.ts'
import { Workspace } from './workspace.ts'

function bridgeOn(ws: Workspace): BridgeDispatchFn {
  return (ws as unknown as { buildWorkspaceBridge(): BridgeDispatchFn }).buildWorkspaceBridge()
}

function mkWorld(): { ws: Workspace; ops: OpsRegistry; resource: RAMResource } {
  const resource = new RAMResource()
  const ops = new OpsRegistry()
  for (const op of resource.ops()) ops.register(op)
  const ws = new Workspace({ '/data': resource }, { mode: MountMode.WRITE, ops })
  return { ws, ops, resource }
}

// The bridge readdir is the sandboxed runtimes' directory read: what it
// swallows, a guest can never see, and what it fails, pyodide's
// syncMounts treats as the whole tree.
describe('workspace bridge readdir', () => {
  it('a dangling link degrades to a zero row instead of failing the listing', async () => {
    const { ws } = mkWorld()
    await ws.fs.writeFile('/data/a.txt', 'hi')
    await ws.namespace.symlink('/data/lnk', '/data/gone', 1)
    const entries = (await bridgeOn(ws)('readdir', '/data')) as VFSEntry[]
    const row = entries.find((e) => e.path.endsWith('/lnk'))
    expect(row).toMatchObject({ size: 0, isDir: false, isLink: true })
  })

  it('a non-missing stat failure propagates instead of degrading the row', async () => {
    // Only a genuine missing path (the dangling-link race above) may
    // read back as a zero row; authorization failures, timeouts, and
    // backend bugs must surface, or an incomplete listing replaces a
    // healthy snapshot.
    const { ws, ops, resource } = mkWorld()
    await ws.fs.writeFile('/data/a.txt', 'hi')
    ops.register({
      name: 'stat',
      resource: resource.kind,
      filetype: null,
      fn: () => {
        throw new Error('401 Unauthorized')
      },
      write: false,
    })
    await expect(bridgeOn(ws)('readdir', '/data')).rejects.toThrow('401 Unauthorized')
  })
})
