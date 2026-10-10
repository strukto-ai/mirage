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
import { generic } from '../../commands/builtin/generic_bind/factory.ts'
import { mountPrefixOf } from '../../utils/key_prefix.ts'
import { describe, expect, it } from 'vitest'
import {
  command,
  type CommandFn,
  type CommandOpts,
  type ExecContext,
} from '../../commands/config.ts'
import { CommandSpec, Argument } from '../../commands/spec/types.ts'
import { IOResult, materialize } from '../../io/types.ts'
import type { RAMAccessor } from '../../accessor/ram.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { revisionFor } from '../../observe/context.ts'
import { BaseVFS } from '../../vfs/base.ts'
import { FileStat, FileType, Limit, MountMode, PathSpec } from '../../types.ts'
import { getTestParser } from '../fixtures/workspace_fixture.ts'
import { Workspace } from '../workspace/workspace.ts'
import { MountEntry } from './mount.ts'

class StubVFS extends BaseVFS {
  override readonly name = 'ram'
  override close(): Promise<void> {
    return Promise.resolve()
  }
}

const BASIC_SPEC = new CommandSpec({
  arguments: [new Argument('paths', { metavar: '', type: 'path', nargs: '*' })],
})

const OK_CMD: CommandFn = () => [null, new IOResult({ exitCode: 0 })]
const OK_CMD_STDOUT: CommandFn = () => [new TextEncoder().encode('ok'), new IOResult()]
const HANG_CMD: CommandFn = () => new Promise(() => undefined)

function makeMount(mode: MountMode = MountMode.WRITE, vfs: BaseVFS = new StubVFS()): MountEntry {
  return new MountEntry({ prefix: '/ram/', vfs, mode })
}

