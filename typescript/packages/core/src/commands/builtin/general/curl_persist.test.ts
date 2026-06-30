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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OpsRegistry } from '../../../ops/registry.ts'
import { RAMResource } from '../../../resource/ram/ram.ts'
import { MountMode } from '../../../types.ts'
import { getTestParser } from '../../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../../workspace/workspace.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const PAYLOAD = ENC.encode('hello body')

function mockFetch(): void {
  globalThis.fetch = vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      arrayBuffer: () => Promise.resolve(PAYLOAD.buffer.slice(0)),
      text: () => Promise.resolve(DEC.decode(PAYLOAD)),
      headers: new Headers(),
    } as unknown as Response),
  ) as typeof fetch
}

class StubResource {
  readonly kind = 'stub'
  open(): Promise<void> {
    return Promise.resolve()
  }
  close(): Promise<void> {
    return Promise.resolve()
  }
}

async function makeWs(): Promise<Workspace> {
  const parser = await getTestParser()
  const ramRw = new RAMResource()
  const ramRo = new RAMResource()
  const stub = new StubResource()
  const registry = new OpsRegistry()
  registry.registerResource(ramRw)
  const ws = new Workspace(
    { '/ram': ramRw },
    { mode: MountMode.WRITE, ops: registry, shellParser: parser },
  )
  ws.addMount('/readonly', ramRo, MountMode.READ)
  ws.addMount('/nowrite', stub, MountMode.WRITE)
  return ws
}

describe('curl -o persists to mount', () => {
  const original = globalThis.fetch
  beforeEach(() => {
    mockFetch()
  })
  afterEach(() => {
    globalThis.fetch = original
  })

  it('writes the body to a writable mount', async () => {
    const ws = await makeWs()
    const io = await ws.execute('curl -s https://x.test/file -o /ram/foo.bin')
    expect(io.exitCode).toBe(0)
    const cat = await ws.execute('cat /ram/foo.bin')
    expect(cat.exitCode).toBe(0)
    expect(cat.stdoutText).toBe(DEC.decode(PAYLOAD))
    await ws.close()
  })

  it('fails with non-zero exit on a read-only mount', async () => {
    const ws = await makeWs()
    const io = await ws.execute('curl -s https://x.test/file -o /readonly/foo.bin')
    expect(io.exitCode).toBe(1)
    expect(io.stderrText).toMatch(/read-only/)
    expect(io.stderrText).toContain('/readonly/foo.bin')
    await ws.close()
  })

  it('fails when the target path has no parent directory', async () => {
    // No `/nope` mount and no `/nope` dir under the root anchor, so the write
    // routes to the empty root mount and fails because the parent is missing
    // (the catch-all root never silently swallows an unmounted path).
    const ws = await makeWs()
    const io = await ws.execute('curl -s https://x.test/file -o /nope/foo.bin')
    expect(io.exitCode).toBe(1)
    expect(io.stderrText).toMatch(/parent directory does not exist/)
    expect(io.stderrText).toContain('/nope/foo.bin')
    await ws.close()
  })

  it('fails when target resource has no write op', async () => {
    const ws = await makeWs()
    const io = await ws.execute('curl -s https://x.test/file -o /nowrite/foo.bin')
    expect(io.exitCode).toBe(1)
    expect(io.stderrText).toMatch(/no op|write/)
    expect(io.stderrText).toContain('/nowrite/foo.bin')
    await ws.close()
  })
})

describe('wget -O persists to mount', () => {
  const original = globalThis.fetch
  beforeEach(() => {
    mockFetch()
  })
  afterEach(() => {
    globalThis.fetch = original
  })

  it('writes the body to a writable mount', async () => {
    const ws = await makeWs()
    const io = await ws.execute('wget -q -O /ram/wget.bin https://x.test/file')
    expect(io.exitCode).toBe(0)
    const cat = await ws.execute('cat /ram/wget.bin')
    expect(cat.exitCode).toBe(0)
    expect(cat.stdoutText).toBe(DEC.decode(PAYLOAD))
    await ws.close()
  })

  it('fails with non-zero exit on a read-only mount', async () => {
    const ws = await makeWs()
    const io = await ws.execute('wget -q -O /readonly/wget.bin https://x.test/file')
    expect(io.exitCode).toBe(1)
    expect(io.stderrText).toMatch(/read-only/)
    await ws.close()
  })
})
