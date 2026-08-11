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
import { beforeAll, describe, expect, it } from 'vitest'
import { OpsRegistry } from '../ops/registry.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { createShellParser, type ShellParser } from '../shell/parse.ts'
import { MountMode } from '../types.ts'
import { Workspace } from './workspace.ts'

const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

let parser: ShellParser

beforeAll(async () => {
  parser = await createShellParser({ engineWasm, grammarWasm })
})

function buildWorkspace(): { ws: Workspace; ram: RAMResource } {
  const ram = new RAMResource()
  const registry = new OpsRegistry()
  registry.registerResource(ram)
  const ws = new Workspace(
    { '/ram': ram },
    { mode: MountMode.WRITE, ops: registry, shellParser: parser },
  )
  return { ws, ram }
}

const DEC = new TextDecoder()

describe('streaming commands on missing files', () => {
  it('cat /missing.txt returns exit=1 with stderr', async () => {
    const { ws } = buildWorkspace()
    const res = await ws.execute('cat /ram/missing.txt')
    expect(res.exitCode).toBe(1)
    expect(DEC.decode(res.stderr)).toMatch(/missing\.txt/)
    await ws.close()
  })

  it('cat /missing.txt does not abort subsequent commands', async () => {
    const { ws } = buildWorkspace()
    const res = await ws.execute('cat /ram/missing.txt; echo after=$?')
    expect(DEC.decode(res.stdout)).toBe('after=1\n')
    await ws.close()
  })

  it('cat works with 2>&1 stderr redirect', async () => {
    const { ws } = buildWorkspace()
    const res = await ws.execute('cat /ram/missing.txt 2>&1')
    expect(DEC.decode(res.stdout)).toMatch(/missing\.txt/)
    await ws.close()
  })

  it('cat || echo fallback works', async () => {
    const { ws } = buildWorkspace()
    const res = await ws.execute('cat /ram/missing.txt || echo fallback')
    expect(DEC.decode(res.stdout)).toBe('fallback\n')
    await ws.close()
  })

  it('head /missing.txt returns exit=1 with stderr', async () => {
    const { ws } = buildWorkspace()
    const res = await ws.execute('head /ram/missing.txt')
    expect(res.exitCode).toBe(1)
    expect(DEC.decode(res.stderr)).toMatch(/missing\.txt/)
    await ws.close()
  })

  it('head -n 1 /missing.txt returns exit=1', async () => {
    const { ws } = buildWorkspace()
    const res = await ws.execute('head -n 1 /ram/missing.txt; echo after=$?')
    expect(DEC.decode(res.stdout)).toBe('after=1\n')
    await ws.close()
  })

  // GNU grep exits 2 for an operand it could not search, unlike the
  // read commands around it, which exit 1.
  it('grep pat /missing.txt returns exit=2 with stderr', async () => {
    const { ws } = buildWorkspace()
    const res = await ws.execute('grep foo /ram/missing.txt')
    expect(res.exitCode).toBe(2)
    expect(DEC.decode(res.stderr)).toMatch(/missing\.txt/)
    await ws.close()
  })

  it('tail /missing.txt returns exit=1 with stderr', async () => {
    const { ws } = buildWorkspace()
    const res = await ws.execute('tail /ram/missing.txt')
    expect(res.exitCode).toBe(1)
    expect(DEC.decode(res.stderr)).toMatch(/missing\.txt/)
    await ws.close()
  })

  it('wc /missing.txt returns exit=1 with stderr', async () => {
    const { ws } = buildWorkspace()
    const res = await ws.execute('wc /ram/missing.txt')
    expect(res.exitCode).toBe(1)
    expect(DEC.decode(res.stderr)).toMatch(/missing\.txt/)
    await ws.close()
  })

  it('cat of an existing file still works', async () => {
    const { ws, ram } = buildWorkspace()
    ram.store.files.set('/x.txt', new TextEncoder().encode('hello\n'))
    const res = await ws.execute('cat /ram/x.txt')
    expect(res.exitCode).toBe(0)
    expect(DEC.decode(res.stdout)).toBe('hello\n')
    await ws.close()
  })

  it('head of an existing file still works', async () => {
    const { ws, ram } = buildWorkspace()
    ram.store.files.set('/x.txt', new TextEncoder().encode('a\nb\nc\n'))
    const res = await ws.execute('head -n 2 /ram/x.txt')
    expect(res.exitCode).toBe(0)
    expect(DEC.decode(res.stdout)).toBe('a\nb\n')
    await ws.close()
  })

  it('grep of an existing file still works', async () => {
    const { ws, ram } = buildWorkspace()
    ram.store.files.set('/x.txt', new TextEncoder().encode('foo\nbar\nfoo baz\n'))
    const res = await ws.execute('grep foo /ram/x.txt')
    expect(res.exitCode).toBe(0)
    expect(DEC.decode(res.stdout)).toMatch(/foo/)
    await ws.close()
  })
})
