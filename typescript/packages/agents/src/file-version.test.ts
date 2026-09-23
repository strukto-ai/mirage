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

import { beforeEach, describe, expect, it } from 'vitest'
import { MountMode, RAMVFS, Workspace } from '@struktoai/mirage-node'
import { FileVersionTracker, StaleMirageFileError } from './file-version.ts'

let ws: Workspace

beforeEach(() => {
  ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE })
})

// A read seam that answers with something other than the stored bytes.
// Any mount carrying a filetype read op behaves this way: writeFile
// stores one thing and readFile hands back the rendering. The tracker
// reaches the workspace only through these calls, so this is the whole
// of the condition.
function renderingWs(inner: Workspace): Workspace {
  const prefix = new TextEncoder().encode('rendered:')
  return {
    vfs: {
      readFile: async (path: string): Promise<Uint8Array> => {
        const stored = await inner.vfs.readFile(path, { raw: true })
        return new Uint8Array([...prefix, ...stored])
      },
      writeFile: (path: string, content: string | Uint8Array): Promise<void> =>
        inner.vfs.writeFile(path, content),
      exists: (path: string): Promise<boolean> => inner.vfs.exists(path),
    },
    namespace: inner.namespace,
  } as unknown as Workspace
}

describe('FileVersionTracker', () => {
  it('refuses a write to a file that changed underneath', async () => {
    const tracker = new FileVersionTracker(ws)
    await ws.vfs.writeFile('/a.txt', 'one')
    await tracker.read('/a.txt')
    await ws.vfs.writeFile('/a.txt', 'moved underneath')
    await expect(tracker.write('/a.txt', 'two')).rejects.toThrow(StaleMirageFileError)
  })

  it('allows a write that follows its own write', async () => {
    const tracker = new FileVersionTracker(ws)
    await ws.vfs.writeFile('/a.txt', 'one')
    await tracker.read('/a.txt')
    await tracker.write('/a.txt', 'two')
    await tracker.write('/a.txt', 'three')
    expect(await ws.vfs.readFileText('/a.txt')).toBe('three')
  })

  it('stamps what a later read returns, not the bytes handed in', async () => {
    // Stamping the input would disagree with every later check, which
    // reads it back through the render, and the agent's own next write
    // would be refused as somebody else's change.
    const tracker = new FileVersionTracker(renderingWs(ws))
    await tracker.write('/a.txt', 'one')
    await tracker.write('/a.txt', 'two')
    expect(await ws.vfs.readFileText('/a.txt')).toBe('two')
  })

  it('reads for edit after its own write on a rendering mount', async () => {
    const tracker = new FileVersionTracker(renderingWs(ws))
    await tracker.write('/a.txt', 'one')
    expect(new TextDecoder().decode(await tracker.readForEdit('/a.txt'))).toBe('rendered:one')
  })

  it('gives an alias and its target one stamp', async () => {
    // readFile follows the symlink table, so these two spellings are one
    // file. Keyed by spelling, the write below would find no stamp for
    // '/a.txt' and clobber a change the agent never saw.
    const tracker = new FileVersionTracker(ws)
    await ws.vfs.writeFile('/a.txt', 'one')
    expect((await ws.shell('ln -s /a.txt /alias.txt')).exitCode).toBe(0)
    await tracker.read('/alias.txt')
    await ws.vfs.writeFile('/a.txt', 'moved underneath')
    await expect(tracker.write('/a.txt', 'two')).rejects.toThrow(StaleMirageFileError)
    expect(await ws.vfs.readFileText('/a.txt')).toBe('moved underneath')
  })

  it('sees the target read when the edit arrives through the alias', async () => {
    const tracker = new FileVersionTracker(ws)
    await ws.vfs.writeFile('/a.txt', 'one')
    expect((await ws.shell('ln -s /a.txt /alias.txt')).exitCode).toBe(0)
    await tracker.read('/a.txt')
    await ws.vfs.writeFile('/a.txt', 'moved underneath')
    await expect(tracker.readForEdit('/alias.txt')).rejects.toThrow(StaleMirageFileError)
  })

  it('serves every call unchecked when disabled', async () => {
    const tracker = new FileVersionTracker(ws, false)
    await ws.vfs.writeFile('/a.txt', 'one')
    await tracker.read('/a.txt')
    await ws.vfs.writeFile('/a.txt', 'moved underneath')
    await tracker.write('/a.txt', 'two')
    expect(await ws.vfs.readFileText('/a.txt')).toBe('two')
  })
})
