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

import { mountPrefixOf } from '../../utils/key_prefix.ts'
import { describe, expect, it } from 'vitest'
import {
  command,
  type CommandFn,
  type CommandOpts,
  type ExecContext,
  RegisteredCommand,
} from '../../commands/config.ts'
import { CommandSpec, Operand } from '../../commands/spec/types.ts'
import { IOResult } from '../../io/types.ts'
import type { Accessor } from '../../accessor/base.ts'
import { revisionFor } from '../../observe/context.ts'
import type { RegisteredOp } from '../../ops/registry.ts'
import { BaseResource, type Resource } from '../../resource/base.ts'
import { FileStat, FileType, Limit, MountMode, PathSpec } from '../../types.ts'
import { MountEntry } from './mount.ts'

class StubResource extends BaseResource implements Resource {
  readonly kind = 'ram'
  open(): Promise<void> {
    return Promise.resolve()
  }
  override close(): Promise<void> {
    return Promise.resolve()
  }
}

const BASIC_SPEC = new CommandSpec({ rest: new Operand({ type: 'path' }) })

const OK_CMD: CommandFn = () => [null, new IOResult({ exitCode: 0 })]
const OK_CMD_STDOUT: CommandFn = () => [new TextEncoder().encode('ok'), new IOResult()]
const HANG_CMD: CommandFn = () => new Promise(() => undefined)

function makeMount(mode: MountMode = MountMode.WRITE): MountEntry {
  return new MountEntry({ prefix: '/ram/', resource: new StubResource(), mode })
}

describe('Mount constructor validation', () => {
  it('requires prefix to start with /', () => {
    expect(() => new MountEntry({ prefix: 'ram/', resource: new StubResource() })).toThrow(
      /start with/,
    )
  })

  it('requires prefix to end with /', () => {
    expect(() => new MountEntry({ prefix: '/ram', resource: new StubResource() })).toThrow(
      /end with/,
    )
  })

  it('rejects double-slash prefixes', () => {
    expect(() => new MountEntry({ prefix: '//ram/', resource: new StubResource() })).toThrow(/\/\//)
  })

  it('defaults mode to READ', () => {
    const m = new MountEntry({ prefix: '/ram/', resource: new StubResource() })
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

  it('terminates the read-only refusal with a newline', async () => {
    // stderr accumulates across a line, so an unterminated refusal ran
    // into the next one: `{ rm /ro/a; rm /ro/b; }` printed the single
    // line `rm: read-only mount at /ro/rm: read-only mount at /ro/`.
    // It is also the line the node table renders for a refused symlink
    // (shared.readOnlyError), which concatenates with this one.
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
    expect(new TextDecoder().decode(io.stderr as Uint8Array)).toBe(
      `rm: read-only mount at ${m.prefix}\n`,
    )
  })

  it('passes the mount prefix through PathSpecs given to the command', async () => {
    const m = makeMount()
    let seenPrefix: string | null = null
    const fn: CommandFn = (_accessor, paths) => {
      seenPrefix =
        (paths[0] === undefined
          ? undefined
          : mountPrefixOf(paths[0].virtual, paths[0].resourcePath)) ?? null
      return [null, new IOResult()]
    }
    const [cmd] = command({ name: 'cat', resource: 'ram', spec: BASIC_SPEC, fn })
    if (cmd === undefined) throw new Error('missing')
    m.register(cmd)
    await m.executeCmd('cat', [PathSpec.fromStrPath('/ram/hello.txt')], [], {})
    expect(seenPrefix).toBe('/ram')
  })

  it('a directory does not route to a filetype handler', async () => {
    // A filetype handler is chosen from the operand's NAME, and a
    // directory can carry any extension, so without a type check `cat`
    // on a directory named `dir.tally` runs the renderer, which reads
    // bytes that are not there and reports ENOENT: registering a
    // renderer made the command worse than the built-in it replaced.
    const m = makeMount()
    const fired: string[] = []
    const renderer: CommandFn = (_accessor, paths) => {
      fired.push(paths[0]?.virtual ?? '')
      return [new TextEncoder().encode('rendered\n'), new IOResult()]
    }
    const builtins: string[] = []
    const builtin: CommandFn = (_accessor, paths) => {
      builtins.push(paths[0]?.virtual ?? '')
      return [null, new IOResult()]
    }
    const [plain] = command({ name: 'cat', resource: 'ram', spec: BASIC_SPEC, fn: builtin })
    const [typed] = command({
      name: 'cat',
      resource: 'ram',
      spec: BASIC_SPEC,
      fn: renderer,
      filetype: '.tally',
    })
    if (plain === undefined || typed === undefined) throw new Error('missing')
    m.register(plain)
    m.register(typed)
    const statPath = (p: string): Promise<FileStat | null> =>
      Promise.resolve(
        p.endsWith('dir.tally')
          ? new FileStat({ name: p, type: FileType.DIRECTORY })
          : new FileStat({ name: p, type: FileType.FILE, size: 4 }),
      )

    await m.executeCmd('cat', [PathSpec.fromStrPath('/dir.tally')], [], {}, { statPath })
    expect(fired).toEqual([])
    expect(builtins).toEqual(['/dir.tally'])

    await m.executeCmd('cat', [PathSpec.fromStrPath('/file.tally')], [], {}, { statPath })
    expect(fired).toEqual(['/file.tally'])
  })

  it('a null limitOverride does not shadow the mount own table', async () => {
    // The override carries the origin mount's cap across a warm-cache
    // redirect; a path-less command from an unmounted cwd resolves no
    // origin and passes null, which must fall through to the serving
    // mount's command_limits (python always reads the serving
    // mount's own table).
    const m = makeMount()
    m.commandLimits.set('cat', new Limit({ timeoutSeconds: 0.05 }))
    const [cmd] = command({ name: 'cat', resource: 'ram', spec: BASIC_SPEC, fn: HANG_CMD })
    if (cmd === undefined) throw new Error('missing')
    m.register(cmd)
    await expect(
      m.executeCmd('cat', [PathSpec.fromStrPath('/x.txt')], [], {}, { limitOverride: null }),
    ).rejects.toThrow(/cat: timed out after 0.05s/)
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
        Promise.resolve(new TextEncoder().encode(path.virtual)),
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
        observed = revisionFor(path.virtual)
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

describe('ExecContext parity with CommandOpts', () => {
  it('every line fact is spelled as CommandOpts spells it', () => {
    // executeCmd re-boxes the bag onto CommandOpts, so a fact spelled
    // two ways across that seam is two vocabularies for one plane.
    // Checked at compile time because a TS interface has no fields to
    // enumerate at runtime. `limitOverride` is the one execution
    // control executeCmd consumes itself rather than forwards, so it
    // is the one exemption. The Python twin is
    // tests/commands/test_exec_context_parity.py.
    type Shared = { [K in keyof Omit<ExecContext, 'limitOverride'>]: CommandOpts[K] }
    const parity: Shared = {} as ExecContext
    expect(parity).toBeDefined()
  })
})
