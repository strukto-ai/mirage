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

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { CLISpec } from '../../../commands/cli/types.ts'
import { IOResult } from '../../../io/types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { createShellParser } from '../../../shell/parse/index.ts'
import { MountMode, PathSpec } from '../../../types.ts'
import { Workspace } from '../../workspace/workspace.ts'
import { dropMountCaches } from './run.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

function warmWorkspace(): [Workspace, RAMVFS, RAMVFS] {
  const ram = new RAMVFS()
  const other = new RAMVFS()
  // An account CLI's service caches reads, so a body already read is served
  // warm; forcing it on RAM reproduces that without a network backend.
  ;(ram as unknown as { cachesReads: boolean }).cachesReads = true
  ;(other as unknown as { cachesReads: boolean }).cachesReads = true
  const ws = new Workspace(
    { '/r': ram, '/o': other },
    {
      mode: MountMode.WRITE,
      shellParserFactory: async () => createShellParser({ engineWasm, grammarWasm }),
    },
  )
  return [ws, ram, other]
}

async function seed(ram: RAMVFS, other: RAMVFS): Promise<void> {
  await ram.writeFile(PathSpec.fromStrPath('/a.txt'), ENC.encode('v1\n'))
  await other.writeFile(PathSpec.fromStrPath('/b.txt'), ENC.encode('v1\n'))
}

async function warm(ws: Workspace): Promise<void> {
  await ws.shell('cat /r/a.txt')
  await ws.shell('ls /r')
  await ws.shell('cat /o/b.txt')
}

async function mutateOutOfBand(ram: RAMVFS, other: RAMVFS): Promise<void> {
  await ram.writeFile(PathSpec.fromStrPath('/a.txt'), ENC.encode('v2\n'))
  await ram.writeFile(PathSpec.fromStrPath('/new.txt'), ENC.encode('fresh\n'))
  await other.writeFile(PathSpec.fromStrPath('/b.txt'), ENC.encode('v2\n'))
}

async function readBack(ws: Workspace): Promise<[string, string, string]> {
  return [
    DEC.decode((await ws.shell('cat /r/a.txt')).stdout),
    DEC.decode((await ws.shell('ls /r')).stdout),
    DEC.decode((await ws.shell('cat /o/b.txt')).stdout),
  ]
}

describe('dropMountCaches', () => {
  it('drops bodies as well as listings, on every mount', async () => {
    // A stale listing hides a create; a stale body hides an edit. The cached
    // body is the one that answers without reaching the service, so clearing
    // the index alone leaves `cat` serving pre-write content. Which mounts the
    // CLI's service backs is not the CLI's business, so every mount drops.
    const [ws, ram, other] = warmWorkspace()
    try {
      await seed(ram, other)
      await warm(ws)
      expect(DEC.decode((await ws.shell('cat /r/a.txt')).stdout)).toContain('v1')
      await mutateOutOfBand(ram, other)
      await dropMountCaches(ws.registry)
      const [body, listing, otherBody] = await readBack(ws)
      expect(body).toContain('v2')
      expect(listing).toContain('new.txt')
      expect(otherBody).toContain('v2')
    } finally {
      await ws.close()
    }
  })
})

function outOfBandWriter(ram: RAMVFS): () => Promise<[Uint8Array, IOResult]> {
  // A leaf that reaches its service past every mount, as an account CLI does:
  // the file lands in the store, and no vfs path was touched.
  return async () => {
    await ram.writeFile(PathSpec.fromStrPath('/made.txt'), ENC.encode('made\n'))
    return [ENC.encode('ok\n'), new IOResult()]
  }
}

describe('a CLI write and the mount caches', () => {
  it('an account CLI write refreshes every mount', async () => {
    // Nothing on the CLI names the mount and nothing on the mount names the
    // CLI: a write verb on a CLI with a config model is the whole signal.
    const [ws, ram, other] = warmWorkspace()
    try {
      ws.registerCli(
        'acme',
        new CLISpec({
          name: 'acme',
          configModel: (input) => input,
          subcommands: [new CLISpec({ name: 'close', write: true, fn: outOfBandWriter(ram) })],
        }),
        { token: 't' },
      )
      await seed(ram, other)
      await warm(ws)
      await mutateOutOfBand(ram, other)
      expect((await ws.shell('acme close')).exitCode).toBe(0)
      const [body, listing, otherBody] = await readBack(ws)
      expect(body).toContain('v2')
      expect(listing).toContain('made.txt')
      expect(otherBody).toContain('v2')
    } finally {
      await ws.close()
    }
  })

  it('an account CLI read keeps every mount warm', async () => {
    const [ws, ram, other] = warmWorkspace()
    try {
      ws.registerCli(
        'acme',
        new CLISpec({
          name: 'acme',
          configModel: (input) => input,
          subcommands: [new CLISpec({ name: 'peek', fn: outOfBandWriter(ram) })],
        }),
        { token: 't' },
      )
      await seed(ram, other)
      await warm(ws)
      await mutateOutOfBand(ram, other)
      expect((await ws.shell('acme peek')).exitCode).toBe(0)
      // RAM lists its store live, so the cached body is what shows the
      // mount stayed warm.
      const [body, , otherBody] = await readBack(ws)
      expect(body).toContain('v1')
      expect(otherBody).toContain('v1')
    } finally {
      await ws.close()
    }
  })

  it('a mount-tier CLI write drops nothing', async () => {
    // A CLI without a config model (git) writes through the dispatcher, which
    // invalidates the paths it touched as it went; a blanket drop would only
    // cost every other mount a reload.
    const [ws, ram, other] = warmWorkspace()
    try {
      ws.registerCli(
        'tool',
        new CLISpec({
          name: 'tool',
          subcommands: [new CLISpec({ name: 'poke', write: true, fn: outOfBandWriter(ram) })],
        }),
      )
      await seed(ram, other)
      await warm(ws)
      await mutateOutOfBand(ram, other)
      expect((await ws.shell('tool poke')).exitCode).toBe(0)
      const [body, , otherBody] = await readBack(ws)
      expect(body).toContain('v1')
      expect(otherBody).toContain('v1')
    } finally {
      await ws.close()
    }
  })
})
