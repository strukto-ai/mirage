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
import { createShellParser, type ShellParser } from '../shell/parse/index.ts'
import { MountMode } from '../types.ts'
import { Workspace } from './workspace/workspace.ts'

const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))
const DEC = new TextDecoder()

let parser: ShellParser

beforeAll(async () => {
  parser = await createShellParser({ engineWasm, grammarWasm })
})

async function buildWs(): Promise<Workspace> {
  const ram = new RAMResource()
  const registry = new OpsRegistry()
  registry.registerResource(ram)
  const ws = new Workspace(
    { '/': ram },
    { mode: MountMode.WRITE, ops: registry, shellParser: parser },
  )
  await ws.execute('mkdir -p /data/sub')
  await ws.execute('touch /data/a.txt /data/sub/nested.txt')
  return ws
}

async function run(
  ws: Workspace,
  cmd: string,
): Promise<{ code: number; out: string; err: string }> {
  const res = await ws.execute(cmd)
  return { code: res.exitCode, out: DEC.decode(res.stdout), err: DEC.decode(res.stderr) }
}

describe('find unknown predicate', () => {
  it('errors exit 1 and prints nothing on a bogus predicate', async () => {
    const ws = await buildWs()
    const { code, out, err } = await run(ws, 'find /data -boguspredicate')
    expect(code).toBe(1)
    expect(out).toBe('')
    expect(err).toContain('-boguspredicate')
    await ws.close()
  })

  it('errors exit 1 on unsupported -regex', async () => {
    const ws = await buildWs()
    const { code } = await run(ws, "find /data -regex '.*'")
    expect(code).toBe(1)
    await ws.close()
  })

  it('still exits 0 for a supported -name', async () => {
    const ws = await buildWs()
    const { code, out } = await run(ws, "find /data -name '*.txt'")
    expect(code).toBe(0)
    expect(out).toContain('/data/a.txt')
    await ws.close()
  })
})
