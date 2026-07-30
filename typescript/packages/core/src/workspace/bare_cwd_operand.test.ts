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

// GNU find/tree/du/ls typed bare behave exactly as if `.` had been
// typed: ./-prefixed walk lines, `.:` ls -R headers, du rows ending in
// `.` (pinned on debian:stable-slim).

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

describe('bare invocations default to the cwd', () => {
  it('find walks the cwd dot-spelled', async () => {
    const ws = await makeWs()
    const io = await ws.execute('find')
    expect(io.exitCode).toBe(0)
    const out = stdoutStr(io)
    expect(out.startsWith('.\n./a.txt\n./sub\n./sub/b.txt\n')).toBe(true)
    expect(
      out
        .trim()
        .split('\n')
        .every((line) => line.startsWith('.')),
    ).toBe(true)
  })

  it('find with only an expression implies the leading dot', async () => {
    const ws = await makeWs()
    const io = await ws.execute("find -name '*.txt'")
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('./a.txt\n./sub/b.txt\n')
  })

  it('tree renders the cwd', async () => {
    const ws = await makeWs()
    const io = await ws.execute('tree')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io).startsWith('.\n')).toBe(true)
    expect(stdoutStr(io)).toContain('a.txt')
  })

  it('du measures the cwd dot-spelled', async () => {
    const ws = await makeWs()
    const io = await ws.execute('du')
    expect(io.exitCode).toBe(0)
    const out = stdoutStr(io)
    expect(out).toContain('\t./sub\n')
    expect(out).toContain('\t.\n')
  })

  it('ls -R uses dot headers', async () => {
    const ws = await makeWs()
    const io = await ws.execute('ls -R')
    expect(io.exitCode).toBe(0)
    const out = stdoutStr(io)
    expect(out.startsWith('.:\n')).toBe(true)
    expect(out).toContain('\n./sub:\n')
  })

  it('plain ls still lists the cwd', async () => {
    const ws = await makeWs()
    const io = await ws.execute('ls')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io).startsWith('a.txt\nsub')).toBe(true)
  })
})
