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
import { IOResult, materialize } from '../../io/types.ts'
import { OpsRegistry } from '../../ops/registry.ts'
import { RAMResource } from '../../resource/ram/ram.ts'
import type { JobTable } from '../../shell/job_table.ts'
import { createShellParser, type ShellParser } from '../../shell/parse.ts'
import { MountMode } from '../../types.ts'
import type { TSNodeLike } from '../expand/variable.ts'
import type { DispatchFn } from '../executor/cross_mount.ts'
import { Namespace } from '../mount/namespace.ts'
import { MountRegistry } from '../mount/registry.ts'
import { Session } from '../session/session.ts'
import { type ExecuteNodeDeps } from './execute_node.ts'
import { runCommandTree } from './run_tree.ts'

const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

let parser: ShellParser

beforeAll(async () => {
  parser = await createShellParser({ engineWasm, grammarWasm })
})

function buildDeps(registry: MountRegistry): ExecuteNodeDeps {
  const dispatch: DispatchFn = () => Promise.resolve([null, new IOResult()])
  const executeFn = (): Promise<IOResult> => Promise.resolve(new IOResult())
  const jobTable: JobTable | null = null
  return {
    dispatch,
    registry,
    namespace: new Namespace(registry, (p) => Promise.resolve(registry.resolve(p))),
    jobTable,
    executeFn,
    agentId: 'test-agent',
    workspaceId: 'test-ws',
    registerCloser: (): void => undefined,
  }
}

function registry(): MountRegistry {
  const ram = new RAMResource()
  const ops = new OpsRegistry()
  ops.registerResource(ram)
  return new MountRegistry({ '/': ram }, MountMode.WRITE)
}

function parse(command: string): TSNodeLike {
  return parser.parse(command) as unknown as TSNodeLike
}

describe('runCommandTree', () => {
  it('materializes stdout', async () => {
    const [stdout, io] = await runCommandTree(
      buildDeps(registry()),
      parse('echo hello'),
      new Session({ sessionId: 'test', cwd: '/' }),
    )
    expect(io.exitCode).toBe(0)
    expect(new TextDecoder().decode(await materialize(stdout))).toContain('hello')
  })

  it('propagates a non-zero exit code', async () => {
    const [, io] = await runCommandTree(
      buildDeps(registry()),
      parse('false'),
      new Session({ sessionId: 'test', cwd: '/' }),
    )
    expect(io.exitCode).not.toBe(0)
  })
})
