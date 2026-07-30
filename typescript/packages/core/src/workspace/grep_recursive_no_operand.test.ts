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

// GNU grep -r/-R with no path operand searches the working directory,
// ignores stdin, and prints bare relative names (a.txt:hit, not
// ./a.txt:hit); pinned on debian:stable-slim.

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

describe('grep -r with no path operand', () => {
  it('searches the cwd and prints bare relative names', async () => {
    const ws = await makeWs()
    const io = await ws.execute('grep -r hello')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('a.txt:hello\nsub/b.txt:hello\n')
  })

  it('ignores stdin when the cwd operand is synthesized', async () => {
    const ws = await makeWs()
    const io = await ws.execute('grep -r hello', { stdin: ENC.encode('hello from stdin\n') })
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('a.txt:hello\nsub/b.txt:hello\n')
  })

  it('exits 1 silently when nothing matches', async () => {
    const ws = await makeWs()
    const io = await ws.execute('grep -r zzz')
    expect(io.exitCode).toBe(1)
    expect(stdoutStr(io)).toBe('')
  })

  it('keeps the usage error without -r', async () => {
    const ws = await makeWs()
    const io = await ws.execute('grep hello')
    expect(io.exitCode).toBe(2)
  })
})
