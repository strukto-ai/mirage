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

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RAMAccessor } from '../accessor/ram.ts'
import { GENERAL_COMMANDS } from '../commands/builtin/general/index.ts'
import { strategyFor } from '../commands/builtin/generic/crossmount/detect.ts'
import { Strategy } from '../commands/builtin/generic/crossmount/types.ts'
import { GENERIC_COMMANDS, generic } from '../commands/builtin/generic_bind/factory.ts'
import { CLI, CLIHandler } from '../commands/cli/types.ts'
import { type CommandFn, type CommandFnResult, type Context, command } from '../commands/config.ts'
import { FlagView } from '../commands/spec/flag_view.ts'
import { Argument, CommandSpec } from '../commands/spec/types.ts'
import { IOResult } from '../io/types.ts'
import { MountMode, PathSpec } from '../types.ts'
import { createAsyncContext } from '../utils/async_context.ts'
import { BaseVFS, type VFSOptions } from '../vfs/base.ts'
import { RAMVFS } from '../vfs/ram/ram.ts'
import { Dispatcher } from './dispatcher/dispatcher.ts'
import { Files } from './files.ts'
import {
  getTestParser,
  stderrStr,
  stdoutStr,
} from '../../tests/workspace/fixtures/workspace_fixture.ts'
import { Workspace } from './workspace/workspace.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const DISPATCHED = createAsyncContext<true>()
const CALLS = 'read readdir stat write mkdir unlink rmdir rename truncate setattr'.split(' ')
type Forward = (...args: unknown[]) => Promise<unknown>

/** A plug-in VFS handing a shell's calls to RAM, noting whether a dispatcher handed each over. */
class Toy extends BaseVFS<RAMAccessor> {
  readonly calls: [string, boolean][] = []
  readonly ram: RAMVFS

  static {
    for (const name of CALLS) {
      Object.defineProperty(this.prototype, name, {
        value(this: Toy, ...args: unknown[]) {
          this.note(name)
          const forward = (this.ram as unknown as Record<string, Forward | undefined>)[name]
          return forward?.apply(this.ram, args)
        },
      })
    }
  }

  constructor(options: Pick<VFSOptions<RAMAccessor>, 'commands'> = {}) {
    const ram = new RAMVFS()
    super({ name: 'toy', accessor: ram.accessor, ...options })
    this.ram = ram
  }

  note(name: string): void {
    this.calls.push([name, DISPATCHED.getStore() === true])
  }
}

function marked(dispatcher: Dispatcher): Dispatcher {
  const entry = dispatcher.dispatch
  dispatcher.dispatch = (...args) =>
    DISPATCHED.run(true, () => entry(...args)) as ReturnType<typeof entry>
  return dispatcher
}

/** A workspace whose dispatcher, and each view it binds, marks every call it hands over. */
async function markedWorkspace(
  mounts: Record<string, BaseVFS>,
  mode: MountMode = MountMode.WRITE,
): Promise<Workspace> {
  type Bind = (this: Dispatcher, arg: never) => Dispatcher
  const views = Dispatcher.prototype as unknown as Record<'forSession' | 'forCaller', Bind>
  for (const view of ['forSession', 'forCaller'] as const) {
    const bind = views[view]
    vi.spyOn(views, view).mockImplementation(function (this: Dispatcher, arg: never) {
      return marked(bind.call(this, arg))
    })
  }
  const ws = new Workspace(mounts, { mode, shellParser: await getTestParser() })
  marked((ws as unknown as { dispatcher: Dispatcher }).dispatcher)
  return ws
}

async function run(ws: Workspace, line: string, sessionId = ''): Promise<[number, string, string]> {
  const io = await ws.shell(line, sessionId === '' ? {} : { sessionId })
  return [io.exitCode, stdoutStr(io), stderrStr(io)]
}

afterEach(() => {
  vi.restoreAllMocks()
})

const SEED = [
  'mkdir -p /t/dir/sub /t/empty',
  "printf 'alpha\\nbeta\\ngamma\\n' > /t/a.txt",
  "printf 'beta\\ndelta\\n' > /t/b.txt",
  "printf 'charlie\\n' > /t/dir/c.txt",
  "printf 'delta\\n' > /t/dir/sub/d.txt",
  "printf '3\\n1\\n2\\n' > /t/nums.txt",
  "printf 'apple\\nbanana\\ncherry\\n' > /t/sorted.txt",
  "printf '1,a\\n2,b\\n' > /t/left.csv",
  "printf '1,x\\n2,y\\n' > /t/right.csv",
  "printf 'a b\\nb c\\n' > /t/deps.txt",
  'printf \'{"k": [1, 2]}\\n\' > /t/data.json',
  "printf -- '--- a.txt\\n+++ a.txt\\n@@ -1,3 +1,3 @@\\n alpha\\n-beta\\n+BETA\\n gamma\\n' > /t/a.patch",
  'ln -s a.txt /t/link.txt',
].join(' && ')

