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
import { MountMode } from '../types.ts'
import { getTestParser, stdoutStr } from './fixtures/workspace_fixture.ts'
import { Workspace } from './workspace.ts'

// ripgrep with no path operand and no attached stdin searches the cwd
// recursively and prints bare relative names; a piped stdin, even
// empty, wins (rg's readable-stdin rule). Pinned on ripgrep 14.

const ENC = new TextEncoder()

async function makeWs(): Promise<Workspace> {
  const parser = await getTestParser()
  const r = new RAMResource()
  r.store.dirs.add('/')
  r.store.dirs.add('/sub')
  r.store.files.set('/a.txt', ENC.encode('hello\n'))
  r.store.files.set('/sub/b.txt', ENC.encode('hello\n'))
  const registry = new OpsRegistry()
  registry.registerResource(r)
  return new Workspace({ '/': r }, { mode: MountMode.WRITE, ops: registry, shellParser: parser })
}

describe('rg with no path operand', () => {
  it('searches the cwd and prints bare relative names', async () => {
    const ws = await makeWs()
    const io = await ws.execute('rg hello')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('a.txt:hello\nsub/b.txt:hello\n')
  })

  it('an attached stdin wins, even empty', async () => {
    const ws = await makeWs()
    let io = await ws.execute('rg hello', { stdin: ENC.encode('hello pipe\n') })
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('hello pipe\n')

    io = await ws.execute('rg hello', { stdin: new Uint8Array() })
    expect(io.exitCode).toBe(1)
    expect(stdoutStr(io)).toBe('')
  })

  it('exits 1 silently when nothing matches', async () => {
    const ws = await makeWs()
    const io = await ws.execute('rg zzz')
    expect(io.exitCode).toBe(1)
    expect(stdoutStr(io)).toBe('')
  })
})
