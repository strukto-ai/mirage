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
import { IOResult, materialize } from '../../io/types.ts'
import { OpsRegistry } from '../../ops/registry.ts'
import { RAMResource } from '../../resource/ram/ram.ts'
import type { JobTable } from '../../shell/job_table.ts'
import { NodeType as NT } from '../../shell/types.ts'
import { MountMode } from '../../types.ts'
import type { TSNodeLike } from '../expand/variable.ts'
import type { DispatchFn } from '../executor/cross_mount.ts'
import { Namespace } from '../mount/namespace/namespace.ts'
import { MountRegistry } from '../mount/registry.ts'
import { Session } from '../session/session.ts'
import { CommandSpec, Operand, OperandKind, Option } from '../../commands/spec/types.ts'
import { executeNode, type ExecuteNodeDeps } from './execute_node.ts'
import { specWordKinds } from '../expand/spec_hints.ts'

function decode(b: Uint8Array | null): string {
  return b === null ? '' : new TextDecoder().decode(b)
}

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

function plainRegistry(): MountRegistry {
  const ram = new RAMResource()
  const ops = new OpsRegistry()
  ops.registerResource(ram)
  return new MountRegistry({ '/ram': ram }, MountMode.WRITE)
}

describe('executeNode dispatcher', () => {
  it('throws on unknown node type', async () => {
    const reg = plainRegistry()
    const node: TSNodeLike = {
      type: 'not_a_real_type',
      text: '',
      children: [],
      namedChildren: [],
      isNamed: true,
    }
    await expect(
      executeNode(buildDeps(reg), node, new Session({ sessionId: 't' })),
    ).rejects.toThrow(/unsupported tree-sitter node type/)
  })

  it('FUNCTION_DEFINITION registers function body in session', async () => {
    const reg = plainRegistry()
    const stmt: TSNodeLike = {
      type: NT.COMMAND,
      text: 'echo hi',
      children: [],
      namedChildren: [],
      isNamed: true,
    }
    const body: TSNodeLike = {
      type: NT.COMPOUND_STATEMENT,
      text: '{ echo hi; }',
      children: [stmt],
      namedChildren: [stmt],
      isNamed: true,
    }
    const nameNode: TSNodeLike = {
      type: NT.WORD,
      text: 'greet',
      children: [],
      namedChildren: [],
      isNamed: true,
    }
    const fnNode: TSNodeLike = {
      type: NT.FUNCTION_DEFINITION,
      text: 'greet() { echo hi; }',
      children: [nameNode, body],
      namedChildren: [nameNode, body],
      isNamed: true,
    }
    const session = new Session({ sessionId: 't' })
    const [stdout, io] = await executeNode(buildDeps(reg), fnNode, session)
    expect(stdout).toBeNull()
    expect(io.exitCode).toBe(0)
    expect(session.functions.greet).toEqual([stmt])
  })

  it('VARIABLE_ASSIGNMENT writes env var', async () => {
    const reg = plainRegistry()
    const node: TSNodeLike = {
      type: NT.VARIABLE_ASSIGNMENT,
      text: 'FOO=bar',
      children: [],
      namedChildren: [],
      isNamed: true,
    }
    const session = new Session({ sessionId: 't' })
    const [, io] = await executeNode(buildDeps(reg), node, session)
    expect(io.exitCode).toBe(0)
    expect(session.env.FOO).toBe('bar')
  })

  it('VARIABLE_ASSIGNMENT with no "=" is a no-op', async () => {
    const reg = plainRegistry()
    const node: TSNodeLike = {
      type: NT.VARIABLE_ASSIGNMENT,
      text: 'JUNK',
      children: [],
      namedChildren: [],
      isNamed: true,
    }
    const session = new Session({ sessionId: 't' })
    await executeNode(buildDeps(reg), node, session)
    expect(Object.keys(session.env)).toEqual([])
  })

  it('NEGATED_COMMAND flips a zero exit into one', async () => {
    const reg = plainRegistry()
    const inner: TSNodeLike = {
      type: NT.COMMAND,
      text: 'true',
      children: [
        { type: NT.COMMAND_NAME, text: 'true', children: [], namedChildren: [], isNamed: true },
      ],
      namedChildren: [
        { type: NT.COMMAND_NAME, text: 'true', children: [], namedChildren: [], isNamed: true },
      ],
      isNamed: true,
    }
    const neg: TSNodeLike = {
      type: NT.NEGATED_COMMAND,
      text: '! true',
      children: [inner],
      namedChildren: [inner],
      isNamed: true,
    }
    const [, io] = await executeNode(buildDeps(reg), neg, new Session({ sessionId: 't' }))
    expect(io.exitCode).toBe(1)
  })

  it('NEGATED_COMMAND flips a nonzero exit into zero', async () => {
    const reg = plainRegistry()
    const innerName: TSNodeLike = {
      type: NT.COMMAND_NAME,
      text: 'false',
      children: [],
      namedChildren: [],
      isNamed: true,
    }
    const inner: TSNodeLike = {
      type: NT.COMMAND,
      text: 'false',
      children: [innerName],
      namedChildren: [innerName],
      isNamed: true,
    }
    const neg: TSNodeLike = {
      type: NT.NEGATED_COMMAND,
      text: '! false',
      children: [inner],
      namedChildren: [inner],
      isNamed: true,
    }
    const [, io] = await executeNode(buildDeps(reg), neg, new Session({ sessionId: 't' }))
    expect(io.exitCode).toBe(0)
  })

  it('shell builtin pwd prints session.cwd', async () => {
    const reg = plainRegistry()
    const cmd: TSNodeLike = {
      type: NT.COMMAND,
      text: 'pwd',
      children: [
        { type: NT.COMMAND_NAME, text: 'pwd', children: [], namedChildren: [], isNamed: true },
      ],
      namedChildren: [
        { type: NT.COMMAND_NAME, text: 'pwd', children: [], namedChildren: [], isNamed: true },
      ],
      isNamed: true,
    }
    const session = new Session({ sessionId: 't', cwd: '/ram/subdir' })
    const [stdout, io] = await executeNode(buildDeps(reg), cmd, session)
    expect(io.exitCode).toBe(0)
    expect(decode(await materialize(stdout))).toBe('/ram/subdir\n')
  })

  it('shell builtin true returns 0 with no stdout', async () => {
    const reg = plainRegistry()
    const cmd: TSNodeLike = {
      type: NT.COMMAND,
      text: 'true',
      children: [
        { type: NT.COMMAND_NAME, text: 'true', children: [], namedChildren: [], isNamed: true },
      ],
      namedChildren: [
        { type: NT.COMMAND_NAME, text: 'true', children: [], namedChildren: [], isNamed: true },
      ],
      isNamed: true,
    }
    const [stdout, io] = await executeNode(buildDeps(reg), cmd, new Session({ sessionId: 't' }))
    expect(stdout).toBeNull()
    expect(io.exitCode).toBe(0)
  })

  it('shell builtin false returns 1', async () => {
    const reg = plainRegistry()
    const cmd: TSNodeLike = {
      type: NT.COMMAND,
      text: 'false',
      children: [
        { type: NT.COMMAND_NAME, text: 'false', children: [], namedChildren: [], isNamed: true },
      ],
      namedChildren: [
        { type: NT.COMMAND_NAME, text: 'false', children: [], namedChildren: [], isNamed: true },
      ],
      isNamed: true,
    }
    const [, io] = await executeNode(buildDeps(reg), cmd, new Session({ sessionId: 't' }))
    expect(io.exitCode).toBe(1)
  })

  it('PROGRAM skips ERROR nodes and unnamed tokens, runs only named children', async () => {
    const reg = plainRegistry()
    const trueCmd: TSNodeLike = {
      type: NT.COMMAND,
      text: 'true',
      children: [
        { type: NT.COMMAND_NAME, text: 'true', children: [], namedChildren: [], isNamed: true },
      ],
      namedChildren: [
        { type: NT.COMMAND_NAME, text: 'true', children: [], namedChildren: [], isNamed: true },
      ],
      isNamed: true,
    }
    const errNode: TSNodeLike = {
      type: NT.ERROR,
      text: '??',
      children: [],
      namedChildren: [],
      isNamed: true,
    }
    const punctNode: TSNodeLike = {
      type: NT.SEMI,
      text: ';',
      children: [],
      namedChildren: [],
      isNamed: false,
    }
    const prog: TSNodeLike = {
      type: NT.PROGRAM,
      text: 'true',
      children: [trueCmd, punctNode, errNode],
      namedChildren: [trueCmd, errNode],
      isNamed: true,
    }
    const session = new Session({ sessionId: 't' })
    const [, io] = await executeNode(buildDeps(reg), prog, session)
    expect(io.exitCode).toBe(0)
    expect(session.lastExitCode).toBe(0)
  })

  it('COMMENT node dispatches as a no-op (regression: tree-sitter-bash trailing # comments)', async () => {
    const reg = plainRegistry()
    const comment: TSNodeLike = {
      type: NT.COMMENT,
      text: '# -l, -a clustered',
      children: [],
      namedChildren: [],
      isNamed: true,
    }
    const [stdout, io, exec] = await executeNode(
      buildDeps(reg),
      comment,
      new Session({ sessionId: 't' }),
    )
    expect(stdout).toBeNull()
    expect(io.exitCode).toBe(0)
    expect(exec.command).toBe('')
  })

  it('PROGRAM skips trailing COMMENT siblings (e.g. `ls -la /x   # note`)', async () => {
    // Regression: `ls -la /r2/Review        # -l, -a clustered` produced
    // "unsupported tree-sitter node type: comment" because the program loop
    // dispatched the comment sibling as if it were a statement.
    const reg = plainRegistry()
    const trueCmd: TSNodeLike = {
      type: NT.COMMAND,
      text: 'true',
      children: [
        { type: NT.COMMAND_NAME, text: 'true', children: [], namedChildren: [], isNamed: true },
      ],
      namedChildren: [
        { type: NT.COMMAND_NAME, text: 'true', children: [], namedChildren: [], isNamed: true },
      ],
      isNamed: true,
    }
    const comment: TSNodeLike = {
      type: NT.COMMENT,
      text: '# trailing note',
      children: [],
      namedChildren: [],
      isNamed: true,
    }
    const prog: TSNodeLike = {
      type: NT.PROGRAM,
      text: 'true # trailing note',
      children: [trueCmd, comment],
      namedChildren: [trueCmd, comment],
      isNamed: true,
    }
    const session = new Session({ sessionId: 't' })
    const [, io] = await executeNode(buildDeps(reg), prog, session)
    expect(io.exitCode).toBe(0)
    expect(session.lastExitCode).toBe(0)
  })

  it('COMPOUND_STATEMENT skips inner COMMENT children', async () => {
    const reg = plainRegistry()
    const trueCmd: TSNodeLike = {
      type: NT.COMMAND,
      text: 'true',
      children: [
        { type: NT.COMMAND_NAME, text: 'true', children: [], namedChildren: [], isNamed: true },
      ],
      namedChildren: [
        { type: NT.COMMAND_NAME, text: 'true', children: [], namedChildren: [], isNamed: true },
      ],
      isNamed: true,
    }
    const comment: TSNodeLike = {
      type: NT.COMMENT,
      text: '# mid-block',
      children: [],
      namedChildren: [],
      isNamed: true,
    }
    const falseCmd: TSNodeLike = {
      type: NT.COMMAND,
      text: 'false',
      children: [
        { type: NT.COMMAND_NAME, text: 'false', children: [], namedChildren: [], isNamed: true },
      ],
      namedChildren: [
        { type: NT.COMMAND_NAME, text: 'false', children: [], namedChildren: [], isNamed: true },
      ],
      isNamed: true,
    }
    const compound: TSNodeLike = {
      type: NT.COMPOUND_STATEMENT,
      text: '{ true; # mid-block\nfalse; }',
      children: [trueCmd, comment, falseCmd],
      namedChildren: [trueCmd, comment, falseCmd],
      isNamed: true,
    }
    const [, io, exec] = await executeNode(
      buildDeps(reg),
      compound,
      new Session({ sessionId: 't' }),
    )
    // The comment must not become the lastExec; the real `false` should.
    expect(exec.command).toBe('false')
    expect(io.exitCode).toBe(1)
  })

  it('COMPOUND_STATEMENT merges child io and returns last exec node', async () => {
    const reg = plainRegistry()
    const trueCmd: TSNodeLike = {
      type: NT.COMMAND,
      text: 'true',
      children: [
        { type: NT.COMMAND_NAME, text: 'true', children: [], namedChildren: [], isNamed: true },
      ],
      namedChildren: [
        { type: NT.COMMAND_NAME, text: 'true', children: [], namedChildren: [], isNamed: true },
      ],
      isNamed: true,
    }
    const falseCmd: TSNodeLike = {
      type: NT.COMMAND,
      text: 'false',
      children: [
        { type: NT.COMMAND_NAME, text: 'false', children: [], namedChildren: [], isNamed: true },
      ],
      namedChildren: [
        { type: NT.COMMAND_NAME, text: 'false', children: [], namedChildren: [], isNamed: true },
      ],
      isNamed: true,
    }
    const compound: TSNodeLike = {
      type: NT.COMPOUND_STATEMENT,
      text: '{ true; false; }',
      children: [trueCmd, falseCmd],
      namedChildren: [trueCmd, falseCmd],
      isNamed: true,
    }
    const [, io, exec] = await executeNode(
      buildDeps(reg),
      compound,
      new Session({ sessionId: 't' }),
    )
    expect(io.exitCode).toBe(1)
    expect(exec.command).toBe('false')
  })
})

describe('specWordKinds — numericShorthand', () => {
  const headSpec = new CommandSpec({
    options: [new Option({ short: '-n', valueKind: OperandKind.TEXT, numericShorthand: true })],
    rest: new Operand({ kind: OperandKind.PATH }),
  })

  it('treats -3 as a flag value, not a path (head/tail GNU shorthand)', () => {
    expect(specWordKinds(headSpec, ['-3', '/ram/file'])).toEqual([null, OperandKind.PATH])
  })

  it('falls back to treating -3 as a positional when spec lacks numericShorthand', () => {
    const noShortcut = new CommandSpec({
      options: [new Option({ short: '-n', valueKind: OperandKind.TEXT })],
      rest: new Operand({ kind: OperandKind.PATH }),
    })
    expect(specWordKinds(noShortcut, ['-3', '/ram/file'])).toEqual([
      OperandKind.PATH,
      OperandKind.PATH,
    ])
  })
})
