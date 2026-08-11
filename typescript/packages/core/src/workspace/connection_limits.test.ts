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
import { Limit, MountMode, OnExceed } from '../types.ts'
import { Workspace } from './workspace.ts'

const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))
const DEC = new TextDecoder()

let parser: ShellParser

beforeAll(async () => {
  parser = await createShellParser({ engineWasm, grammarWasm })
})

async function buildWs(): Promise<Workspace> {
  const a = new RAMResource()
  const b = new RAMResource()
  const reg = new OpsRegistry()
  reg.registerResource(a)
  reg.registerResource(b)
  const ws = new Workspace(
    { '/a/': a, '/b/': b },
    {
      mode: MountMode.WRITE,
      ops: reg,
      shellParser: parser,
      commandLimits: {
        '/a/': { cat: new Limit({ maxLines: 4, onExceed: OnExceed.TRUNCATE }) },
        '/b/': { cat: new Limit({ maxLines: 2, onExceed: OnExceed.ERROR }) },
      },
    },
  )
  await ws.execute("printf '1\\n2\\n3\\n4\\n5\\n' > /a/f.txt")
  await ws.execute("printf '6\\n7\\n8\\n9\\n10\\n' > /b/f.txt")
  return ws
}

describe('connection limit (src)', () => {
  it('single cat /a truncates to 4', async () => {
    const ws = await buildWs()
    const res = await ws.execute('cat /a/f.txt')
    await ws.close()
    expect(DEC.decode(res.stdout)).toBe('1\n2\n3\n4\n')
    expect(DEC.decode(res.stderr)).toContain('truncated')
  })

  it('semicolon: rightmost /a limit caps combined to 4', async () => {
    const ws = await buildWs()
    const res = await ws.execute('cat /b/f.txt ; cat /a/f.txt')
    await ws.close()
    expect(DEC.decode(res.stdout)).toBe('6\n7\n8\n9\n')
    expect(DEC.decode(res.stderr)).toContain('truncated')
  })

  it('or: rightmost /a limit caps to 4', async () => {
    const ws = await buildWs()
    const res = await ws.execute('false || cat /a/f.txt')
    await ws.close()
    expect(DEC.decode(res.stdout)).toBe('1\n2\n3\n4\n')
    expect(DEC.decode(res.stderr)).toContain('truncated')
  })

  it('and: rightmost /b limit errors', async () => {
    const ws = await buildWs()
    const res = await ws.execute('cat /a/f.txt && cat /b/f.txt')
    await ws.close()
    expect(res.exitCode).toBe(1)
    expect(DEC.decode(res.stderr)).toContain('truncated')
  })

  it('subshell: rightmost /a limit caps combined to 4', async () => {
    const ws = await buildWs()
    const res = await ws.execute('( cat /b/f.txt ; cat /a/f.txt )')
    await ws.close()
    expect(DEC.decode(res.stdout)).toBe('6\n7\n8\n9\n')
    expect(DEC.decode(res.stderr)).toContain('truncated')
  })

  it('repeated read keeps the per-mount limit (no cache-mount fallthrough)', async () => {
    const ws = await buildWs()
    const first = await ws.execute('cat /a/f.txt')
    const second = await ws.execute('cat /a/f.txt')
    await ws.close()
    expect(DEC.decode(first.stdout)).toBe('1\n2\n3\n4\n')
    expect(DEC.decode(second.stdout)).toBe('1\n2\n3\n4\n')
    expect(DEC.decode(second.stderr)).toContain('truncated')
  })
})
