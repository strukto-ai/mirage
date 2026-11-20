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

import { EvaluationContext } from '../evaluation.ts'
import { describe, expect, it, vi } from 'vitest'
import { IOResult, materialize } from '../../io/types.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { JobTable } from '../../execution/job/index.ts'
import { MountMode } from '../../types.ts'
import { parse } from '../../shell/parse/parse.ts'
import type { DispatchFn } from '../../runtime/types.ts'
import { Namespace } from '../mount/namespace/namespace.ts'
import { MountRegistry } from '../mount/registry.ts'
import { SessionState } from '../session/session.ts'
import type { ExecuteNodeDeps } from '../executor/deps.ts'
import { Workspace } from '../workspace/workspace.ts'
import { runCommandTree } from './run_tree.ts'

function buildDeps(registry: MountRegistry): ExecuteNodeDeps {
  const dispatch: DispatchFn = () => Promise.resolve([null, new IOResult()])
  const executeFn = (): Promise<IOResult> => Promise.resolve(new IOResult())
  const jobTable = new JobTable()
  return {
    dispatch,
    registry,
    namespace: new Namespace(registry, (p) => Promise.resolve(registry.resolve(p))),
    jobTable,
    executeFn,
  }
}

function registry(): MountRegistry {
  const ram = new RAMVFS()
  return new MountRegistry({ '/': ram }, MountMode.WRITE)
}

describe('runCommandTree', () => {
  it('materializes stdout', async () => {
    const [stdout, io] = await runCommandTree(
      buildDeps(registry()),
      parse('echo hello'),
      new EvaluationContext(new SessionState({ sessionId: 'test', cwd: '/' })),
    )
    expect(io.exitCode).toBe(0)
    expect(new TextDecoder().decode(await materialize(stdout))).toContain('hello')
  })

  it('propagates a non-zero exit code', async () => {
    const [, io] = await runCommandTree(
      buildDeps(registry()),
      parse('false'),
      new EvaluationContext(new SessionState({ sessionId: 'test', cwd: '/' })),
    )
    expect(io.exitCode).not.toBe(0)
  })
})

describe('runCommandTree under a cancelled line', () => {
  const slow = 'touch /data/started; sleep 0.3; touch /data/late; echo /data/f'

  async function filesAfterCancel(line: string): Promise<string[]> {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    try {
      await ws.shell("printf 'hello\\n' > /data/f")
      const abort = new AbortController()
      const running = ws.shell(line, { signal: abort.signal })
      await vi.waitFor(() => ws.vfs.read('/data/started'), { interval: 5 })
      abort.abort()
      await expect(running).rejects.toMatchObject({ name: 'AbortError' })
      await new Promise((resolve) => setTimeout(resolve, 500))
      const io = await ws.shell('ls /data')
      return new TextDecoder().decode(io.stdout).split(/\s+/).filter(Boolean)
    } finally {
      await ws.close()
    }
  }

  it('stops the substitution in a backtick read', async () => {
    expect(await filesAfterCancel(`echo \`< $(${slow})\`; touch /data/after`)).toEqual(['f', 'started'])
  })

  it('stops the substitution in a $( ) read', async () => {
    expect(await filesAfterCancel(`echo $(< $(${slow})); touch /data/after`)).toEqual(['f', 'started'])
  })
})
