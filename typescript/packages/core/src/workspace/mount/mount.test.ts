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
import { command, type CommandFn, RegisteredCommand } from '../../commands/config.ts'
import { CommandSpec, Operand, OperandKind } from '../../commands/spec/types.ts'
import { IOResult } from '../../io/types.ts'
import type { Accessor } from '../../accessor/base.ts'
import { revisionFor } from '../../observe/context.ts'
import type { RegisteredOp } from '../../ops/registry.ts'
import type { Resource } from '../../resource/base.ts'
import { MountMode, PathSpec } from '../../types.ts'
import { Mount } from './mount.ts'

class StubResource implements Resource {
  readonly kind = 'ram'
  open(): Promise<void> {
    return Promise.resolve()
  }
  close(): Promise<void> {
    return Promise.resolve()
  }
}

const BASIC_SPEC = new CommandSpec({ rest: new Operand({ kind: OperandKind.PATH }) })

const OK_CMD: CommandFn = () => [null, new IOResult({ exitCode: 0 })]
const OK_CMD_STDOUT: CommandFn = () => [new TextEncoder().encode('ok'), new IOResult()]

function makeMount(mode: MountMode = MountMode.WRITE): Mount {
  return new Mount({ prefix: '/ram/', resource: new StubResource(), mode })
}

