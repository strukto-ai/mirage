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
import { RAMVFS } from '../vfs/ram/ram.ts'
import { MontyRuntime } from '../runtime/python/monty/index.ts'
import { PrefixResolver } from '../runtime/resolver.ts'
import type { BridgeDispatchFn } from '../runtime/types.ts'
import { RuntimeVFS } from '../runtime/vfs.ts'
import { MountMode } from '../types.ts'
import { getTestParser } from './fixtures/workspace_fixture.ts'
import { Workspace } from './workspace/workspace.ts'
import { FILE_MODE } from '../utils/stat_view.ts'

function mkWorld(): { ws: Workspace; ops: OpsRegistry; vfs: RAMVFS } {
  const vfs = new RAMVFS()
  const ops = new OpsRegistry()
  for (const op of vfs.ops()) ops.register(op)
  const ws = new Workspace({ '/data': vfs }, { mode: MountMode.WRITE, ops })
  return { ws, ops, vfs }
}

// The door a sandboxed runtime holds, over this workspace's own bridge
// and the same two sources the workspace hands its runtimes: the mount
// prefixes and the node table's link names.
function doorOn(ws: Workspace): RuntimeVFS {
  const bridge = (
    ws as unknown as { buildWorkspaceBridge(): BridgeDispatchFn }
  ).buildWorkspaceBridge()
  return new RuntimeVFS(
    bridge,
    new PrefixResolver(
      () => ['/data/'],
      (directory) => ws.namespace.linkNamesUnder(directory),
    ),
  )
}

// The runtime door's readdir is the sandboxed runtimes' directory read:
// what it swallows, a guest can never see, and what it fails, pyodide's
// syncMounts treats as the whole tree.
describe('runtime door readdir', () => {
  it('a dangling link degrades to a zero row instead of failing the listing', async () => {
    const { ws } = mkWorld()
    await ws.vfs.writeFile('/data/a.txt', 'hi')
    await ws.namespace.symlink('/data/lnk', '/data/gone', 1)
    const entries = await doorOn(ws).readdir('/data')
    const row = entries.find((e) => e.path.endsWith('/lnk'))
    expect(row).toMatchObject({ size: 0, isDir: false, isLink: true })
  })

  it('a non-missing stat failure propagates instead of degrading the row', async () => {
    // Only a genuine missing path (the dangling-link race above) may
    // read back as a zero row; authorization failures, timeouts, and
    // backend bugs must surface, or an incomplete listing replaces a
    // healthy snapshot.
    const { ws, ops, vfs } = mkWorld()
    await ws.vfs.writeFile('/data/a.txt', 'hi')
    ops.register({
      name: 'stat',
      vfs: vfs.kind,
      filetype: null,
      fn: () => {
        throw new Error('401 Unauthorized')
      },
      write: false,
    })
    await expect(doorOn(ws).readdir('/data')).rejects.toThrow('401 Unauthorized')
  })

  // A live link stats as its target, so the row's own kind says nothing
  // about it; only the node table does.
  it('marks a live link whose stat followed through to a file', async () => {
    const { ws } = mkWorld()
    await ws.vfs.writeFile('/data/a.txt', 'hello')
    await ws.namespace.symlink('/data/lnk', '/data/a.txt', 1)
    const entries = await doorOn(ws).readdir('/data')
    expect(entries.find((e) => e.path.endsWith('/lnk'))).toMatchObject({ size: 5, isLink: true })
    const plain = entries.find((e) => e.path.endsWith('/a.txt'))
    expect(plain).toMatchObject({ path: '/data/a.txt', size: 5, isDir: false, mode: FILE_MODE })
    expect(plain?.isLink).toBeUndefined()
  })

  // Dispatch follows the alias and answers with the target's entries,
  // so the marks have to come from the target too. Reading them off the
  // typed path left a link inside an aliased directory unmarked, and a
  // directory link there then read as a directory a guest walk descends.
  it('marks the links inside a directory reached through a link', async () => {
    const { ws } = mkWorld()
    await ws.dispatch('mkdir', '/data/real')
    await ws.vfs.writeFile('/data/real/t.txt', 'hi')
    await ws.namespace.symlink('/data/real/lk', '/data/real/t.txt', 1)
    await ws.namespace.symlink('/data/alias', '/data/real', 1)
    const entries = await doorOn(ws).readdir('/data/alias')
    expect(entries.find((e) => e.path.endsWith('/lk'))).toMatchObject({ isLink: true })
  })
})

// The wiring itself: the workspace hands its runtimes a resolver that
// reaches the node table, so a guest predicate answers about a link the
// shell made without a readlink of its own.
describe('a guest sees the marks the workspace wired', () => {
  it('answers is_symlink for a link the shell made', async () => {
    const vfs = new RAMVFS()
    const ops = new OpsRegistry()
    for (const op of vfs.ops()) ops.register(op)
    const ws = new Workspace(
      { '/data': vfs },
      {
        mode: MountMode.EXEC,
        ops,
        shellParser: await getTestParser(),
        runtimes: [new MontyRuntime()],
      },
    )
    await ws.shell('echo hi > /data/a.txt')
    await ws.shell('ln -s /data/a.txt /data/lnk')
    const io = await ws.shell(
      'python3 -c "from pathlib import Path;' +
        " print(Path('/data/lnk').is_symlink(), Path('/data/a.txt').is_symlink())\"",
    )
    expect(new TextDecoder().decode(io.stdout).trim()).toBe('True False')
    await ws.close()
  }, 30_000)
})
