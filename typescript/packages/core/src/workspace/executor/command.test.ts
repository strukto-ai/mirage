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
import { command } from '../../commands/config.ts'
import { CommandSpec, Operand, OperandKind, Option } from '../../commands/spec/types.ts'
import { IOResult } from '../../io/types.ts'
import { JobTable } from '../../shell/job_table.ts'
import type { Resource } from '../../resource/base.ts'
import { MountMode, PathSpec } from '../../types.ts'
import { MountRegistry } from '../mount/registry.ts'
import { Session } from '../session/session.ts'
import type { ExecuteNodeFn } from './jobs.ts'
import type { DispatchFn } from './cross_mount.ts'
import { handleCommand } from './command.ts'

class StubResource implements Resource {
  constructor(readonly kind: string) {}
  open(): Promise<void> {
    return Promise.resolve()
  }
  close(): Promise<void> {
    return Promise.resolve()
  }
}

const NEVER_EXECUTE: ExecuteNodeFn = () => {
  throw new Error('executeNode should not have been called')
}

const NEVER_DISPATCH: DispatchFn = () => {
  throw new Error('dispatch should not have been called')
}

function decode(b: Uint8Array | null): string {
  if (b === null) return ''
  return new TextDecoder().decode(b)
}

describe('handleCommand — command not found', () => {
  it('returns exit 127 when no mount has the command', async () => {
    const reg = new MountRegistry({ '/ram': new StubResource('ram') }, MountMode.WRITE)
    const [, io, exec] = await handleCommand(
      NEVER_EXECUTE,
      NEVER_DISPATCH,
      reg,
      ['nope'],
      new Session({ sessionId: 'test' }),
    )
    expect(io.exitCode).toBe(127)
    expect(exec.exitCode).toBe(127)
    expect(decode(io.stderr as Uint8Array)).toMatch(/command not found/)
  })
})

describe('handleCommand — dispatches to mount that has the command', () => {
  const BASIC_SPEC = new CommandSpec({ rest: new Operand({ kind: OperandKind.PATH }) })

  it('routes to a mount whose resource registered the command', async () => {
    const ram = new StubResource('ram')
    const reg = new MountRegistry({ '/ram': ram }, MountMode.WRITE)
    const mount = reg.mountFor('/ram/x')
    if (mount === null) throw new Error('mount missing')
    const [cmd] = command({
      name: 'cat',
      resource: 'ram',
      spec: BASIC_SPEC,
      fn: () => [new TextEncoder().encode('hello'), new IOResult()],
    })
    if (cmd === undefined) throw new Error('cmd missing')
    mount.register(cmd)

    const [stdout, io, exec] = await handleCommand(
      NEVER_EXECUTE,
      NEVER_DISPATCH,
      reg,
      ['cat', PathSpec.fromStrPath('/ram/x')],
      new Session({ sessionId: 'test' }),
    )
    expect(io.exitCode).toBe(0)
    expect(exec.exitCode).toBe(0)
    expect(decode(stdout as Uint8Array)).toBe('hello')
  })

  it('parses flags through the spec and forwards them', async () => {
    const ram = new StubResource('ram')
    const reg = new MountRegistry({ '/ram': ram }, MountMode.WRITE)
    const mount = reg.mountFor('/ram')
    if (mount === null) throw new Error('mount missing')
    const spec = new CommandSpec({
      options: [new Option({ short: '-n', valueKind: OperandKind.TEXT })],
      rest: new Operand({ kind: OperandKind.PATH }),
    })
    let seenFlags: Record<string, string | boolean | string[]> = {}
    const [cmd] = command({
      name: 'head',
      resource: 'ram',
      spec,
      fn: (_accessor, _paths, _texts, opts) => {
        seenFlags = opts.flags
        return [null, new IOResult()]
      },
    })
    if (cmd === undefined) throw new Error('cmd missing')
    mount.register(cmd)

    await handleCommand(
      NEVER_EXECUTE,
      NEVER_DISPATCH,
      reg,
      ['head', '-n', '5', PathSpec.fromStrPath('/ram/x')],
      new Session({ sessionId: 'test' }),
    )
    expect(seenFlags.n).toBe('5')
  })
})

describe('handleCommand — cross-mount', () => {
  it('rejects multi-mount paths when cmd is not cross-capable', async () => {
    const reg = new MountRegistry(
      { '/ram': new StubResource('ram'), '/disk': new StubResource('disk') },
      MountMode.WRITE,
    )
    const mount = reg.mountFor('/ram')
    if (mount === null) throw new Error('mount missing')
    const [cmd] = command({
      name: 'mycmd',
      resource: 'ram',
      spec: new CommandSpec({ rest: new Operand({ kind: OperandKind.PATH }) }),
      fn: () => [null, new IOResult()],
    })
    if (cmd === undefined) throw new Error('cmd missing')
    mount.register(cmd)
    const [, io, exec] = await handleCommand(
      NEVER_EXECUTE,
      NEVER_DISPATCH,
      reg,
      ['mycmd', PathSpec.fromStrPath('/ram/a'), PathSpec.fromStrPath('/disk/b')],
      new Session({ sessionId: 'test' }),
    )
    expect(io.exitCode).toBe(1)
    expect(exec.exitCode).toBe(1)
    expect(decode(io.stderr as Uint8Array)).toMatch(/cross-mount not supported/)
  })
})

describe('handleCommand — job builtins', () => {
  it('routes "jobs" to handleJobs when jobTable provided', async () => {
    const reg = new MountRegistry({ '/ram': new StubResource('ram') }, MountMode.WRITE)
    const jt = new JobTable()
    const [, io] = await handleCommand(
      NEVER_EXECUTE,
      NEVER_DISPATCH,
      reg,
      ['jobs'],
      new Session({ sessionId: 'test' }),
      null,
      null,
      jt,
    )
    expect(io.exitCode).toBe(0)
  })

  it('routes "kill N" to handleKill', async () => {
    const reg = new MountRegistry({ '/ram': new StubResource('ram') }, MountMode.WRITE)
    const jt = new JobTable()
    const [, io] = await handleCommand(
      NEVER_EXECUTE,
      NEVER_DISPATCH,
      reg,
      ['kill', '999'],
      new Session({ sessionId: 'test' }),
      null,
      null,
      jt,
    )
    expect(io.exitCode).toBe(1)
    expect(decode(io.stderr as Uint8Array)).toMatch(/no such job/)
  })
})