describe('Mount constructor validation', () => {
  it('requires prefix to start with /', () => {
    expect(() => new Mount({ prefix: 'ram/', resource: new StubResource() })).toThrow(/start with/)
  })

  it('requires prefix to end with /', () => {
    expect(() => new Mount({ prefix: '/ram', resource: new StubResource() })).toThrow(/end with/)
  })

  it('rejects double-slash prefixes', () => {
    expect(() => new Mount({ prefix: '//ram/', resource: new StubResource() })).toThrow(/\/\//)
  })

  it('defaults mode to READ', () => {
    const m = new Mount({ prefix: '/ram/', resource: new StubResource() })
    expect(m.mode).toBe(MountMode.READ)
  })
})

describe('Mount.resolveCommand fallback chain', () => {
  it('prefers filetype-specific over resource-specific', () => {
    const m = makeMount()
    const [generic] = command({ name: 'cat', resource: 'ram', spec: BASIC_SPEC, fn: OK_CMD })
    const [json] = command({
      name: 'cat',
      resource: 'ram',
      spec: BASIC_SPEC,
      fn: OK_CMD,
      filetype: '.json',
    })
    if (generic === undefined || json === undefined) throw new Error('missing')
    m.register(generic)
    m.register(json)
    expect(m.resolveCommand('cat', '.json')).toBe(json)
    expect(m.resolveCommand('cat', '.csv')).toBe(generic)
  })

  it('falls back to general when no resource-specific match', () => {
    const m = makeMount()
    const [echo] = command({ name: 'echo', resource: null, spec: BASIC_SPEC, fn: OK_CMD })
    if (echo === undefined) throw new Error('missing')
    m.registerGeneral(echo)
    expect(m.resolveCommand('echo')).toBe(echo)
  })

  it('returns null when nothing matches', () => {
    const m = makeMount()
    expect(m.resolveCommand('nope')).toBeNull()
  })
})

describe('Mount.specFor', () => {
  it('returns the registered spec', () => {
    const m = makeMount()
    const [cmd] = command({ name: 'cat', resource: 'ram', spec: BASIC_SPEC, fn: OK_CMD })
    if (cmd === undefined) throw new Error('missing')
    m.register(cmd)
    expect(m.specFor('cat')).toBe(cmd.spec)
  })

  it('returns null for unknown commands', () => {
    expect(makeMount().specFor('nope')).toBeNull()
  })
})

describe('Mount.filetypeHandlers', () => {
  it('returns only filetype-specific variants of a command', () => {
    const m = makeMount()
    const [generic] = command({ name: 'cat', resource: 'ram', spec: BASIC_SPEC, fn: OK_CMD })
    const [json] = command({
      name: 'cat',
      resource: 'ram',
      spec: BASIC_SPEC,
      fn: OK_CMD,
      filetype: '.json',
    })
    if (generic === undefined || json === undefined) throw new Error('missing')
    m.register(generic)
    m.register(json)
    const fns = m.filetypeHandlers('cat')
    expect(Object.keys(fns)).toEqual(['.json'])
  })
})

describe('Mount.unregister', () => {
  it('removes all cmd variants and general fallbacks with the same name', () => {
    const m = makeMount()
    const [generic] = command({ name: 'cat', resource: 'ram', spec: BASIC_SPEC, fn: OK_CMD })
    const [json] = command({
      name: 'cat',
      resource: 'ram',
      spec: BASIC_SPEC,
      fn: OK_CMD,
      filetype: '.json',
    })
    if (generic === undefined || json === undefined) throw new Error('missing')
    m.register(generic)
    m.register(json)
    m.unregister(['cat'])
    expect(m.resolveCommand('cat')).toBeNull()
    expect(m.resolveCommand('cat', '.json')).toBeNull()
    expect(m.specFor('cat')).toBeNull()
  })
})

describe('Mount.executeCmd', () => {
  it('returns 127 for unknown command', async () => {
    const m = makeMount()
    const [, io] = await m.executeCmd('nope', [], [], {})
    expect(io.exitCode).toBe(127)
    expect(new TextDecoder().decode(io.stderr as Uint8Array)).toMatch(/command not found/)
  })

  it('dispatches to a registered command and returns its IOResult', async () => {
    const m = makeMount()
    const [cmd] = command({
      name: 'cat',
      resource: 'ram',
      spec: BASIC_SPEC,
      fn: OK_CMD_STDOUT,
    })
    if (cmd === undefined) throw new Error('missing')
    m.register(cmd)
    const [stdout, io] = await m.executeCmd('cat', [PathSpec.fromStrPath('/x.txt')], [], {})
    expect(io.exitCode).toBe(0)
    expect(stdout).toBeInstanceOf(Uint8Array)
  })

  it('rejects write commands on a READ mount', async () => {
    const m = makeMount(MountMode.READ)
    const [wcmd] = command({
      name: 'rm',
      resource: 'ram',
      spec: BASIC_SPEC,
      fn: OK_CMD,
      write: true,
    })
    if (wcmd === undefined) throw new Error('missing')
    m.register(wcmd)
    const [, io] = await m.executeCmd('rm', [PathSpec.fromStrPath('/x')], [], {})
    expect(io.exitCode).toBe(1)
    expect(new TextDecoder().decode(io.stderr as Uint8Array)).toMatch(/read-only/)
  })

  it('passes the mount prefix through PathSpecs given to the command', async () => {
    const m = makeMount()
    let seenPrefix: string | null = null
    const fn: CommandFn = (_accessor, paths) => {
      seenPrefix = paths[0]?.prefix ?? null
      return [null, new IOResult()]
    }
    const [cmd] = command({ name: 'cat', resource: 'ram', spec: BASIC_SPEC, fn })
    if (cmd === undefined) throw new Error('missing')
    m.register(cmd)
    await m.executeCmd('cat', [PathSpec.fromStrPath('/hello.txt')], [], {})
    expect(seenPrefix).toBe('/ram')
  })
})

describe('Mount.executeOp', () => {
  it('dispatches to a registered op', async () => {
    const m = makeMount()
    const op: RegisteredOp = {
      name: 'read',
      resource: 'ram',
      filetype: null,
      write: false,
      fn: (_accessor: Accessor, path: PathSpec) =>
        Promise.resolve(new TextEncoder().encode(path.original)),
    }
    m.registerOp(op)
    const result = await m.executeOp('read', '/x.txt')
    expect(result).toBeInstanceOf(Uint8Array)
  })

  it('throws on unknown op', async () => {
    const m = makeMount()
    await expect(m.executeOp('nope', '/x')).rejects.toThrow(/no op/)
  })

  it('rejects write ops on READ mount', async () => {
    const m = makeMount(MountMode.READ)
    const op: RegisteredOp = {
      name: 'write',
      resource: 'ram',
      filetype: null,
      write: true,
      fn: () => Promise.resolve(),
    }
    m.registerOp(op)
    await expect(m.executeOp('write', '/x')).rejects.toThrow(/read-only/)
  })
})

describe('Mount.revisions', () => {
  it('starts empty and exposes the revisions map directly', () => {
    const m = makeMount()
    expect(m.revisions.size).toBe(0)
  })

  it('exposes installed pins to read functions via revisionFor during executeOp', async () => {
    const m = makeMount()
    m.revisions.set('/ram/x.txt', 'rev-1')
    let observed: string | null = '<unset>'
    const op: RegisteredOp = {
      name: 'read',
      resource: 'ram',
      filetype: null,
      write: false,
      fn: (_accessor: Accessor, path: PathSpec) => {
        observed = revisionFor(path.original)
        return Promise.resolve(new Uint8Array())
      },
    }
    m.registerOp(op)
    await m.executeOp('read', '/ram/x.txt')
    expect(observed).toBe('rev-1')
  })

  it('does not leak revisions outside the executeOp scope', async () => {
    const m = makeMount()
    m.revisions.set('/ram/x.txt', 'rev-1')
    const op: RegisteredOp = {
      name: 'read',
      resource: 'ram',
      filetype: null,
      write: false,
      fn: () => Promise.resolve(new Uint8Array()),
    }
    m.registerOp(op)
    await m.executeOp('read', '/ram/x.txt')
    expect(revisionFor('/ram/x.txt')).toBeNull()
  })
})

describe('Mount.isGeneralCommand', () => {
  it('returns true for general commands', () => {
    const m = makeMount()
    const [cmd] = command({ name: 'seq', resource: null, spec: BASIC_SPEC, fn: OK_CMD })
    if (cmd === undefined) throw new Error('missing')
    m.registerGeneral(cmd)
    expect(m.isGeneralCommand('seq')).toBe(true)
  })

  it('returns false for resource-specific commands', () => {
    const m = makeMount()
    const [cmd] = command({ name: 'cat', resource: 'ram', spec: BASIC_SPEC, fn: OK_CMD })
    if (cmd === undefined) throw new Error('missing')
    m.register(cmd)
    expect(m.isGeneralCommand('cat')).toBe(false)
  })

  it('returns false for unknown commands', () => {
    expect(makeMount().isGeneralCommand('nope')).toBe(false)
  })
})

describe('Mount.registerCross / resolveCross', () => {
  it('round-trips a cross-mount command by (name, targetResource)', () => {
    const m = makeMount()
    const rc = new RegisteredCommand({
      name: 'cp',
      spec: BASIC_SPEC,
      resource: 'ram->disk',
      fn: OK_CMD,
      src: 'ram',
      dst: 'disk',
    })
    m.registerCross(rc, 'disk')
    expect(m.resolveCross('cp', 'disk')).toBe(rc)
    expect(m.resolveCross('cp', 'gdrive')).toBeNull()
  })
})
