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
import { expect, it } from 'vitest'
import { materialize } from '../../../io/types.ts'
import type { Occurrence } from '../../../policy/types.ts'
import { ParseScope } from '../../../shell/parse/scope.ts'
import { MountMode } from '../../../types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { EvaluationContext } from '../../evaluation.ts'
import { Argv } from '../../expand/argv.ts'
import { resolveTarget } from '../../lookup/lookup.ts'
import { executeNode } from '../../node/execute_node.ts'
import { Workspace } from '../../workspace/workspace.ts'
import { withOpts, type ExecuteNodeDeps } from '../deps.ts'
import { handleCommand } from './command.ts'
import type { ExecuteNodeFn } from './types.ts'

it('keeps the bound site after an identical function redefinition', async () => {
  const ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE })
  const body = 'f() { say "${BASH_SOURCE[0]}" "$LINENO"; }'
  const parser = new ParseScope()
  try {
    await ws.shell(`printf '%s\\n' '${body}' > /first; printf '\\n%s\\n' '${body}' > /second`)
    await ws.shell('shopt -s expand_aliases')
    await ws.shell("alias say='echo before'; source /first")
    const session = ws.getSession(ws.defaultSessionId)
    const target = resolveTarget('f', [], session, ws.registry)
    if (target.kind !== 'function') throw new Error('expected a shell function')
    const origin = session.functionSites.get('f')?.origin
    expect(origin).toBeDefined()
    expect(origin).not.toBeNull()

    await ws.shell("alias say='echo after'; source /second")
    expect(session.functions.f).toBe(target.body)
    expect((await ws.shell('f')).stdoutText).toBe('after /second 2\n')

    const deps: ExecuteNodeDeps = {
      registry: ws.registry,
      jobTable: ws.jobTable,
      namespace: ws.namespace,
      dispatch: () => {
        throw new Error('unexpected filesystem operation')
      },
      executeFn: () => {
        throw new Error('unexpected nested evaluation')
      },
      parser,
      handed: { claimed: [], parent: null, origin: null },
    }
    const origins: (Occurrence | null | undefined)[] = []
    const run: ExecuteNodeFn = (node, context, stdin, stack, opts) => {
      origins.push(opts?.handed?.origin)
      return executeNode(withOpts(deps, opts), node, context, stdin, stack)
    }
    const [out, io] = await handleCommand(
      deps,
      run,
      {
        argv: new Argv('f', [], []),
        target,
      },
      new EvaluationContext(session),
    )
    expect([new TextDecoder().decode(await materialize(out)), io.exitCode]).toEqual([
      'before /first 1\n',
      0,
    ])
    expect(origins).toHaveLength(1)
    expect(origins[0]).toBe(origin)
  } finally {
    parser.release()
    await ws.close()
  }
})
