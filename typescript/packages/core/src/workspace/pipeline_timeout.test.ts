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
const ENC = new TextEncoder()
const DEC = new TextDecoder()

let parser: ShellParser

beforeAll(async () => {
  parser = await createShellParser({ engineWasm, grammarWasm })
})

async function* slowStdin(): AsyncGenerator<Uint8Array> {
  for (;;) {
    await new Promise((r) => setTimeout(r, 10))
    yield ENC.encode('x'.repeat(1024))
  }
}

function buildWs(): Workspace {
  const ram = new RAMResource()
  const registry = new OpsRegistry()
  registry.registerResource(ram)
  return new Workspace(
    { '/data': ram },
    { mode: MountMode.WRITE, ops: registry, shellParser: parser },
  )
}

describe('pipeline timeout', () => {
  it('bounds a slow final stage', async () => {
    const ws = buildWs()
    ws.getSession(ws.defaultSessionId).pipelineTimeoutSeconds = 0.1
    try {
      const r = await ws.execute('cat | cat', { stdin: slowStdin() })
      expect(r.exitCode).toBe(124)
      expect(DEC.decode(r.stderr)).toContain('pipeline: timed out after 0.1s')
    } finally {
      await ws.close()
    }
  })

  it('is unbounded without a budget', async () => {
    const ws = buildWs()
    try {
      const r = await ws.execute('cat | cat', { stdin: ENC.encode('hi\n') })
      expect(r.exitCode).toBe(0)
      expect(DEC.decode(r.stdout)).toBe('hi\n')
    } finally {
      await ws.close()
    }
  })
})