describe('Mount constructor validation', () => {
  it('requires prefix to start with /', () => {
    expect(() => new MountEntry({ prefix: 'ram/', vfs: new StubVFS() })).toThrow(/start with/)
  })

  it('requires prefix to end with /', () => {
    expect(() => new MountEntry({ prefix: '/ram', vfs: new StubVFS() })).toThrow(/end with/)
  })

  it('rejects double-slash prefixes', () => {
    expect(() => new MountEntry({ prefix: '//ram/', vfs: new StubVFS() })).toThrow(/\/\//)
  })

  it('defaults mode to READ', () => {
    const m = new MountEntry({ prefix: '/ram/', vfs: new StubVFS() })
    expect(m.mode).toBe(MountMode.READ)
  })

  it('rejects a renderer that names no method', () => {
    class MisnamedRenderer extends StubVFS {
      override readonly renderers: Readonly<Record<string, string>> = { '.doc': 'renderDoc' }
    }
    expect(() => new MountEntry({ prefix: '/ram/', vfs: new MisnamedRenderer() })).toThrow(
      "'renderDoc', which is not a method",
    )
  })
})

describe('Mount.resolveCommand fallback chain', () => {
  it('prefers filetype-specific over VFS-specific', () => {
    const m = makeMount()
    const [generic] = command({ name: 'cat', vfs: 'ram', spec: BASIC_SPEC, fn: OK_CMD })
    const [json] = command({
      name: 'cat',
      vfs: 'ram',
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

  it('falls back to general when no VFS-specific match', () => {
    const m = makeMount()
    const [echo] = command({ name: 'echo', vfs: null, spec: BASIC_SPEC, fn: OK_CMD })
    if (echo === undefined) throw new Error('missing')
    m.registerGeneral(echo)
    expect(m.resolveCommand('echo')).toBe(echo)
  })

  it('returns null when nothing matches', () => {
    const m = makeMount()
    expect(m.resolveCommand('nope')).toBeNull()
  })
})

describe('Mount.runCommand glob operands', () => {
  // The dispatcher hands a pattern to the handler whole. Resolving is the
  // handler's job, done once through the shared adapter, which is where
  // the namespace facts (links, nested mount roots, a trailing slash) are
  // in view; the mount's own glob cannot see them, so expanding here
  // would destroy what the handler needs. Python's dispatcher never
  // expands either.
  class GlobbingVFS extends StubVFS {
    override readdir(): Promise<string[]> {
      return Promise.resolve(['/ram/a.txt'])
    }
  }
  const pattern = new PathSpec({
    virtual: '/ram/*.txt',
    directory: '/ram/',
    vfsPath: '*.txt',
    pattern: '*.txt',
    resolved: false,
    rawPath: '*.txt',
  })

  it('hands the pattern to the handler rather than expanding it', async () => {
    const vfs = new GlobbingVFS()
    const m = new MountEntry({ prefix: '/ram/', vfs, mode: MountMode.WRITE })
    let got: string[] = []
    const [cmd] = command({
      name: 'cat',
      vfs: 'ram',
      spec: BASIC_SPEC,
      fn: (_a, paths) => {
        got = paths.map((p) => p.virtual)
        return [null, new IOResult({ exitCode: 0 })]
      },
    })
    if (cmd === undefined) throw new Error('missing')
    m.register(cmd)
    await m.runCommand('cat', [pattern], [], {})
    expect(got).toEqual(['/ram/*.txt'])
  })
})

describe('Mount.specFor', () => {
  it('returns the registered spec', () => {
    const m = makeMount()
    const [cmd] = command({ name: 'cat', vfs: 'ram', spec: BASIC_SPEC, fn: OK_CMD })
    if (cmd === undefined) throw new Error('missing')
    m.register(cmd)
    expect(m.specFor('cat')).toBe(cmd.spec)
  })

  it('returns null for unknown commands', () => {
    expect(makeMount().specFor('nope')).toBeNull()
  })
})

describe('Mount.runCommand', () => {
  it.each([
    [MountMode.READ, false, 'version'],
    [MountMode.READ, true, 'version'],
    [MountMode.WRITE, false, 'version'],
    [MountMode.WRITE, true, 'version'],
    [MountMode.READ, false, 'help'],
    [MountMode.READ, true, 'help'],
    [MountMode.WRITE, false, 'help'],
    [MountMode.WRITE, true, 'help'],
  ] as const)(
    'only wrapper responses bypass the write guard: %s declared=%s %s',
    async (mode, declared, flag) => {
      const vfs = new RAMVFS()
      const m = new MountEntry({ prefix: '/ram/', vfs, mode })
      const calls: string[] = []
      const [cmd] = command<RAMAccessor>({
        name: 'mutate',
        vfs: 'ram',
        spec: new CommandSpec({
          arguments: [...(declared ? [new Argument('--version', { action: 'store_true' })] : [])],
        }),
        write: true,
        fn: (accessor) => {
          calls.push('handler')
          accessor.store.files.set('/changed', new TextEncoder().encode('changed'))
          return [new TextEncoder().encode('custom version\n'), new IOResult()]
        },
      })
      if (cmd === undefined) throw new Error('missing command')
      m.register(cmd)
      const [stdout, io] = await m.runCommand('mutate', [], [], { [flag]: true })
      const output = new TextDecoder().decode(await materialize(stdout))
      if (declared && flag === 'version') {
        if (mode === MountMode.READ) {
          expect(io.exitCode).toBe(1)
          expect(new TextDecoder().decode(io.stderr as Uint8Array)).toBe(
            'mutate: read-only mount at /ram/\n',
          )
          expect(calls).toEqual([])
          expect(vfs.store.files.has('/changed')).toBe(false)
        } else {
          expect(io.exitCode).toBe(0)
          expect(output).toBe('custom version\n')
          expect(calls).toEqual(['handler'])
          expect(new TextDecoder().decode(vfs.store.files.get('/changed'))).toBe('changed')
        }
      } else {
        expect(io.exitCode).toBe(0)
        expect(output).not.toBe('')
        expect(calls).toEqual([])
        expect(vfs.store.files.has('/changed')).toBe(false)
      }
    },
  )

  it('refuses the writes of a run with no dispatcher', async () => {
    // The dispatcher is where a write is judged and settled, so a host
    // running a command straight on its mount, with none, cannot write.
    const vfs = new RAMVFS()
    const m = new MountEntry({ prefix: '/rw/', vfs, mode: MountMode.WRITE })
    m.register(generic('tee'))
    const [stdout, io] = await m.runCommand(
      'tee',
      [PathSpec.fromStrPath('/rw/f')],
      [],
      {},
      {
        stdin: new TextEncoder().encode('x'),
      },
    )
    await materialize(stdout)
    expect(io.exitCode).toBe(1)
    expect(new TextDecoder().decode(await io.materializeStderr())).toContain(
      'Operation not supported',
    )
    expect(vfs.store.files.has('/f')).toBe(false)
  })

  it('returns 127 for unknown command', async () => {
    const m = makeMount()
    const [, io] = await m.runCommand('nope', [], [], {})
    expect(io.exitCode).toBe(127)
    expect(new TextDecoder().decode(io.stderr as Uint8Array)).toMatch(/command not found/)
  })

  it('dispatches to a registered command and returns its IOResult', async () => {
    const m = makeMount()
    const [cmd] = command({
      name: 'cat',
      vfs: 'ram',
      spec: BASIC_SPEC,
      fn: OK_CMD_STDOUT,
    })
    if (cmd === undefined) throw new Error('missing')
    m.register(cmd)
    const [stdout, io] = await m.runCommand('cat', [PathSpec.fromStrPath('/x.txt')], [], {})
    expect(io.exitCode).toBe(0)
    expect(await materialize(stdout)).toEqual(new TextEncoder().encode('ok'))
  })

  it('rejects write commands on a READ mount', async () => {
    const m = makeMount(MountMode.READ)
    const [wcmd] = command({
      name: 'rm',
      vfs: 'ram',
      spec: BASIC_SPEC,
      fn: OK_CMD,
      write: true,
    })
    if (wcmd === undefined) throw new Error('missing')
    m.register(wcmd)
    const [, io] = await m.runCommand('rm', [PathSpec.fromStrPath('/x')], [], {})
    expect(io.exitCode).toBe(1)
    expect(new TextDecoder().decode(io.stderr as Uint8Array)).toMatch(/read-only/)
  })

  it('terminates the read-only refusal with a newline', async () => {
    // stderr accumulates across a line, so an unterminated refusal ran
    // into the next one: `{ rm /ro/a; rm /ro/b; }` printed the single
    // line `rm: read-only mount at /ro/rm: read-only mount at /ro/`.
    const m = makeMount(MountMode.READ)
    const [wcmd] = command({
      name: 'rm',
      vfs: 'ram',
      spec: BASIC_SPEC,
      fn: OK_CMD,
      write: true,
    })
    if (wcmd === undefined) throw new Error('missing')
    m.register(wcmd)
    const [, io] = await m.runCommand('rm', [PathSpec.fromStrPath('/x')], [], {})
    expect(new TextDecoder().decode(io.stderr as Uint8Array)).toBe(
      `rm: read-only mount at ${m.prefix}\n`,
    )
  })

  it.each([
    [MountMode.READ, false],
    [MountMode.READ, true],
    [MountMode.WRITE, false],
    [MountMode.WRITE, true],
  ])(
    'refuses up front only a write command the dispatcher cannot see (%s, path guarded %s)',
    async (mode, pathGuarded) => {
      // A path-guarded command's writes go through the guarded op slots,
      // which refuse each one where it happens, so a read-only mount runs
      // it like a reader (`gzip -c`, `split -n 1/2`). A write command
      // that reaches its service some other way has no gate to refuse
      // it, so the mount refuses it before it runs.
      const m = makeMount(mode)
      const calls: number[] = []
      const [cmd] = command({
        name: 'filter',
        vfs: 'ram',
        spec: BASIC_SPEC,
        write: true,
        pathGuarded,
        fn: (_accessor, paths) => {
          calls.push(paths.length)
          return [new TextEncoder().encode('ran\n'), new IOResult()]
        },
      })
      if (cmd === undefined) throw new Error('missing')
      m.register(cmd)
      const [stdout, io] = await m.runCommand('filter', [PathSpec.fromStrPath('/a')], [], {})
      if (mode === MountMode.READ && !pathGuarded) {
        expect(io.exitCode).toBe(1)
        expect(new TextDecoder().decode(io.stderr as Uint8Array)).toBe(
          `filter: read-only mount at ${m.prefix}\n`,
        )
        expect(calls).toEqual([])
      } else {
        expect(io.exitCode).toBe(0)
        expect(new TextDecoder().decode(await materialize(stdout))).toBe('ran\n')
        expect(calls).toEqual([1])
      }
    },
  )

  it('passes the mount prefix through PathSpecs given to the command', async () => {
    const m = makeMount()
    let seenPrefix: string | null = null
    const fn: CommandFn = (_accessor, paths) => {
      seenPrefix =
        (paths[0] === undefined ? undefined : mountPrefixOf(paths[0].virtual, paths[0].vfsPath)) ??
        null
      return [null, new IOResult()]
    }
    const [cmd] = command({ name: 'cat', vfs: 'ram', spec: BASIC_SPEC, fn })
    if (cmd === undefined) throw new Error('missing')
    m.register(cmd)
    await m.runCommand('cat', [PathSpec.fromStrPath('/ram/hello.txt')], [], {})
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
    const [plain] = command({ name: 'cat', vfs: 'ram', spec: BASIC_SPEC, fn: builtin })
    const [typed] = command({
      name: 'cat',
      vfs: 'ram',
      spec: BASIC_SPEC,
      fn: renderer,
      filetype: '.tally',
    })
    if (plain === undefined || typed === undefined) throw new Error('missing')
    m.register(plain)
    m.register(typed)
    const statPath = (p: string | PathSpec): Promise<FileStat | null> =>
      Promise.resolve(
        (typeof p === 'string' ? p : p.virtual).endsWith('dir.tally')
          ? new FileStat({ name: typeof p === 'string' ? p : p.virtual, type: FileType.DIRECTORY })
          : new FileStat({
              name: typeof p === 'string' ? p : p.virtual,
              type: FileType.FILE,
              size: 4,
            }),
      )

    await m.runCommand('cat', [PathSpec.fromStrPath('/dir.tally')], [], {}, { statPath })
    expect(fired).toEqual([])
    expect(builtins).toEqual(['/dir.tally'])

    await m.runCommand('cat', [PathSpec.fromStrPath('/file.tally')], [], {}, { statPath })
    expect(fired).toEqual(['/file.tally'])
  })

  it('a null limitOverride does not shadow the mount own table', async () => {
    // A caller with no profile, mount or workspace entry passes null,
    // which must fall through to the serving mount's command_limits.
    const m = makeMount()
    m.commandLimits.set('cat', new Limit({ timeoutSeconds: 0.05 }))
    const [cmd] = command({ name: 'cat', vfs: 'ram', spec: BASIC_SPEC, fn: HANG_CMD })
    if (cmd === undefined) throw new Error('missing')
    m.register(cmd)
    await expect(
      m.runCommand('cat', [PathSpec.fromStrPath('/x.txt')], [], {}, { limitOverride: null }),
    ).rejects.toThrow(/cat: timed out after 0.05s/)
  })
})

describe('Mount.call', () => {
  it('dispatches to the VFS function', async () => {
    class Reading extends StubVFS {
      override read(path: PathSpec): Promise<Uint8Array> {
        return Promise.resolve(new TextEncoder().encode(path.virtual))
      }
    }
    const m = makeMount(MountMode.WRITE, new Reading())
    const result = await m.call('read', '/x.txt')
    expect(result).toBeInstanceOf(Uint8Array)
  })

  it('throws on unknown op', async () => {
    const m = makeMount()
    await expect(m.call('nope', '/x')).rejects.toThrow(/no op/)
  })
})

describe('Mount.revisions', () => {
  it('starts empty and exposes the revisions map directly', () => {
    const m = makeMount()
    expect(m.revisions.size).toBe(0)
  })

  it('exposes installed pins to read functions via revisionFor during call', async () => {
    let observed: string | null = '<unset>'
    class Pinned extends StubVFS {
      override read(path: PathSpec): Promise<Uint8Array> {
        observed = revisionFor(path.virtual)
        return Promise.resolve(new Uint8Array())
      }
    }
    const m = makeMount(MountMode.WRITE, new Pinned())
    m.revisions.set('/ram/x.txt', 'rev-1')
    await m.call('read', '/ram/x.txt')
    expect(observed).toBe('rev-1')
  })

  it('does not leak revisions outside the call scope', async () => {
    class Empty extends StubVFS {
      override read(): Promise<Uint8Array> {
        return Promise.resolve(new Uint8Array())
      }
    }
    const m = makeMount(MountMode.WRITE, new Empty())
    m.revisions.set('/ram/x.txt', 'rev-1')
    await m.call('read', '/ram/x.txt')
    expect(revisionFor('/ram/x.txt')).toBeNull()
  })
})

describe('ExecContext parity with CommandOpts', () => {
  it('every line fact is spelled as CommandOpts spells it', () => {
    // runCommand re-boxes the bag onto CommandOpts, so a fact spelled
    // two ways across that seam is two vocabularies for one plane.
    // Checked at compile time because a TS interface has no fields to
    // enumerate at runtime. `limitOverride` is the one execution
    // control runCommand consumes itself rather than forwards, so it
    // is the one exemption. The Python twin is
    // tests/commands/test_exec_context_parity.py.
    type Shared = { [K in keyof Omit<ExecContext, 'limitOverride'>]: CommandOpts[K] }
    const parity: Shared = {} as ExecContext
    expect(parity).toBeDefined()
  })
})

it('a path-guarded command is still held at its write', async () => {
  const vfs = new RAMVFS()
  vfs.store.files.set('/a', new TextEncoder().encode('original'))
  expect(generic('gzip').pathGuarded).toBe(true)
  const ws = new Workspace(
    { '/ram/': [vfs, MountMode.READ] },
    { mode: MountMode.WRITE, shellParserFactory: () => getTestParser() },
  )
  try {
    // The write is refused where it happens and gzip says so in its own
    // words (the fatal write_error form), leaving the store untouched.
    const io = await ws.shell('gzip /ram/a')
    expect([io.exitCode, new TextDecoder().decode(io.stderr)]).toEqual([
      1,
      '\ngzip: /ram/a.gz: Read-only file system\n',
    ])
    expect([...vfs.store.files.entries()]).toEqual([['/a', new TextEncoder().encode('original')]])
  } finally {
    await ws.close()
  }
})

it.each([false, true])(
  'closes native output and releases mount admission (started=%s)',
  async (started) => {
    let closed = false
    const [cmd] = command({
      name: 'writer',
      vfs: 'ram',
      spec: new CommandSpec(),
      fn: () => [
        new HeldSource(new TextEncoder().encode('prefix'), () => {
          closed = true
        }),
        new IOResult(),
      ],
    })
    if (cmd === undefined) throw new Error('missing command')
    const mount = makeMount()
    mount.register(cmd)
    const [output] = await mount.runCommand('writer', [], [], {})
    const iterator = output as AsyncIterableIterator<Uint8Array>
    if (started) expect((await iterator.next()).value).toEqual(new TextEncoder().encode('prefix'))
    await iterator.return?.()
    expect(closed).toBe(true)
    await mount.activity.wait()
  },
)

/** Yields its bytes once, then waits until it is closed, once. */
class HeldSource implements AsyncIterableIterator<Uint8Array> {
  private sent = false
  private closed = false
  private release: (() => void) | null = null

  constructor(
    private readonly data: Uint8Array,
    private readonly onClose: () => void,
  ) {}

  [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
    return this
  }

  async next(): Promise<IteratorResult<Uint8Array>> {
    if (!this.sent) {
      this.sent = true
      return { done: false, value: this.data }
    }
    if (!this.closed) {
      await new Promise<void>((resolve) => {
        this.release = resolve
      })
    }
    return { done: true, value: undefined }
  }

  return(): Promise<IteratorResult<Uint8Array>> {
    if (!this.closed) {
      this.closed = true
      this.onClose()
    }
    this.release?.()
    return Promise.resolve({ done: true, value: undefined })
  }
}