const ROWS: Record<string, string> = {
  ...Object.fromEntries(
    'base64 expand fmt md5 md5sum nl rev sha1sum sha256sum sha384sum sha512sum strings tac unexpand uniq wc xxd'
      .split(' ')
      .map((name) => [name, `${name} /t/a.txt`]),
  ),
  awk: "awk '{print $1}' /t/a.txt",
  basename: 'basename /t/dir/c.txt',
  cat: 'cat /t/a.txt /t/link.txt',
  cmp: 'cmp /t/a.txt /t/a.txt',
  column: 'column -t -s, /t/left.csv',
  comm: 'comm /t/sorted.txt /t/sorted.txt',
  cp: 'cp -r /t/dir /t/copy && cp /t/link.txt /t/copied.txt',
  csplit: 'csplit -f /t/piece /t/a.txt 2',
  cut: 'cut -c1-3 /t/a.txt',
  diff: 'diff /t/a.txt /t/a.txt',
  dirname: 'dirname /t/dir/c.txt',
  du: 'du -a /t/dir',
  file: 'file /t/a.txt /t/data.json /t/dir',
  find: "find /t -name '*.txt'",
  fold: 'fold -w 3 /t/a.txt',
  grep: 'grep -rn beta /t',
  gunzip: 'gzip -k /t/b.txt && gunzip -f /t/b.txt.gz',
  gzip: 'gzip -k /t/a.txt',
  head: 'head -n 2 /t/a.txt',
  iconv: 'iconv -f utf-8 -t ascii /t/a.txt',
  join: 'join -t, /t/left.csv /t/right.csv',
  jq: 'jq .k /t/data.json',
  look: 'look ban /t/sorted.txt',
  ls: 'ls -laR /t',
  mkdir: 'mkdir -p /t/new/deep',
  mktemp: 'mktemp -p /t',
  mv: 'mv /t/b.txt /t/dir/moved.txt',
  numfmt: 'numfmt --to=iec < /t/nums.txt',
  od: 'od -c /t/a.txt',
  paste: 'paste /t/a.txt /t/b.txt',
  patch: 'patch /t/a.txt /t/a.patch',
  readlink: 'readlink /t/link.txt',
  realpath: 'realpath /t/link.txt',
  rg: 'rg -n beta /t',
  rm: 'rm /t/b.txt /t/dir/c.txt',
  rmdir: 'rmdir /t/empty',
  sed: 'sed -i s/beta/BETA/ /t/a.txt',
  shuf: 'shuf -o /t/shuffled.txt /t/a.txt',
  sort: 'sort -o /t/out.txt /t/nums.txt',
  split: 'split -l 1 /t/a.txt /t/part.',
  stat: 'stat /t/a.txt /t/dir',
  tail: 'tail -n 1 /t/a.txt',
  tar: 'tar -cf /t/x.tar -C /t dir && tar -tf /t/x.tar && mkdir /t/out && tar -xf /t/x.tar -C /t/out',
  tee: 'echo hi | tee /t/tee.txt',
  touch: 'touch /t/a.txt /t/touched.txt',
  tr: 'tr a-z A-Z < /t/a.txt',
  tree: 'tree /t',
  truncate: 'truncate -s 2 /t/a.txt',
  tsort: 'tsort /t/deps.txt',
  unlink: 'unlink /t/b.txt',
  unzip: 'zip -r /t/x.zip /t/dir && unzip -o -d /t/unzipped /t/x.zip',
  zcat: 'gzip -k /t/a.txt && zcat /t/a.txt.gz',
  zgrep: 'gzip -k /t/a.txt && zgrep beta /t/a.txt.gz',
  zip: 'zip -r /t/x.zip /t/dir',
  js: "js -e \"const f = std.open('/t/a.txt', 'r'); console.log(f.readAsString()); f.close()\"",
  python3: 'python3 -c "print(open(\'/t/a.txt\').read())"',
}
// Answered above the VFS: by string, by the namespace's links, by the index.
const ABOVE = new Set(['basename', 'dirname', 'readlink', 'realpath', 'stat'])
const SKIP: Record<string, string> = {
  'reaches the network': 'curl wget',
  'reads no file': 'bc date expr getconf hostname id seq uname',
  'the same command as js': 'node',
  'the same command as python3': 'python',
}
// Lines across two mounts, at least one per strategy.
const CROSS: Record<string, string> = {
  cat: 'cat /t/a.txt /u/a.txt',
  head: 'head -n 1 /t/a.txt /u/a.txt',
  rm: 'rm /t/b.txt /u/b.txt',
  find: 'find /t /u -name a.txt',
  du: 'du -s /t /u',
  grep: 'grep -r beta /t /u',
  sort: 'sort /t/nums.txt /u/a.txt',
  wc: 'wc /t/a.txt /u/a.txt',
  awk: "awk '{print FILENAME}' /t/a.txt /u/a.txt",
  cp: 'cp -r /t/dir /u/copy && cp /u/a.txt /t/from_u.txt',
  mv: 'mv /t/b.txt /u/moved.txt',
  tee: 'echo hi | tee /t/tee.txt /u/tee.txt',
  ls: 'ls -lR /t /u',
  sed: 'sed -n 1p /t/a.txt /u/a.txt',
  tar: 'tar -cf /u/x.tar /t/dir /u/a.txt',
}
const TRACES: Record<string, [string, string[]]> = {
  ...Object.fromEntries(Object.entries(ROWS).map(([name, line]) => [name, [line, ['/t/']]])),
  ...Object.fromEntries(
    Object.entries(CROSS).map(([name, line]) => [`${name} across`, [line, ['/t/', '/u/']]]),
  ),
}

