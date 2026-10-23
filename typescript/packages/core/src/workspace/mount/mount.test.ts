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
import { Command, command, type CommandFn } from '../../commands/config.ts'
import { CommandSpec, Argument } from '../../commands/spec/types.ts'
import { IOResult, materialize, type ByteSource } from '../../io/types.ts'
import type { RAMAccessor } from '../../accessor/ram.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import {
  commandRecords,
  recordStream,
  revisionFor,
  runWithRecording,
} from '../../observe/context.ts'
import { readVersioned } from '../../cache/context.ts'
import type { Handed } from '../../vfs/types.ts'
import { BaseVFS } from '../../vfs/base.ts'
import { FileStat, FileType, Limit, MountMode, PathSpec } from '../../types.ts'
import { getTestParser } from '../../../tests/workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../workspace/workspace.ts'
import { MountEntry } from './mount.ts'
import type { DispatchFn } from '../../runtime/types.ts'
import { Files } from '../files.ts'

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

  // A method folded into read, write or append would never be called, so a
  // VFS that still has one, on its prototype or as a field, is refused as it
  // is mounted.
  it.each(['readStream', 'writeStream', 'appendStream'])(
    'rejects a VFS that defines %s',
    (name) => {
      class Old extends StubVFS {}
      Object.defineProperty(Old.prototype, name, { value: () => undefined })
      expect(() => new MountEntry({ prefix: '/ram/', vfs: new Old() })).toThrow(
        `Old.${name}: define `,
      )
    },
  )

  it('rejects a VFS that sets a folded method as a field', () => {
    class Fielded extends StubVFS {
      writeStream = (): Promise<void> => Promise.resolve()
    }
    expect(() => new MountEntry({ prefix: '/ram/', vfs: new Fielded() })).toThrow(
      'Fielded.writeStream: define write',
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

  it('keeps the shared command for other files when a filetype command is added', () => {
    const m = makeMount()
    const shared = generic('cat')
    m.registerGeneral(shared)
    const [csv] = command({
      name: 'cat',
      vfs: null,
      spec: BASIC_SPEC,
      fn: OK_CMD,
      filetype: '.csv',
    })
    if (csv === undefined) throw new Error('missing')
    m.registerCommands([csv])
    expect(m.resolveCommand('cat', '.csv')).toBe(csv)
    expect(m.resolveCommand('cat', '.txt')).toBe(shared)
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
    override readdir(): Promise<FileStat[]> {
      return Promise.resolve([new FileStat({ name: 'a.txt', type: FileType.FILE })])
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
          arguments: [...(declared ? [new Argument(`--${flag}`, { action: 'store_true' })] : [])],
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
      // A declared --help is still answered by the command's wrapper, but
      // the guard reads only the spec, so a read-only mount refuses it.
      if (declared && mode === MountMode.READ) {
        expect(io.exitCode).toBe(1)
        expect(new TextDecoder().decode(io.stderr as Uint8Array)).toBe(
          'mutate: read-only mount at /ram/\n',
        )
        expect(calls).toEqual([])
        expect(vfs.store.files.has('/changed')).toBe(false)
      } else if (declared && flag === 'version') {
        expect(io.exitCode).toBe(0)
        expect(output).toBe('custom version\n')
        expect(calls).toEqual(['handler'])
        expect(new TextDecoder().decode(vfs.store.files.get('/changed'))).toBe('changed')
      } else {
        expect(io.exitCode).toBe(0)
        expect(output).not.toBe('')
        expect(calls).toEqual([])
        expect(vfs.store.files.has('/changed')).toBe(false)
      }
    },
  )

  it('refuses a generic run with no workspace files', async () => {
    // A generic reaches files only through its line's own; run bare, none.
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
    expect(new TextDecoder().decode(await io.materializeStderr())).toBe('tee: no workspace files\n')
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
    'refuses up front only a write command the dispatcher cannot see (%s, builtin %s)',
    async (mode, builtin) => {
      // The dispatcher refuses a builtin's writes, not a user command's.
      const m = makeMount(mode)
      const calls: number[] = []
      const [cmd] = command({
        name: 'filter',
        vfs: 'ram',
        spec: BASIC_SPEC,
        write: true,
        fn: (_accessor, paths) => {
          calls.push(paths.length)
          return [new TextEncoder().encode('ran\n'), new IOResult()]
        },
      })
      if (cmd === undefined) throw new Error('missing')
      if (builtin) m.registerBuiltinCommands([cmd])
      else m.register(cmd)
      const [stdout, io] = await m.runCommand('filter', [PathSpec.fromStrPath('/a')], [], {})
      if (mode === MountMode.READ && !builtin) {
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
    const dispatch: DispatchFn = (name, p) => {
      expect(name).toBe('stat')
      return Promise.resolve([
        p.virtual.endsWith('dir.tally')
          ? new FileStat({ name: p.virtual, type: FileType.DIRECTORY })
          : new FileStat({ name: p.virtual, type: FileType.FILE, size: 4 }),
        new IOResult(),
      ])
    }
    const vfs = new Files(dispatch, null, null, { ledger: false })

    await m.runCommand('cat', [PathSpec.fromStrPath('/dir.tally')], [], {}, { vfs })
    expect(fired).toEqual([])
    expect(builtins).toEqual(['/dir.tally'])

    await m.runCommand('cat', [PathSpec.fromStrPath('/file.tally')], [], {}, { vfs })
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
      m.runCommand('cat', [PathSpec.fromStrPath('/x.txt')], [], {}, {}, null),
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

it('a builtin command is still held at its write', async () => {
  const vfs = new RAMVFS()
  vfs.store.files.set('/a', new TextEncoder().encode('original'))
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

it('runs a command registered for one filetype only on that filetype', async () => {
  const ws = new Workspace(
    { '/ram/': new RAMVFS() },
    { mode: MountMode.WRITE, shellParserFactory: () => getTestParser() },
  )
  try {
    await ws.shell('echo hit > /ram/x.csv; echo hit > /ram/x.txt')
    ws.mount('/ram/').registerCommands(
      command({
        name: 'summarize',
        vfs: null,
        spec: BASIC_SPEC,
        fn: OK_CMD_STDOUT,
        filetype: '.csv',
      }),
    )
    const csv = await ws.shell('summarize /ram/x.csv')
    const txt = await ws.shell('summarize /ram/x.txt')
    expect([csv.exitCode, csv.stdoutText]).toEqual([0, 'ok'])
    expect([txt.exitCode, txt.stderrText]).toEqual([127, 'summarize: command not found'])
  } finally {
    await ws.close()
  }
})

// The per-program refusal voices and codes (grep's 2, diff's prefixed hint,
// CPython's and curl's wording, tar's old-option 2) describe the real
// program, so a command a mount registers under its name is refused like the
// control `mycmd`.
it.each(['grep', 'diff', 'python3', 'curl', 'tar', 'mycmd'])(
  'refuses a borrowed %s like a custom command',
  async (name) => {
    const ws = new Workspace(
      { '/data/': new RAMVFS() },
      { mode: MountMode.WRITE, shellParserFactory: () => getTestParser() },
    )
    try {
      const spec = new CommandSpec({
        arguments: [
          new Argument('-k'),
          new Argument('--quiet', { action: 'store_true' }),
          new Argument('--max', { type: 'float' }),
          new Argument('rest', { nargs: '*' }),
        ],
        oldOptionStyle: true,
      })
      ws.mount('/data/').register(new Command({ name, spec, vfs: null, fn: OK_CMD_STDOUT }))
      const ok = await ws.shell(`cd /data && ${name} -k a x`)
      expect([ok.exitCode, ok.stdoutText]).toEqual([0, 'ok'])
      for (const [words, line] of [
        ['--bogus x', "unrecognized option '--bogus'"],
        ['-k', "option requires an argument -- 'k'"],
        ['--quiet=x', "option '--quiet' doesn't allow an argument"],
        ['--max=z', "invalid float value: 'z' for '--max'"],
        ['k', "Old option 'k' requires an argument."],
      ] as const) {
        const refused = await ws.shell(`cd /data && ${name} ${words}`)
        expect([words, refused.exitCode, refused.stderrText]).toEqual([
          words,
          1,
          `${name}: ${line}\nTry '${name} --help' for more information.\n`,
        ])
      }
    } finally {
      await ws.close()
    }
  },
)

const ECHO_CMD: CommandFn = (_accessor, paths, texts) => [
  new TextEncoder().encode(JSON.stringify([paths.map((p) => p.virtual), texts])),
  new IOResult(),
]

// The steps that read a line with the builtin's grammar before routing
// (find's expression, the implied `.`, the program file, a path flag's mount,
// the help page) belong to the builtin, so a command a mount registers under
// its name runs as the control `mycmd` does.
it.each(['find --mode=a x', 'rg x', 'grep -f a x', 'sort -o /b/out x', 'grep --help'])(
  'routes a borrowed `%s` like a custom command',
  async (line) => {
    const ws = new Workspace(
      { '/a/': new RAMVFS(), '/b/': new RAMVFS() },
      { mode: MountMode.WRITE, shellParserFactory: () => getTestParser() },
    )
    try {
      const [name = '', ...words] = line.split(' ')
      const spec = new CommandSpec({
        arguments: [
          new Argument('--mode'),
          new Argument('-f'),
          new Argument('-o'),
          new Argument('rest', { nargs: '*' }),
        ],
      })
      for (const registered of [name, 'mycmd']) {
        ws.mount('/a/').register(new Command({ name: registered, spec, vfs: null, fn: ECHO_CMD }))
      }
      const borrowed = await ws.shell(`cd /a && ${line}`)
      const control = await ws.shell(`cd /a && mycmd ${words.join(' ')}`)
      expect([borrowed.exitCode, borrowed.stdoutText, borrowed.stderrText]).toEqual([
        control.exitCode,
        control.stdoutText,
        control.stderrText.replaceAll('mycmd', name),
      ])
    } finally {
      await ws.close()
    }
  },
)

// The mount a line runs on is picked by the words in operand slots that were
// classified as paths, read by position: never a file an option reads, even
// one an operand repeats, nor a word the cwd's spec left as text. /a borrows
// grep (text operands), find and rg (path operands); the builtin rg reads
// `/a/patterns` and a lone `/b/input` as its pattern, a text slot, so those
// lines run on /a, where a path on /b is refused rather than handed to /a's rg.
// Only the paths the borrowed spec reads count, its option values included:
// grep's `-f` takes text, so `/b/input` there is no path, and rg's takes a
// path.
const SPAN = 'rg: paths span multiple mounts (/a/, /b/), cross-mount not supported\n'
it.each([
  ['cd /b && grep -f /a/patterns /b/input', 0, 'hi\n', ''],
  ['cd /b && grep -f /a/patterns /b/input /a/patterns', 0, '/b/input:hi\n[["/a/patterns"],[]]', ''],
  ['cd /a && grep hi /b/input', 0, '[[],["hi","/b/input"]]', ''],
  ['cd /b && grep -f /b/input /a/x', 0, '[[],["/a/x"]]', ''],
  ['cd /a && rg /a/patterns /b/input', 0, '/a/patterns\n', ''],
  ['cd /a && rg /b/input', 1, '', SPAN],
  ['cd /a && rg /b/input /a/patterns', 1, '', SPAN],
  ['cd /a && rg -f /b/input /a/patterns', 1, '', SPAN],
  ['cd /a && find //b/input -print0', 0, '//b/input\0', ''],
])('keeps `%s` on its own command', async (line, code, stdout, stderr) => {
  const ws = new Workspace(
    { '/a/': new RAMVFS(), '/b/': new RAMVFS() },
    { mode: MountMode.WRITE, shellParserFactory: () => getTestParser() },
  )
  try {
    for (const [name, type] of [
      ['grep', 'str'],
      ['find', 'path'],
      ['rg', 'path'],
    ] as const) {
      ws.mount('/a/').register(
        new Command({
          name,
          spec: new CommandSpec({
            arguments: [new Argument('-f', { type }), new Argument('rest', { nargs: '*', type })],
          }),
          vfs: null,
          fn: ECHO_CMD,
        }),
      )
    }
    await ws.shell("echo hi > /a/patterns; printf 'hi\\n/a/patterns\\n' > /b/input")
    const result = await ws.shell(line)
    expect([result.exitCode, result.stdoutText, result.stderrText]).toEqual([code, stdout, stderr])
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

// A follow whose stream holds something open before it is pulled.
class EagerFollow extends RAMVFS {
  closed = 0

  override follow(): Promise<AsyncIterable<Uint8Array> | null> {
    return Promise.resolve({
      next: () => Promise.resolve({ value: new TextEncoder().encode('x\n'), done: false }),
      return: () => {
        this.closed += 1
        return Promise.resolve({ value: undefined, done: true })
      },
      [Symbol.asyncIterator]() {
        return this
      },
    } as AsyncIterableIterator<Uint8Array>)
  }
}

describe('MountEntry streamed op results', () => {
  it('closes the source of a stream closed before its first pull', async () => {
    const vfs = new EagerFollow()
    const mount = new MountEntry({ prefix: '/', vfs, mode: MountMode.WRITE })
    const stream = (await mount.call(
      'follow',
      '/a.txt',
      [1, 1],
    )) as AsyncIterableIterator<Uint8Array>
    await stream.return?.()
    expect(vfs.closed).toBeGreaterThanOrEqual(1)
  })
})

const [HANDED_CAT] = command<RAMAccessor>({
  name: 'cat',
  vfs: 'ram',
  spec: new CommandSpec({ arguments: [new Argument('path', { type: 'path' })] }),
  fn: () => [new TextEncoder().encode('handed\n'), new IOResult()],
})

const [HANDED_PEEK] = command<RAMAccessor>({
  name: 'peek',
  vfs: 'ram',
  spec: new CommandSpec({ arguments: [new Argument('path', { type: 'path' })] }),
  fn: async (_accessor, paths, _texts, ctx) => {
    const [path] = paths
    if (ctx.vfs === undefined || path === undefined) throw new Error('peek reads one path')
    return [await ctx.vfs.read(path), new IOResult()]
  },
})

class HandedRAM extends RAMVFS {
  override commands(): readonly Command[] {
    return [HANDED_CAT, HANDED_PEEK].filter((cmd) => cmd !== undefined)
  }
}

describe('handed commands under restrictions', () => {
  // Mirage cannot see what a handler reads through its own accessor, so it
  // does not try: a hide covers what the handler reads through ctx.vfs.
  it('run where the session restricts their mount', async () => {
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/data/': new HandedRAM(), '/other/': new RAMVFS() },
      { mode: MountMode.WRITE, shellParser: parser },
    )
    try {
      await ws.shell('echo hi > /data/n.txt; echo s > /data/secret')
      ws.createSession('here', { profile: { paths: { hide: ['/data/secret'] } } })
      ws.createSession('elsewhere', { profile: { paths: { hide: ['/other/x'] } } })
      for (const [sid, line, out, err, code] of [
        [undefined, 'cat /data/n.txt', 'handed\n', '', 0],
        ['here', 'cat /data/n.txt', 'handed\n', '', 0],
        ['here', 'peek /data/n.txt', 'hi\n', '', 0],
        ['elsewhere', 'peek /data/secret', 's\n', '', 0],
        ['here', 'peek /data/secret', '', 'peek: /data/secret: No such file or directory\n', 1],
      ] as const) {
        const io = await ws.shell(line, sid === undefined ? {} : { sessionId: sid })
        const dec = new TextDecoder()
        expect(
          [dec.decode(io.stdout), dec.decode(io.stderr), io.exitCode],
          `${String(sid)} ${line}`,
        ).toEqual([out, err, code])
      }
    } finally {
      await ws.close()
    }
  })
})

describe('a user write past the dispatcher', () => {
  const ENC = new TextEncoder()
  function stamp(throws: boolean): CommandFn {
    return (accessor) => {
      ;(accessor as RAMAccessor).store.files.set('/a.txt', ENC.encode('v2\n'))
      if (throws) throw new Error('half done')
      return [null, new IOResult()]
    }
  }

  // A handler that throws as it is called, before it returns a promise, is
  // still the runner's to drop the caches after.
  it.each([
    [true, false, 0, 'v2\n'],
    [false, false, 0, 'v1\n'],
    [true, true, 1, 'v2\n'],
  ])(
    "drops only its own mount's caches (write %s, throws %s)",
    async (write, throws, code, own) => {
      const one = new RAMVFS()
      const two = new RAMVFS()
      for (const [vfs, key] of [
        [one, '/a.txt'],
        [two, '/b.txt'],
      ] as const) {
        ;(vfs as unknown as { cachesReads: boolean }).cachesReads = true
        vfs.store.files.set(key, ENC.encode('v1\n'))
      }
      const ws = new Workspace(
        { '/one/': one, '/two/': two },
        { mode: MountMode.WRITE, shellParserFactory: () => getTestParser() },
      )
      try {
        ws.mount('/one/').registerCommands([
          new Command({
            name: 'stamp',
            spec: new CommandSpec(),
            vfs: null,
            write,
            fn: stamp(throws),
          }),
        ])
        await ws.shell('cat /one/a.txt /two/b.txt')
        two.store.files.set('/b.txt', ENC.encode('v2\n'))
        expect((await ws.shell('cd /one && stamp')).exitCode).toBe(code)
        expect((await ws.shell('cat /one/a.txt')).stdoutText).toBe(own)
        expect((await ws.shell('cat /two/b.txt')).stdoutText).toBe('v1\n')
      } finally {
        await ws.close()
      }
    },
  )
})

async function* versioned(data: Uint8Array, path: PathSpec): AsyncIterable<Uint8Array> {
  const rec = recordStream('read', path.virtual, 'ram')
  if (rec !== null) rec.fingerprint = 'v1'
  yield await Promise.resolve(data)
}

/** Answers a whole read with a stream that records its version. */
class VersionedStream extends RAMVFS {
  override async read(
    path: PathSpec,
    handed?: Handed,
    offset = 0,
    size: number | null = null,
  ): Promise<ByteSource> {
    const data = await materialize(await super.read(path, handed, offset, size))
    return offset === 0 && size === null ? versioned(data, path) : data
  }
}

// A read-modify-write sends the version of the bytes it read, so a whole
// read collected from a stream carries the version the stream recorded.
it('a collected stream hands its version to the bytes', async () => {
  const vfs = new VersionedStream()
  vfs.store.files.set('/f', new TextEncoder().encode('old'))
  const ws = new Workspace({ '/m': vfs }, { mode: MountMode.WRITE })
  try {
    const mount = ws.mount('/m')
    const [data, version] = await readVersioned(PathSpec.fromStrPath('/m/f'), () =>
      mount.call('read', '/m/f'),
    )
    expect([new TextDecoder().decode(data as Uint8Array), version]).toEqual(['old', 'v1'])
  } finally {
    await ws.close()
  }
})

// A rewrite's write proves the copy it extends by the read before it, so a
// read collected from a stream leaves its record in the block around it.
it('a collected read stays in the records around it', async () => {
  const vfs = new VersionedStream()
  vfs.store.files.set('/f', new TextEncoder().encode('old'))
  const ws = new Workspace({ '/m': vfs }, { mode: MountMode.WRITE })
  try {
    const [mine] = await runWithRecording(() =>
      commandRecords(async (records) => {
        await ws.mount('/m').call('read', '/m/f')
        return records
      }),
    )
    expect(mine.map((r) => [r.op, r.fingerprint])).toContainEqual(['read', 'v1'])
  } finally {
    await ws.close()
  }
})