describe('every builtin goes through the dispatcher', () => {
  it('covers every builtin with a row or a reason and every strategy with a cross row', () => {
    const skipped = Object.values(SKIP).join(' ').split(' ')
    const names = new Set([...GENERIC_COMMANDS, ...GENERAL_COMMANDS].map((c) => c.name))
    expect(Object.keys(ROWS).filter((name) => skipped.includes(name))).toEqual([])
    expect([...names].sort()).toEqual([...Object.keys(ROWS), ...skipped].sort())
    expect(new Set(Object.keys(CROSS).map((name) => strategyFor(name)))).toEqual(
      new Set(Object.values(Strategy)),
    )
  })

  it.each(Object.entries(TRACES))(
    '%s reaches its files only through the dispatcher',
    async (name, [line, prefixes]) => {
      const mounts = Object.fromEntries(prefixes.map((prefix) => [prefix, new Toy()]))
      const toys = Object.values(mounts)
      const ws = await markedWorkspace(mounts, MountMode.EXEC)
      try {
        for (const prefix of prefixes) {
          const seeded = await ws.shell(SEED.replaceAll('/t/', prefix))
          expect(seeded.exitCode, stderrStr(seeded)).toBe(0)
        }
        for (const toy of toys) toy.calls.length = 0
        const io = await ws.shell(line)
        expect(io.exitCode, stderrStr(io)).toBe(0)
      } finally {
        await ws.close()
      }
      expect(toys.map((toy) => toy.calls.length > 0)).toEqual(toys.map(() => !ABOVE.has(name)))
      expect(toys.flatMap((toy) => toy.calls.filter(([, inside]) => !inside))).toEqual([])
    },
    60_000,
  )

  it('sees a call past the dispatcher', async () => {
    const toy = new Toy()
    const peek = command({
      name: 'peek',
      vfs: null,
      spec: new CommandSpec(),
      fn: async () => [await toy.read(PathSpec.fromStrPath('/a.txt')), new IOResult()],
    })
    const ws = await markedWorkspace({ '/t/': toy })
    try {
      await ws.shell(SEED)
      ws.mount('/t/').registerCommands(peek)
      toy.calls.length = 0
      const io = await ws.shell('peek; cat /t/a.txt')
      expect(stdoutStr(io)).toBe('alpha\nbeta\ngamma\n'.repeat(2))
    } finally {
      await ws.close()
    }
    expect(toy.calls).toEqual([
      ['read', false],
      ['read', true],
    ])
  })
})

const DEFAULT_GREP = generic('grep')

const TOY_GREP = command({
  name: 'grep',
  vfs: 'toy',
  spec: DEFAULT_GREP.spec,
  fn: async (accessor, paths, texts, ctx): Promise<CommandFnResult> => {
    if (new FlagView(ctx.flags, ctx.spec ?? DEFAULT_GREP.spec).asBool('count')) {
      return DEFAULT_GREP.fn(accessor, paths, texts, ctx)
    }
    let hits = ''
    for (const path of paths) {
      for (const line of DEC.decode(await ctx.vfs?.read(path)).split('\n')) {
        if (texts[0] !== undefined && line.includes(texts[0])) hits += `toy> ${line}\n`
      }
    }
    return [ENC.encode(hits), new IOResult()]
  },
})

describe('a replacement hands the rest to the default', () => {
  it('answers what it hands back as the builtin does', async () => {
    const ws = await markedWorkspace({ '/t/': new Toy({ commands: TOY_GREP }) })
    try {
      expect((await ws.shell(SEED)).exitCode).toBe(0)
      expect(await run(ws, 'cd /t && grep -c beta a.txt b.txt dir/c.txt')).toEqual([
        0,
        'a.txt:1\nb.txt:1\ndir/c.txt:0\n',
        '',
      ])
      expect(await run(ws, 'cd /t && grep beta a.txt')).toEqual([0, 'toy> beta\n', ''])
    } finally {
      await ws.close()
    }
  })
})

async function outcome(vfs: BaseVFS, line: string): Promise<[number, string, string]> {
  const ws = new Workspace(
    { '/t/': vfs },
    { mode: MountMode.WRITE, shellParser: await getTestParser() },
  )
  try {
    expect((await ws.shell(SEED)).exitCode).toBe(0)
    return await run(ws, line)
  } finally {
    await ws.close()
  }
}

describe('a plug-in VFS answers as RAM does', () => {
  const conforms = async (line: string): Promise<void> => {
    expect(await outcome(new Toy(), line)).toEqual(await outcome(new RAMVFS(), line))
  }
  it.each([
    'tar -cf /t/x.tar -C /t dir a.txt && tar -tf /t/x.tar && mkdir /t/out' +
      ' && tar -xf /t/x.tar -C /t/out && find /t/out',
    'touch /t/a.txt /t/fresh.txt && ls /t && wc -c /t/fresh.txt',
  ])('%s', conforms)
  // rm -r needs rmR: builders/rm.ts falls back to unlink and rmdir only when the dispatcher declines.
  it.fails('rm -r /t/dir && ls /t', () => conforms('rm -r /t/dir && ls /t'))
})

const SEEN: [string, Context][] = []
const FILE = [new Argument('file', { type: 'path' })]

function show(kind: string): CommandFn<RAMAccessor> {
  return async (_accessor, [path], _texts, ctx) => {
    SEEN.push([kind, ctx])
    if (path === undefined || ctx.vfs === undefined) return [null, new IOResult({ exitCode: 1 })]
    return [await ctx.vfs.read(path), new IOResult()]
  }
}

const PEEK = command({
  name: 'peek',
  vfs: null,
  spec: new CommandSpec({ arguments: FILE }),
  fn: show('command'),
})

const NOTES = new CLI({
  spec: new CommandSpec({
    name: 'notes',
    subcommands: [new CommandSpec({ name: 'show', arguments: FILE })],
  }),
  handlers: { show: new CLIHandler({ fn: show('tree') }) },
})

const PAGE = new CLI({
  spec: new CommandSpec({ name: 'page', arguments: FILE }),
  handlers: { '': new CLIHandler({ fn: show('installed') }) },
})

const KINDS: Record<string, string> = {
  command: 'peek /n/a.txt',
  tree: 'notes show /n/a.txt',
  installed: 'page /n/a.txt',
}

describe('one handler shape for a command and a CLI', () => {
  it('gives a command, a tree and a CLI one context', async () => {
    SEEN.length = 0
    const ws = new Workspace(
      { '/n/': new RAMVFS() },
      { mode: MountMode.WRITE, shellParser: await getTestParser() },
    )
    try {
      expect((await ws.shell("printf 'first\\n' > /n/a.txt")).exitCode).toBe(0)
      ws.mount('/n/').registerCommands([...PEEK, NOTES])
      ws.registerCli('page', PAGE)
      ws.createSession('one')
      for (const line of Object.values(KINDS)) {
        expect(await run(ws, line, 'one'), line).toEqual([0, 'first\n', ''])
      }
    } finally {
      await ws.close()
    }
    expect(SEEN.map(([kind]) => kind)).toEqual(Object.keys(KINDS))
    for (const [kind, ctx] of SEEN) {
      const shape = [ctx.vfs instanceof Files, ctx.session?.sessionId, typeof ctx.shell]
      expect(shape, kind).toEqual([true, 'one', 'function'])
    }
  })
})
