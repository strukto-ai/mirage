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

import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { FIND } from '../core/posix/constants.ts'
import {
  currentCaller,
  getAdmission,
  getCurrentSession,
  lineRunning,
} from '../context/session_context.ts'
import { edquot, enoent } from '../errors/fs.ts'
import { RAMVFS } from '../vfs/ram/ram.ts'
import { Limit, MountMode } from '../types.ts'
import { Workspace } from '../workspace/workspace/workspace.ts'
import type { ProfileMount } from '../policy/profile.ts'
import type { SessionState } from '../workspace/session/session.ts'
import { materialize, type ByteSource } from '../io/types.ts'
import { shellJoin } from '../shell/join.ts'
import type { MachinePipe, MountType } from './types.ts'
import type { OutputFn, RunAnswer, RunResult } from '../runtime/types.ts'
import { MachineHandle } from './handle.ts'
import { PIPE_TRANSPORT, type PipeTransport } from './mixin.ts'
import {
  DARWIN_ADMIN_STATUS,
  DARWIN_MOUNT_GUARD,
  DARWIN_PATH,
  DARWIN_POINT_MARK,
  isRun,
  MIRAGE_FUSE_LINE,
  MOUNT_GUARD,
  RUN_PROGRAM_AT,
  SSHFS_HINT,
  SSHFS_LINE,
  SSHFS_LINKS_OPTION,
  SSHFS_OPTIONS,
  UNMOUNT_WAIT_SECONDS,
} from './constants.ts'
import {
  darwinAdminHint,
  darwinLeft,
  darwinMountTable,
  darwinTableLine,
  killLine,
  mirageSource,
  mountTable,
  registerPipeServer,
  runningLine,
  servedPrefixes,
  sourceName,
  sshfsLine,
  topPrefixes,
  type PipeServer,
} from './mounts.ts'
import { on } from '../../tests/fixtures/machine.ts'
import { SERVED_BY } from '../mount/changes.ts'
import { ManualClock } from '../utils/clock.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const LOST = 'fake: /data/a.bin: Disk quota exceeded\nfake: /my notes/b.txt: Disk quota exceeded\n'

// What a fake box answers a line.
function answer(stdout = '', exitCode = 0, stderr = ''): RunAnswer {
  return { exitCode, stdout: ENC.encode(stdout), stderr: ENC.encode(stderr) }
}

// sh -c's own reading of a single-quoted word, enough for these commands.
function words(command: string): string[] {
  return [...command.matchAll(/'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? '')
}

// The source and mountpoint an sshfs pipe command names.
// The source, prefix and mount type an sshfs or mirage-fuse pipe command mounts.
function sshfsMount(command: string): [string, string, string] {
  const all = words(command)
  const at = all.indexOf('exec')
  if (all[at + 2] === 'serve') return [all[at + 3] ?? '', all[at + 4] ?? '', 'fuse.mirage']
  return [all[at + 5] ?? '', all[at + 6] ?? '', 'fuse.sshfs']
}

// The argv a sandbox runs, as the line the fakes answer.
function lineOf(argv: readonly string[]): string {
  return argv[0] === '/bin/sh' && argv[1] === '-c' ? (argv[2] ?? '') : shellJoin(argv)
}

class FakeMachine extends MachineHandle implements PipeTransport {
  readonly [PIPE_TRANSPORT] = true as const
  static override readonly provider = 'fake'
  readonly captures = ['python3']
  table = new Map<string, [string, string]>()
  running = new Set<string>()
  readonly commands: string[] = []
  readonly pipes: string[] = []
  readonly ends = new Map<string, () => void>()
  readonly stopped: string[] = []
  readonly guards: string[][] = []
  failUnmount = false
  refuseUnmount = false
  failTable = false
  failCheck = false
  failKill = false
  hangKill = false
  // Kills that never answered and were let go.
  killsStopped = 0
  // How long the kill line takes to land.
  killMs = 0
  hang = false

  constructor(
    mountType: MountType,
    own: readonly string[] = [],
    private readonly sshfs = true,
    private readonly sshfsMounts = true,
    name = 'box',
  ) {
    super(name, { mountType })
    for (const prefix of own) this.table.set(prefix, ['tmpfs', 'tmpfs'])
  }

  connect(): Promise<void> {
    return Promise.resolve()
  }

  protected override async execArgv(
    argv: readonly string[],
    stdin: ByteSource | null,
    env: Record<string, string>,
    cwd: string,
    output: OutputFn,
    errors: OutputFn,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    let run = isRun(argv) ? argv.slice(RUN_PROGRAM_AT) : argv
    let done: RunAnswer | null = null
    if (run[2] === MOUNT_GUARD) {
      const checked = this.runGuard(run)
      if (checked.exitCode !== 0) done = checked
      run = run.slice(run.indexOf('--', 5) + 1)
    }
    const data = stdin === null ? null : await materialize(stdin)
    done ??= await this.execLine(lineOf(run), data, env, cwd, signal)
    if (done.stdout.byteLength > 0) await output(done.stdout)
    if (done.stderr.byteLength > 0) await errors(done.stderr)
    return { exitCode: done.exitCode }
  }

  rows(): string {
    return [...this.table]
      .map(([p, [source, kind]]) => `${escaped(source, '#')} ${escaped(p)} ${kind} rw 0 0\n`)
      .join('')
  }

  /** Run a line's mount guard through /bin/sh over this table. */
  runGuard(argv: readonly string[]): RunAnswer {
    const entries = argv.slice(8, argv.indexOf('--', 8))
    this.guards.push(entries)
    const dir = mkdtempSync(join(tmpdir(), 'mirage-guard-'))
    const table = join(dir, 'mounts')
    writeFileSync(table, this.rows())
    try {
      const done = spawnSync('/bin/sh', [...argv.slice(1, 7), table, ...entries, '--', 'true'])
      return {
        stdout: new Uint8Array(done.stdout),
        stderr: new Uint8Array(done.stderr),
        exitCode: done.status ?? 1,
      }
    } finally {
      rmSync(dir, { recursive: true })
    }
  }

  override execLine(
    line: string,
    _stdin?: ByteSource | null,
    _env?: Record<string, string>,
    _cwd?: string,
    signal?: AbortSignal,
  ): Promise<RunAnswer> {
    this.commands.push(line)
    if (line.startsWith(`${FIND} `))
      return Promise.resolve({
        stdout: ENC.encode('d 1777 4096 0 0 0 0 2 8 \0'),
        stderr: new Uint8Array(),
        exitCode: 0,
      })
    if ((line === 'cat /proc/mounts' && this.hang) || line === 'python3 slow.py') {
      return new Promise((_, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new Error('aborted'))
        })
      })
    }
    if (line === 'cat /proc/mounts' && this.failTable) {
      return Promise.resolve(answer('', 1, 'gone\n'))
    }
    if (line === 'cat /proc/mounts') {
      return Promise.resolve(answer(this.rows()))
    }
    if (line.startsWith('cat /proc/[0-9]*/cmdline') && this.failCheck) {
      return Promise.resolve(answer('', 2))
    }
    if (line.startsWith('for p in /proc/[0-9]*') && this.killMs > 0) {
      return new Promise((resolve) =>
        setTimeout(() => {
          this.running.delete(/ S='([^']*)' /.exec(line)?.[1] ?? '')
          resolve(answer('', 0))
        }, this.killMs),
      )
    }
    if (line.startsWith('for p in /proc/[0-9]*') && this.hangKill) {
      return new Promise((_, reject) => {
        signal?.addEventListener('abort', () => {
          this.killsStopped += 1
          reject(new Error('aborted'))
        })
      })
    }
    if (line.startsWith('for p in /proc/[0-9]*') && this.failKill) {
      return Promise.reject(new Error('the machine went away'))
    }
    if (line.startsWith('for p in /proc/[0-9]*')) {
      this.running.delete(/ S='([^']*)' /.exec(line)?.[1] ?? '')
    }
    if (line.startsWith('cat /proc/[0-9]*/cmdline')) {
      const source = / S='([^']*)' /.exec(line)?.[1] ?? ''
      return Promise.resolve(answer('', this.running.has(source) ? 0 : 1))
    }
    if (line.startsWith('d=$(PATH=')) {
      return Promise.resolve(answer('/home/u/.mirage'))
    }
    if (line === SSHFS_LINE || line === MIRAGE_FUSE_LINE) {
      return Promise.resolve(answer('', this.sshfs ? 0 : 1))
    }
    if (line.startsWith('fusermount3 -uz ')) {
      if (this.failUnmount) return Promise.reject(new Error('the machine went away'))
      if (this.refuseUnmount) return Promise.resolve(answer('', 1, 'fusermount: busy\n'))
      const prefix = words(line)[2] ?? ''
      const [source] = this.table.get(prefix) ?? ['']
      this.table.delete(prefix)
      this.running.delete(source)
    }
    if (line === 'python3 fails.py') return Promise.resolve(answer('', 3, 'boom\n'))
    return Promise.resolve(answer('ran\n'))
  }

  openPipe(command: string): Promise<MachinePipe> {
    this.pipes.push(command)
    const [source, prefix, kind] = sshfsMount(command)
    if (this.sshfsMounts) {
      this.table.set(prefix, [source, kind])
      this.running.add(source)
    }
    let end: () => void = () => undefined
    const reader = new ReadableStream<Uint8Array>({
      start(controller) {
        let open = true
        end = () => {
          if (open) controller.close()
          open = false
        }
      },
    })
    this.ends.set(prefix, end)
    return Promise.resolve({
      reader,
      writer: { write: () => undefined, drain: () => Promise.resolve(), end: () => undefined },
      stop: () => {
        this.stopped.push(prefix)
        end()
        return Promise.resolve()
      },
    })
  }

  served(): string[] {
    return this.pipes.map((p) => sshfsMount(p)[1])
  }

  /** End `prefix`'s server: its sshfs then unmounts itself. */
  sshfsExits(prefix: string): void {
    this.ends.get(prefix)?.()
    const [source] = this.table.get(prefix) ?? ['']
    this.table.delete(prefix)
    this.running.delete(source)
  }
}

/**
 * A Mac: no `/proc`, a table `mount` prints at each mount's real path, and a
 * root folder only where a link in `/etc/synthetic.conf` leads it into
 * Mirage's folder (`linked`).
 */
class FakeMac extends FakeMachine {
  readonly linked: Set<string>

  constructor(mountType: MountType, linked: readonly string[] = []) {
    super(mountType)
    this.linked = new Set(linked)
  }

  real(prefix: string): string {
    return this.linked.has(prefix) ? `/home/u/.mirage/mnt${prefix}` : prefix
  }

  mountRows(): string {
    return [...this.table]
      .map(([point, [source, kind]]) => `${source} on ${point} (${kind}, nodev, nosuid)\n`)
      .join('')
  }

  protected override async execArgv(
    argv: readonly string[],
    stdin: ByteSource | null,
    env: Record<string, string>,
    cwd: string,
    output: OutputFn,
    errors: OutputFn,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    let run = isRun(argv) ? argv.slice(RUN_PROGRAM_AT) : argv
    if (run[2] === DARWIN_MOUNT_GUARD) {
      const checked = this.runMacGuard(run)
      if (checked.exitCode !== 0) {
        if (checked.stdout.byteLength > 0) await output(checked.stdout)
        if (checked.stderr.byteLength > 0) await errors(checked.stderr)
        return { exitCode: checked.exitCode }
      }
      run = run.slice(run.indexOf('--', 5) + 1)
    }
    return super.execArgv(run, stdin, env, cwd, output, errors, signal)
  }

  override execLine(
    line: string,
    stdin?: ByteSource | null,
    env?: Record<string, string>,
    cwd?: string,
    signal?: AbortSignal,
  ): Promise<RunAnswer> {
    if (line === 'uname -s') {
      this.commands.push(line)
      return Promise.resolve(answer('Darwin\n'))
    }
    if (line.startsWith(`PATH=${DARWIN_PATH}; mount || exit 1;`)) {
      this.commands.push(line)
      const listed = line.split('for p in ')[1]?.split('; do')[0] ?? ''
      const points = words(listed)
        .map((p) => `${DARWIN_POINT_MARK}${p}\t${this.real(p)}\n`)
        .join('')
      return Promise.resolve(answer(this.mountRows() + points))
    }
    if (line.startsWith(`PATH=${DARWIN_PATH}; p=`)) {
      this.commands.push(line)
      const prefix = /; p='([^']*)';/.exec(line)?.[1] ?? ''
      if (prefix.split('/').length === 2 && !this.linked.has(prefix)) {
        return Promise.resolve(answer('', DARWIN_ADMIN_STATUS))
      }
      return Promise.resolve(answer(`${this.real(prefix)}\n`))
    }
    if (line.startsWith('umount -f ')) {
      this.commands.push(line)
      const point = words(line)[2] ?? ''
      const [source] = this.table.get(point) ?? ['']
      this.table.delete(point)
      this.running.delete(source)
      return Promise.resolve(answer())
    }
    return super.execLine(line, stdin, env, cwd, signal)
  }

  override async openPipe(command: string): Promise<MachinePipe> {
    const pipe = await super.openPipe(command)
    const [source, point] = sshfsMount(command)
    if (this.table.has(point)) this.table.set(point, [source, 'macfuse'])
    return pipe
  }

  /** Run a line's Mac mount guard through /bin/sh, its `mount` printing this table. */
  runMacGuard(argv: readonly string[]): RunAnswer {
    const entries = argv.slice(8, argv.indexOf('--', 8))
    this.guards.push(entries)
    const dir = mkdtempSync(join(tmpdir(), 'mirage-guard-'))
    const mount = join(dir, 'mount')
    writeFileSync(
      mount,
      `#!/bin/sh\nprintf '%s' '${this.mountRows().replaceAll("'", "'\\''")}'\n`,
      { mode: 0o755 },
    )
    try {
      const done = spawnSync('/bin/sh', [
        '-c',
        (argv[2] ?? '').replaceAll('/sbin/mount', mount),
        ...argv.slice(3, 8),
        ...entries,
        '--',
        'true',
      ])
      return {
        stdout: new Uint8Array(done.stdout),
        stderr: new Uint8Array(done.stderr),
        exitCode: done.status ?? 1,
      }
    } finally {
      rmSync(dir, { recursive: true })
    }
  }
}

// `text` as the kernel writes a mount field: a space, and `more`, as octal escapes.
function escaped(text: string, more = ''): string {
  return text.replace(
    new RegExp(`[ ${more}]`, 'g'),
    (c) => `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}`,
  )
}

// Another workspace's runtime on the same sandbox.
/** A machine that counts its connects and closes. */
class Counted extends FakeMachine {
  connects = 0
  closes = 0

  override connect(): Promise<void> {
    this.connects += 1
    return super.connect()
  }

  override async close(): Promise<void> {
    this.closes += 1
    await super.close()
  }
}

function sharing(sandbox: FakeMachine, mountType: MountType, name = 'box'): FakeMachine {
  const other = new FakeMachine(mountType, [], true, true, name)
  other.table = sandbox.table
  other.running = sandbox.running
  return other
}

function workspace(
  sandbox: FakeMachine,
  hide: string[] = [],
  mounts?: ReadonlyMap<string, ProfileMount>,
  commandLimits?: Record<string, Limit>,
  workspaceId?: string,
): Workspace {
  return new Workspace(
    {
      '/': new RAMVFS(),
      '/data': new RAMVFS(),
      '/data/sub': new RAMVFS(),
      '/my notes': new RAMVFS(),
    },
    {
      mode: MountMode.WRITE,
      profiles: { agent: { paths: { hide }, ...(mounts === undefined ? {} : { mounts }) } },
      ...on(sandbox),
      ...(commandLimits === undefined ? {} : { commandLimits }),
      ...(workspaceId === undefined ? {} : { workspaceId }),
    },
  )
}

// Whether `run` runs a request with a line's write admission.
async function lentALine(run: (op: () => Promise<void>) => Promise<void>): Promise<boolean> {
  let stop: unknown = null
  await run(() => {
    stop = currentCaller().stop
    return Promise.resolve()
  })
  return stop !== null
}

async function until(ready: () => boolean): Promise<void> {
  for (let tries = 0; tries < 1000 && !ready(); tries++) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  expect(ready()).toBe(true)
}

/**
 * Start a slow program, then end /data's server while it runs; `stop` ends
 * the program's line.
 */
async function endedInALine(
  sandbox: FakeMachine,
  ws: Workspace,
): Promise<{ stop: () => Promise<void> }> {
  const abort = new AbortController()
  const line = ws
    .shell('python3 slow.py', { sessionId: 'agent', signal: abort.signal })
    .catch(() => undefined)
  await until(() => sandbox.commands.includes('python3 slow.py'))
  sandbox.ends.get('/data')?.()
  return {
    stop: async () => {
      abort.abort()
      await line
    },
  }
}

const sessions: SessionState[] = []

// A served prefix's server that reads its pipe to the end.
const drain = (_files: unknown, session: SessionState): PipeServer => ({
  async serve(reader) {
    sessions.push(session)
    const chunks = reader.getReader()
    while (!(await chunks.read()).done) continue
  },
  sync: () => Promise.resolve([]),
})

beforeAll(() => {
  registerPipeServer('ssh', drain)
  registerPipeServer('mirage', drain)
})

describe('mountTable', () => {
  it('unescapes paths and keeps the top entry', () => {
    const table = mountTable(
      'tmpfs /data tmpfs rw 0 0\n' +
        'mirage-ab:/data /data fuse.sshfs rw 0 0\n' +
        'mirage-ab:/my\\040notes /my\\040notes fuse.sshfs rw 0 0\n',
    )
    expect(Object.fromEntries(table)).toEqual({
      '/data': ['mirage-ab:/data', 'fuse.sshfs'],
      '/my notes': ['mirage-ab:/my notes', 'fuse.sshfs'],
    })
  })
})

describe('darwinMountTable', () => {
  it('names each prefix by its real path', () => {
    const [rows, points] = darwinMountTable(
      '/dev/disk3s1 on / (apfs, local, read-only, journaled)\n' +
        'src-1:/data on /home/u/.mirage/mnt/data (macfuse, nodev, nosuid, ' +
        'synchronous, nobrowse, mounted by u)\n' +
        'src-1:/a on /b on /a on /b (macfuse, nodev, mounted by u)\n' +
        `${DARWIN_POINT_MARK}/data\t/home/u/.mirage/mnt/data\n` +
        `${DARWIN_POINT_MARK}/notes\t/notes\n`,
      new Map([['/a on /b', '/a on /b']]),
    )
    expect(Object.fromEntries(rows)).toEqual({
      '/data': ['src-1:/data', 'macfuse'],
      '/a on /b': ['src-1:/a on /b', 'macfuse'],
    })
    expect(Object.fromEntries(points)).toEqual({
      '/data': '/home/u/.mirage/mnt/data',
      '/notes': '/notes',
      '/a on /b': '/a on /b',
    })
  })

  it.skipIf(process.platform !== 'darwin')('follows a link to its real path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-table-'))
    try {
      mkdirSync(join(dir, 'real'))
      symlinkSync(join(dir, 'real'), join(dir, 'link'))
      const line = darwinTableLine([`${dir}/link/ws`])
      const [, points] = darwinMountTable(
        spawnSync('/bin/sh', ['-c', line], { encoding: 'utf8' }).stdout,
        new Map(),
      )
      expect(Object.fromEntries(points)).toEqual({
        [`${dir}/link/ws`]: `${realpathSync(join(dir, 'real'))}/ws`,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('runningLine', () => {
  // A program carrying the source as an argument serves it, as sshfs does;
  // a shorter or another source is not it.
  it.skipIf(!existsSync('/proc/self'))('finds a program carrying the source', async () => {
    const program = spawn('/bin/sh', [
      '-c',
      'echo ready; while :; do sleep 1; done',
      'sh',
      'mirage-x:/my notes',
      'mirage-x:/new\nline',
    ])
    try {
      await new Promise<void>((resolve) => {
        program.stdout.once('data', () => {
          resolve()
        })
      })
      const codes = [
        'mirage-x:/my notes',
        'mirage-x:/new\nline',
        'mirage-x:/my',
        'mirage-x:/new',
        'mirage-y:/data',
      ].map(
        (source) => spawnSync('/bin/sh', ['-c', runningLine(source)], { timeout: 10_000 }).status,
      )
      expect(codes).toEqual([0, 0, 1, 1, 1])
    } finally {
      program.kill('SIGKILL')
    }
  })

  // With no process to read, the line cannot tell rather than answer that
  // nothing serves the source.
  it('cannot tell without a process list', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-running-'))
    for (const tool of ['tr', 'awk']) {
      const found = spawnSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' })
      symlinkSync(found.stdout.trim(), join(dir, tool))
    }
    const done = spawnSync('/bin/sh', ['-c', runningLine('mirage-x:/data')], {
      env: { PATH: dir },
      timeout: 10_000,
    })
    expect(done.status).toBe(2)
  })
})

describe('killLine', () => {
  // It kills each program carrying the source as an argument, as sshfs
  // does, and no program carrying a shorter or another source, nor itself.
  it.skipIf(!existsSync('/proc/self'))('kills only a program carrying the source', async () => {
    const start = (source: string) =>
      spawn('/bin/sh', ['-c', 'echo ready; while :; do sleep 1; done', 'sh', source])
    const programs = ['mirage-x:/my notes', 'mirage-x:/my', 'mirage-y:/my notes'].map(start)
    try {
      await Promise.all(
        programs.map(
          (program) =>
            new Promise<void>((resolve) => {
              program.stdout.once('data', () => {
                resolve()
              })
            }),
        ),
      )
      const done = spawnSync('/bin/sh', ['-c', killLine('mirage-x:/my notes')], {
        timeout: 10_000,
      })
      expect(done.status).toBe(0)
      await until(() => programs[0]?.signalCode !== null)
      expect(programs.map((program) => program.signalCode)).toEqual(['SIGKILL', null, null])
    } finally {
      for (const program of programs) program.kill('SIGKILL')
    }
  })
})

describe('sourceName', () => {
  it('names a workspace by its id, escaping what no two ids may share', () => {
    expect(sourceName('w1-2', 'box')).toBe('mirage-w1-2.box')
    expect([sourceName('a.b', 'm'), sourceName('a_b', 'm'), sourceName('a', 'b.m')]).toEqual([
      'mirage-a_2eb.m',
      'mirage-a_5fb.m',
      'mirage-a.b_2em',
    ])
    expect(sourceName('a:é', 'box')).toBe('mirage-a_3a_c3_a9.box')
  })
})

describe('topPrefixes', () => {
  it('leaves out the root, the devices and nested mounts', () => {
    const prefixes = ['/', '/dev/', '/data/', '/data/sub/', '/database/', '/a/b/']
    expect(topPrefixes(prefixes)).toEqual(['/a/b', '/data', '/database'])
  })
})

describe('servedPrefixes', () => {
  it('leaves out what the machine holds itself, and serves a mount under it', () => {
    const prefixes = ['/', '/dev/', '/tmp/', '/tmp/cache/', '/data/', '/data/sub/']
    expect(servedPrefixes(prefixes, ['/tmp/'])).toEqual(['/data', '/tmp/cache'])
    expect(servedPrefixes(prefixes)).toEqual(['/data', '/tmp'])
  })
})

function lost(prefix: string): string {
  return `fake: ${prefix} is no longer mounted in the machine (did it restart?); the line did not run\n`
}

describe('MachineMounts', () => {
  it.each([
    ['1', `${SSHFS_OPTIONS},${SSHFS_LINKS_OPTION}`],
    ['', SSHFS_OPTIONS],
  ])('passes sshfs every link target when it knows how (%j)', async (namesIt, options) => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-sshfs-'))
    try {
      writeFileSync(
        join(dir, 'sshfs'),
        '#!/bin/sh\n' +
          'if [ "$1" = -h ]; then\n' +
          '  echo "usage: sshfs [user@]host:[dir] mountpoint [options]"\n' +
          `  [ -n "$NAMES_IT" ] && echo "    -o ${SSHFS_LINKS_OPTION} allow all symlink targets"\n` +
          '  exit 0\n' +
          'fi\n' +
          'printf \'%s\\n\' "$@"\n' +
          'cat\n',
        { mode: 0o755 },
      )
      const child = spawn(
        '/bin/sh',
        ['-c', sshfsLine('mirage-w:/my notes', '/my notes', join(dir, 'sshfs.log'))],
        { env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}`, NAMES_IT: namesIt } },
      )
      const out: Buffer[] = []
      child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
      const code = new Promise<number | null>((resolve) => child.on('close', resolve))
      child.stdin.end('sftp stream')
      expect([await code, Buffer.concat(out).toString().split('\n').filter(Boolean)]).toEqual([
        0,
        [
          '-f',
          '-o',
          `${options},uid=${String(process.getuid?.())},gid=${String(process.getgid?.())}`,
          'mirage-w:/my notes',
          '/my notes',
          'sftp stream',
        ],
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('serves every prefix the session sees over ssh', async () => {
    const sandbox = new FakeMachine('ssh')
    const ws = workspace(sandbox)
    const agent = await ws.session('agent', { profile: 'agent' })
    const result = await agent.shell('python3 job.py')
    expect([result.exitCode, DEC.decode(result.stdout)]).toEqual([0, 'ran\n'])
    const name = sourceName(ws.workspaceId, 'box')
    const head = (line: string) => line.slice(0, line.lastIndexOf(' 2>'))
    const pipes = sandbox.pipes.map(head)
    const instance = /-([0-9a-f]{8})-1:\/data'/.exec(pipes[0] ?? '')?.[1] ?? ''
    expect(pipes).toEqual([
      head(sshfsLine(`${name}-${instance}-1:/data`, '/data', '')),
      head(sshfsLine(`${name}-${instance}-2:/my notes`, '/my notes', '')),
    ])
    await agent.shell('python3 again.py')
    expect(sandbox.pipes).toHaveLength(2)
    await ws.close()
    expect(sandbox.table.size).toBe(0)
  })

  it('leaves the machine its own /tmp', async () => {
    const sandbox = new FakeMachine('ssh')
    const ws = new Workspace(
      { '/': new RAMVFS(), '/data': new RAMVFS() },
      { mode: MountMode.WRITE, ...on(sandbox) },
    )
    expect((await ws.shell('python3 job.py')).exitCode).toBe(0)
    expect(sandbox.served()).toEqual(['/data'])
    const fromTmp = await ws.shell('cd /tmp && python3 job.py')
    expect([fromTmp.exitCode, DEC.decode(fromTmp.stdout)]).toEqual([0, 'ran\n'])
    await ws.close()
  })

  it('serves a /tmp the workspace mounts itself', async () => {
    const sandbox = new FakeMachine('ssh')
    const ws = new Workspace(
      { '/': new RAMVFS(), '/data': new RAMVFS(), '/tmp': new RAMVFS() },
      { mode: MountMode.WRITE, ...on(sandbox) },
    )
    expect((await ws.shell('python3 job.py')).exitCode).toBe(0)
    expect(sandbox.served()).toEqual(['/data', '/tmp'])
    await ws.close()
  })

  it('leaves a file mounted at a path of its own off the machine', async () => {
    const sandbox = new FakeMachine('ssh')
    const ws = workspace(sandbox)
    await ws.vfsMd('/VFS.md')
    const result = await ws.shell('python3 job.py')
    expect([result.exitCode, DEC.decode(result.stdout)]).toEqual([0, 'ran\n'])
    expect(sandbox.served()).toEqual(['/data', '/my notes'])
    await ws.close()
  })

  it('serves a directory mounted where a file was', async () => {
    const sandbox = new FakeMachine('ssh')
    const ws = workspace(sandbox)
    await ws.vfsMd('/asset')
    expect((await ws.shell('python3 job.py')).exitCode).toBe(0)
    expect(sandbox.served()).toEqual(['/data', '/my notes'])
    await ws.unmount('/asset')
    ws.addMount('/asset', new RAMVFS(), MountMode.WRITE)
    expect((await ws.shell('python3 job.py')).exitCode).toBe(0)
    expect(sandbox.served()).toEqual(['/data', '/my notes', '/asset'])
    await ws.close()
  })

  it('runs a line on a prefix the machine mounts itself when the workspace cannot stat it', async () => {
    const sandbox = new FakeMachine('both', ['/data'])
    const gone = new RAMVFS()
    gone.stat = (path) => Promise.reject(enoent(path))
    const ws = new Workspace(
      { '/': new RAMVFS(), '/data': gone, '/my notes': new RAMVFS() },
      { mode: MountMode.WRITE, ...on(sandbox) },
    )
    expect((await ws.shell('python3 job.py')).exitCode).toBe(0)
    expect(sandbox.served()).toEqual(['/my notes'])
    await ws.close()
  })

  it('refuses a line while the session restricts /tmp', async () => {
    const sandbox = new FakeMachine('ssh')
    const ws = new Workspace(
      { '/': new RAMVFS(), '/data': new RAMVFS() },
      {
        mode: MountMode.WRITE,
        profiles: { agent: { paths: { hide: ['/tmp/secret'] } } },
        ...on(sandbox),
      },
    )
    const agent = await ws.session('agent', { profile: 'agent' })
    const result = await agent.shell('python3 job.py')
    expect(result.exitCode).toBe(126)
    expect(result.decision?.reason).toBe(
      'a mount this session restricts is not served through the dispatcher',
    )
    await ws.close()
  })

  it.each([
    ['/notes', false],
    ['/data', true],
    ['/', true],
  ])('refuses a line from a cwd the machine cannot see: %s', async (cwd, ran) => {
    const sandbox = new FakeMachine('ssh')
    const ws = workspace(sandbox)
    expect((await ws.shell('mkdir -p /notes')).exitCode).toBe(0)
    const result = await ws.shell(`cd ${cwd} && python3 job.py`)
    const said = [result.exitCode, DEC.decode(result.stderr)]
    if (ran) expect(said).toEqual([0, ''])
    else {
      expect(said).toEqual([
        126,
        'fake: the machine cannot see the working directory /notes; cd into a mount first\n',
      ])
      expect([sandbox.commands, sandbox.pipes]).toEqual([[], []])
      const mounts = (sandbox as unknown as { mounts: { lines: unknown[] } }).mounts
      expect(mounts.lines).toHaveLength(0)
    }
    await ws.close()
  })

  it('leaves a running branch admitted when another is refused for its cwd', async () => {
    const sandbox = new FakeMachine('ssh')
    const ws = workspace(sandbox)
    expect((await ws.shell('mkdir -p /notes')).exitCode).toBe(0)
    const controller = new AbortController()
    const line = ws.shell('cd /data && python3 slow.py | (cd /notes && python3 job.py)', {
      signal: controller.signal,
    })
    await until(() => sandbox.commands.includes('python3 slow.py'))
    await new Promise((resolve) => setTimeout(resolve, 200))
    const mounts = (sandbox as unknown as { mounts: { lines: unknown[] } }).mounts
    expect(mounts.lines).toHaveLength(1)
    controller.abort()
    await line.catch(() => undefined)
    await ws.close()
  })

  it('refuses a second session rather than show it the first view', async () => {
    const sandbox = new FakeMachine('ssh')
    const ws = workspace(sandbox)
    const agent = await ws.session('agent', { profile: 'agent' })
    const other = await ws.session('other')
    expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
    const result = await other.shell('python3 job.py')
    expect(result.exitCode).toBe(1)
    expect(DEC.decode(result.stderr)).toBe(
      "fake: this machine shows session agent's view of the workspace; " +
        'give session other a machine of its own\n',
    )
    await ws.close()
  })

  it('lets sessions with one view share the machine', async () => {
    const sandbox = new FakeMachine('ssh')
    const ws = workspace(sandbox)
    const first = await ws.session('first', { profile: 'agent' })
    const second = await ws.session('second', { profile: 'agent' })
    expect((await first.shell('python3 job.py')).exitCode).toBe(0)
    const pipes = [...sandbox.pipes]
    const result = await second.shell('python3 job.py')
    expect([result.exitCode, DEC.decode(result.stderr)]).toEqual([0, ''])
    expect(sandbox.pipes).toEqual(pipes)
    await ws.close()
  })

  it('keeps the machine on the view of the session it first served', async () => {
    const sandbox = new FakeMachine('ssh')
    const ws = workspace(sandbox)
    const first = await ws.session('first', { profile: 'agent' })
    const second = await ws.session('second', { profile: 'agent' })
    expect((await first.shell('python3 job.py')).exitCode).toBe(0)
    expect((await second.shell('python3 job.py')).exitCode).toBe(0)
    await ws.setSessionProfile('second', null)
    const moved = await second.shell('python3 job.py')
    expect([moved.exitCode, DEC.decode(moved.stderr)]).toEqual([
      1,
      "fake: this machine shows session first's view of the workspace; " +
        'give session second a machine of its own\n',
    ])
    expect((await first.shell('python3 job.py')).exitCode).toBe(0)
    await ws.close()
  })

  it('lets sessions share whatever order their mounts were listed in', async () => {
    const sandbox = new FakeMachine('ssh')
    const ws = workspace(sandbox)
    const first = await ws.session('first', { mounts: { '/data': 'read', '/my notes': 'read' } })
    const second = await ws.session('second', { mounts: { '/my notes': 'read', '/data': 'read' } })
    expect((await first.shell('python3 job.py')).exitCode).toBe(0)
    const result = await second.shell('python3 job.py')
    expect([result.exitCode, DEC.decode(result.stderr)]).toEqual([0, ''])
    await ws.close()
  })

  it('lets a session made again under its view share the machine', async () => {
    const sandbox = new FakeMachine('ssh')
    const ws = workspace(sandbox)
    let agent = await ws.session('agent', { profile: 'agent' })
    expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
    await ws.closeSession('agent')
    agent = await ws.session('agent', { profile: 'agent' })
    const result = await agent.shell('python3 job.py')
    expect([result.exitCode, DEC.decode(result.stderr)]).toEqual([0, ''])
    await ws.close()
  })

  it('refuses a session made again under another view', async () => {
    const sandbox = new FakeMachine('ssh')
    const ws = workspace(sandbox)
    let agent = await ws.session('agent', { profile: 'agent' })
    expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
    await ws.closeSession('agent')
    agent = await ws.session('agent')
    const result = await agent.shell('python3 job.py')
    expect(result.exitCode).toBe(1)
    expect(DEC.decode(result.stderr)).toBe(
      "fake: this machine shows an earlier session agent's view of the workspace; " +
        'give session agent a machine of its own\n',
    )
    await ws.close()
  })

  it('refuses hidden unserved mounts without claiming the machine', async () => {
    const sandbox = new FakeMachine('ssh')
    const ws = workspace(sandbox, ['/data', '/my notes'])
    const agent = await ws.session('agent', { profile: 'agent' })
    const other = await ws.session('other')
    const result = await agent.shell('python3 job.py')
    expect(result.exitCode).toBe(126)
    expect(DEC.decode(result.stderr)).toBe('fake: Permission denied\n')
    expect(sandbox.pipes).toEqual([])
    expect((await other.shell('python3 job.py')).exitCode).toBe(0)
    expect(sandbox.pipes).toHaveLength(2)
    await ws.close()
  })

  it('leaves the machine free after a line it refused', async () => {
    const sandbox = new FakeMachine('both', ['/data', '/my notes'])
    const ws = workspace(sandbox, ['/data'])
    const agent = await ws.session('agent', { profile: 'agent' })
    const other = await ws.session('other')
    expect((await agent.shell('python3 job.py')).exitCode).toBe(126)
    expect((await other.shell('python3 job.py')).exitCode).toBe(0)
    await ws.close()
  })

  it.each(['tmpfs', 'mirage-cache'])(
    'serves over both what the machine does not mount itself (%s)',
    async (source) => {
      const sandbox = new FakeMachine('both')
      sandbox.table.set('/data', [source, 'tmpfs'])
      const ws = workspace(sandbox, ['/my notes/secret'])
      const agent = await ws.session('agent', { profile: 'agent' })
      expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
      expect(sandbox.served()).toEqual(['/my notes'])
      await ws.close()
    },
  )

  it.each(['both', 'own'] as const)(
    'refuses a line under %s while a rule covers a prefix the machine serves',
    async (mountType) => {
      const sandbox = new FakeMachine(mountType, ['/data'])
      const ws = workspace(sandbox, ['/data/secret.csv'])
      const agent = await ws.session('agent', { profile: 'agent' })
      const result = await agent.shell('python3 job.py')
      expect(result.exitCode).toBe(126)
      expect(DEC.decode(result.stderr)).toBe('fake: Permission denied\n')
      expect(sandbox.commands).not.toContain('python3 job.py')
      await ws.close()
    },
  )

  it('refuses a line once the machine mounts a ruled prefix itself', async () => {
    const sandbox = new FakeMachine('own')
    const ws = workspace(sandbox, ['/data/secret.csv'])
    const agent = await ws.session('agent', { profile: 'agent' })
    expect((await agent.shell('python3 job.py')).exitCode).toBe(126)
    sandbox.table.set('/data', ['x', 'fuse'])
    const result = await agent.shell('python3 job.py')
    expect(result.exitCode).toBe(126)
    expect(DEC.decode(result.stderr)).toBe('fake: Permission denied\n')
    await ws.close()
  })

  it('serves nothing from the host over fuse and takes any session', async () => {
    const sandbox = new FakeMachine('own', ['/data'])
    const ws = workspace(sandbox, ['/my notes/secret'])
    const agent = await ws.session('agent', { profile: 'agent' })
    const other = await ws.session('other')
    expect((await agent.shell('python3 job.py')).exitCode).toBe(126)
    expect((await other.shell('python3 job.py')).exitCode).toBe(0)
    expect(sandbox.pipes).toEqual([])
    await ws.close()
  })

  it('fails loud in a sandbox without sshfs', async () => {
    const sandbox = new FakeMachine('ssh', [], false)
    const ws = workspace(sandbox)
    const agent = await ws.session('agent', { profile: 'agent' })
    const result = await agent.shell('python3 job.py')
    expect(result.exitCode).toBe(1)
    expect(DEC.decode(result.stderr)).toBe(`python3: fake: ${SSHFS_HINT}\n`)
    expect(sandbox.pipes).toEqual([])
    await ws.close()
  })

  it('drops a dead sshfs mount before serving', async () => {
    const sandbox = new FakeMachine('ssh')
    sandbox.table.set('/data', ['mirage-gone:/data', 'fuse.sshfs'])
    const ws = workspace(sandbox)
    const agent = await ws.session('agent', { profile: 'agent' })
    expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
    const drop = "fusermount3 -uz '/data' || fusermount -uz '/data'"
    expect(sandbox.commands.indexOf(drop)).toBeLessThan(
      sandbox.commands.indexOf(
        "mkdir -p '/data' 2>/dev/null || { sudo -n mkdir -p '/data' && " +
          `sudo -n chown "$(id -u):$(id -g)" '/data'; }`,
      ),
    )
    await ws.close()
  })

  const FOREIGN =
    'fake: another sshfs serves /data in this machine; give this workspace a machine of its own\n'

  it('takes back the sshfs a restarted instance of its workspace left', async () => {
    const first = new FakeMachine('ssh')
    const one = await workspace(first, [], undefined, undefined, 'w 1').session('agent', {
      profile: 'agent',
    })
    expect((await one.shell('python3 job.py')).exitCode).toBe(0)
    const stale = first.table.get('/data')?.[0] ?? ''
    expect(stale).toMatch(/^mirage-w_201\.box-[0-9a-f]{8}-1:\/data$/)
    // The host restarted: the first instance never closes, and its sshfs runs on.
    const second = sharing(first, 'ssh')
    const ws = workspace(second, [], undefined, undefined, 'w 1')
    const two = await ws.session('agent', { profile: 'agent' })
    expect((await two.shell('python3 job.py')).exitCode).toBe(0)
    const killed = second.commands.indexOf(killLine(stale))
    expect(killed).toBeGreaterThan(-1)
    expect(killed).toBeLessThan(
      second.commands.indexOf("fusermount3 -uz '/data' || fusermount -uz '/data'"),
    )
    expect(second.served()).toEqual(['/data', '/my notes'])
    // A kill the first instance started as it went lands late: it reaches
    // the sshfs it named, not the one the second serves the prefix with.
    const fresh = second.table.get('/data')?.[0] ?? ''
    expect(fresh).not.toBe(stale)
    await first.execLine(killLine(stale))
    expect(second.running.has(fresh)).toBe(true)
    await ws.close()
    expect(first.table.size).toBe(0)
  })

  it('releases the mounts a deleted workspace left', async () => {
    const first = new FakeMachine('ssh')
    const one = await workspace(first, [], undefined, undefined, 'w1').session('agent', {
      profile: 'agent',
    })
    expect((await one.shell('python3 job.py')).exitCode).toBe(0)
    const left = [...first.table.values()].map(([source]) => source)
    const others: [string, string][] = [
      ['/theirs', 'mirage-w2.box-0123abcd-1:/theirs'],
      ['/box2', 'mirage-w1.box2-0123abcd-1:/box2'],
    ]
    for (const [prefix, source] of others) {
      first.table.set(prefix, [source, 'fuse.sshfs'])
      first.running.add(source)
    }
    // The host restarted, and the workspace is deleted before it runs a line.
    const second = sharing(first, 'ssh')
    workspace(second, [], undefined, undefined, 'w1')
    await second.destroy()
    expect(left.map((s) => second.commands.includes(killLine(s)))).toEqual([true, true])
    expect([...second.table].map(([p, [s]]) => [p, s])).toEqual(others)
    expect([...second.running].sort()).toEqual(others.map(([, s]) => s).sort())
  })

  it('closes the connection its release opened on delete', async () => {
    const sandbox = new Counted('ssh')
    const ws = workspace(sandbox, [], undefined, undefined, 'w1')
    const agent = await ws.session('agent', { profile: 'agent' })
    expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
    await ws.delete()
    expect([sandbox.connects, sandbox.closes]).toEqual([2, 2])
  })

  it('releases on delete a mount its close could not unmount', async () => {
    const sandbox = new FakeMachine('ssh')
    const ws = workspace(sandbox, [], undefined, undefined, 'w1')
    const agent = await ws.session('agent', { profile: 'agent' })
    expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
    sandbox.refuseUnmount = true
    await ws.close()
    expect(sandbox.table.size).toBe(2)
    sandbox.refuseUnmount = false
    await sandbox.destroy()
    expect(sandbox.table.size).toBe(0)
  })

  it('lets an unanswered kill on delete go at its deadline', async () => {
    const sandbox = new FakeMachine('ssh')
    sandbox.table.set('/data', ['mirage-w1.box-0123abcd-1:/data', 'fuse.sshfs'])
    sandbox.hangKill = true
    workspace(sandbox, [], undefined, undefined, 'w1')
    const timeout = AbortSignal.timeout.bind(AbortSignal)
    const short = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation((ms) => timeout(ms === UNMOUNT_WAIT_SECONDS * 1000 ? 50 : ms))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await sandbox.destroy()
      expect(sandbox.killsStopped).toBe(1)
    } finally {
      short.mockRestore()
      warn.mockRestore()
    }
  })

  it("keeps a live workspace's own mounts through destroy", async () => {
    const sandbox = new FakeMachine('ssh')
    const ws = workspace(sandbox, [], undefined, undefined, 'w1')
    const agent = await ws.session('agent', { profile: 'agent' })
    expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
    const serving = [...sandbox.table]
    await sandbox.destroy()
    expect([...sandbox.table]).toEqual(serving)
    await ws.close()
    expect(sandbox.table.size).toBe(0)
  })

  it('tries every mount a deleted workspace left', async () => {
    const sandbox = new FakeMachine('ssh')
    sandbox.table.set('/data', ['mirage-w1.box-0123abcd-1:/data', 'fuse.sshfs'])
    sandbox.table.set('/more', ['mirage-w1.box-0123abcd-2:/more', 'fuse.sshfs'])
    sandbox.refuseUnmount = true
    workspace(sandbox, [], undefined, undefined, 'w1')
    await sandbox.destroy()
    const tried = sandbox.commands.filter((c) => c.startsWith('fusermount3 -uz '))
    expect(tried.map((c) => words(c)[2])).toEqual(['/data', '/more'])
  })

  it('fails loud when the mount a restarted instance left cannot be unmounted', async () => {
    const sandbox = new FakeMachine('ssh')
    sandbox.table.set('/data', ['mirage-w1.box-0123abcd-1:/data', 'fuse.sshfs'])
    sandbox.refuseUnmount = true
    const ws = workspace(sandbox, [], undefined, undefined, 'w1')
    const result = await (await ws.session('agent', { profile: 'agent' })).shell('python3 job.py')
    expect([result.exitCode, DEC.decode(result.stderr)]).toEqual([
      1,
      'python3: fake: cannot unmount /data, which this workspace served before a restart: fusermount: busy\n',
    ])
    expect(sandbox.pipes).toEqual([])
  })

  it("refuses, rather than takes, another machine entry's live sshfs on its sandbox", async () => {
    const first = new FakeMachine('ssh')
    const second = sharing(first, 'ssh', 'box2')
    const ws = new Workspace(
      { '/': new RAMVFS(), '/data': new RAMVFS() },
      {
        mode: MountMode.WRITE,
        workspaceId: 'w1',
        ...on(first),
        ...on(second),
        machines: { box: first, box2: second },
      },
    )
    expect((await ws.shell('python3 job.py')).exitCode).toBe(0)
    const mounted = new Map(first.table)
    const result = await ws.shell('python3 job.py', { machine: 'box2' })
    expect([result.exitCode, DEC.decode(result.stderr)]).toEqual([1, FOREIGN])
    expect(second.commands.filter((c) => c.startsWith('for p in /proc/'))).toEqual([])
    expect(first.table).toEqual(mounted)
    await ws.close()
  })

  it('refuses the live sshfs of a workspace whose id only starts like its own', async () => {
    const first = new FakeMachine('ssh')
    const second = sharing(first, 'ssh')
    const ws1 = workspace(first, [], undefined, undefined, 'w1-2')
    const ws2 = workspace(second, [], undefined, undefined, 'w1')
    const one = await ws1.session('agent', { profile: 'agent' })
    expect((await one.shell('python3 job.py')).exitCode).toBe(0)
    const mounted = new Map(first.table)
    const result = await (await ws2.session('agent', { profile: 'agent' })).shell('python3 job.py')
    expect([result.exitCode, DEC.decode(result.stderr)]).toEqual([1, FOREIGN])
    expect(second.commands.filter((c) => c.startsWith('for p in /proc/'))).toEqual([])
    expect(first.table).toEqual(mounted)
    await ws2.close()
    await ws1.close()
  })

  it('lets a second workspace on the machine unmount nothing', async () => {
    const first = new FakeMachine('ssh')
    const second = sharing(first, 'ssh')
    const [ws1, ws2] = [workspace(first), workspace(second)]
    const one = await ws1.session('agent', { profile: 'agent' })
    const two = await ws2.session('agent', { profile: 'agent' })
    expect((await one.shell('python3 job.py')).exitCode).toBe(0)
    const mounted = new Map(first.table)
    const result = await two.shell('python3 job.py')
    expect(result.exitCode).toBe(1)
    expect(DEC.decode(result.stderr)).toBe(FOREIGN)
    expect(second.pipes).toEqual([])
    expect(first.table).toEqual(mounted)
    expect((await one.shell('python3 job.py')).exitCode).toBe(0)
    await ws2.close()
    expect(first.table).toEqual(mounted)
    await ws1.close()
    expect(first.table.size).toBe(0)
  })

  it('leaves the mount that replaced an ended server when dropping it', async () => {
    const first = new FakeMachine('ssh')
    const second = sharing(first, 'ssh')
    const [ws1, ws2] = [workspace(first), workspace(second)]
    const one = await ws1.session('agent', { profile: 'agent' })
    const two = await ws2.session('agent', { profile: 'agent' })
    expect((await one.shell('python3 job.py')).exitCode).toBe(0)
    first.sshfsExits('/data')
    first.sshfsExits('/my notes')
    await until(() => true)
    expect((await two.shell('python3 job.py')).exitCode).toBe(0)
    const mounted = new Map(first.table)
    for (let line = 0; line < 2; line++) {
      const result = await one.shell('python3 job.py')
      expect(result.exitCode).toBe(1)
      expect(DEC.decode(result.stderr)).toBe(FOREIGN)
    }
    expect(first.table).toEqual(mounted)
    await ws1.close()
    expect(first.table).toEqual(mounted)
    await ws2.close()
  })

  it('leaves the next line checking after a check that fails', async () => {
    const first = new FakeMachine('ssh')
    const second = sharing(first, 'ssh')
    const [ws1, ws2] = [workspace(first), workspace(second)]
    const one = await ws1.session('agent', { profile: 'agent' })
    const two = await ws2.session('agent', { profile: 'agent' })
    expect((await one.shell('python3 job.py')).exitCode).toBe(0)
    first.sshfsExits('/data')
    first.sshfsExits('/my notes')
    expect((await two.shell('python3 job.py')).exitCode).toBe(0)
    first.failCheck = true
    const failed = await one.shell('python3 job.py')
    expect(failed.exitCode).toBe(1)
    expect(DEC.decode(failed.stderr)).toContain('cannot tell whether')
    first.failCheck = false
    const result = await one.shell('python3 job.py')
    expect(result.exitCode).toBe(1)
    expect(DEC.decode(result.stderr)).toBe(FOREIGN)
    await ws1.close()
    await ws2.close()
  })

  it("takes no other workspace's sshfs for its own under both", async () => {
    const first = new FakeMachine('ssh')
    const second = sharing(first, 'both')
    const [ws1, ws2] = [workspace(first), workspace(second)]
    const one = await ws1.session('agent', { profile: 'agent' })
    const two = await ws2.session('agent', { profile: 'agent' })
    expect((await one.shell('python3 job.py')).exitCode).toBe(0)
    const result = await two.shell('python3 job.py')
    expect(result.exitCode).toBe(1)
    expect(DEC.decode(result.stderr)).toBe(FOREIGN)
    await ws2.close()
    await ws1.close()
  })

  it.each(['both', 'own'] as const)(
    'refuses a line under %s while a hidden mount is the machine own',
    async (mountType) => {
      const sandbox = new FakeMachine(mountType, ['/data'])
      const ws = workspace(sandbox, ['/data'])
      const agent = await ws.session('agent', { profile: 'agent' })
      const result = await agent.shell('python3 job.py')
      expect(result.exitCode).toBe(126)
      expect(DEC.decode(result.stderr)).toBe('fake: Permission denied\n')
      await ws.close()
    },
  )

  it('refuses a line while a mode cap covers a prefix the machine serves', async () => {
    const sandbox = new FakeMachine('both', ['/data'])
    const ws = workspace(sandbox, [], new Map([['/data/sub', { mode: MountMode.READ }]]))
    const agent = await ws.session('agent', { profile: 'agent' })
    const result = await agent.shell('python3 job.py')
    expect(result.exitCode).toBe(126)
    expect(DEC.decode(result.stderr)).toBe('fake: Permission denied\n')
    await ws.close()
  })

  it.each(['both', 'own'] as const)(
    'refuses a shown read-only path on a sandbox-owned mount under %s',
    async (mountType) => {
      const sandbox = new FakeMachine(mountType, ['/data'])
      const ws = workspace(sandbox)
      try {
        const agent = await ws.session('agent', {
          profile: { paths: { hide: [], show: [{ path: '/data/locked', mode: MountMode.READ }] } },
        })
        const result = await agent.shell('python3 job.py')
        expect(result.exitCode).toBe(126)
        expect(DEC.decode(result.stderr)).toBe('fake: Permission denied\n')
        expect(sandbox.commands).not.toContain('python3 job.py')
      } finally {
        await ws.close()
      }
    },
  )

  it('serves the live session to a line with its own cwd', async () => {
    sessions.length = 0
    const sandbox = new FakeMachine('ssh')
    const ws = workspace(sandbox)
    await ws.session('agent', { profile: 'agent' })
    const result = await ws.shell('python3 job.py', { sessionId: 'agent', cwd: '/data' })
    expect(result.exitCode).toBe(0)
    expect(sessions).toHaveLength(2)
    for (const session of sessions) expect(session).toBe(ws.getSession('agent'))
    await ws.close()
  })

  it('runs a server outside the line that started it', async () => {
    const bound: unknown[] = []
    registerPipeServer('ssh', (files, session) => ({
      ...drain(files, session),
      serve: async (reader) => {
        bound.push([getCurrentSession(), getAdmission(), lineRunning()])
        const chunks = reader.getReader()
        while (!(await chunks.read()).done) continue
      },
    }))
    try {
      const sandbox = new FakeMachine('ssh')
      const ws = workspace(sandbox)
      const agent = await ws.session('agent', { profile: 'agent' })
      expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
      expect(bound).toEqual([
        [null, null, false],
        [null, null, false],
      ])
      await ws.close()
    } finally {
      registerPipeServer('ssh', drain)
    }
  })

  it('returns a line once every server has landed', async () => {
    // sshfs sends the close that lands a line's writes after the line has
    // ended, so the line lands them itself, one server at a time, outside
    // the line but with its write admission: a capture waiting for the
    // line lets those writes through. Served requests run on that
    // admission until the line has landed them, the line waits out the
    // ones still running, and none run on it after.
    const holds: (() => void)[] = []
    const landed: [boolean, boolean][] = []
    const runs: ((op: () => Promise<void>) => Promise<void>)[] = []
    registerPipeServer('ssh', (files, session, run) => {
      runs.push(run)
      return {
        ...drain(files, session),
        sync: async () => {
          // It lands at its program's exit (held here), and again as it ends.
          if (landed.length < 2) await new Promise<void>((resolve) => holds.push(resolve))
          await files.write('/data/landed.txt', 'x')
          landed.push([lineRunning(), await lentALine(run)])
          return []
        },
      }
    })
    try {
      const ws = workspace(new FakeMachine('ssh'))
      const agent = await ws.session('agent', { profile: 'agent' })
      let done = false
      const line = agent.shell('python3 job.py').finally(() => {
        done = true
      })
      await until(() => holds.length === 1)
      const capture = ws.snapshot()
      await until(() => (ws as unknown as { capturing: boolean }).capturing)
      holds[0]?.()
      await until(() => holds.length === 2)
      expect(done).toBe(false)
      let still = (): void => undefined
      const borrowed = runs[0]?.(
        () =>
          new Promise<void>((resolve) => {
            still = resolve
          }),
      )
      holds[1]?.()
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(done).toBe(false)
      still()
      expect((await line).exitCode).toBe(0)
      await capture
      await borrowed
      expect(landed).toEqual(Array(4).fill([false, true]))
      expect(await Promise.all(runs.map(lentALine))).toEqual([false, false])
      await ws.close()
    } finally {
      registerPipeServer('ssh', drain)
    }
  })

  it.each([
    ['python3 job.py', true, 1, LOST],
    ['python3 fails.py', true, 3, `boom\n${LOST}`],
    ['python3 job.py', false, 0, ''],
  ])(
    'fails the line with a landing that failed: %s lost=%s',
    async (line, lost, status, stderr) => {
      // sshfs lands a file's writes after close(2) told the program they
      // were done, so the line reports each landing that failed, on every
      // served prefix, keeping a failing program's own status.
      const failures: [string, unknown][][] = [
        [['/my notes/b.txt', edquot('/my notes/b.txt')]],
        [['/data/a.bin', edquot('/data/a.bin')]],
      ]
      registerPipeServer('ssh', (files, session) => ({
        ...drain(files, session),
        sync: () => Promise.resolve((lost ? failures.pop() : undefined) ?? []),
      }))
      try {
        const ws = workspace(new FakeMachine('ssh'))
        const agent = await ws.session('agent', { profile: 'agent' })
        const result = await agent.shell(line)
        expect([result.exitCode, DEC.decode(result.stderr)]).toEqual([status, stderr])
        expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
        await ws.close()
      } finally {
        registerPipeServer('ssh', drain)
      }
    },
  )

  it('lands the writes of a line that times out', async () => {
    // Its status stays the timeout's; a landing that fails is logged.
    const synced: boolean[] = []
    registerPipeServer('ssh', (files, session) => ({
      ...drain(files, session),
      sync: () => {
        synced.push(lineRunning())
        return Promise.resolve(
          synced.length > 1 ? [] : [['/data/a.bin', edquot('/data/a.bin')] as [string, unknown]],
        )
      },
    }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const ws = workspace(new FakeMachine('ssh'), [], undefined, {
        '@line': new Limit({ timeoutSeconds: 0.05 }),
      })
      const agent = await ws.session('agent', { profile: 'agent' })
      const result = await agent.shell('python3 slow.py')
      expect(result.exitCode).toBe(124)
      expect(DEC.decode(result.stderr)).not.toContain('Disk quota exceeded')
      expect(synced).toEqual([false, false])
      expect(warn).toHaveBeenCalledWith('fake: /data/a.bin: Disk quota exceeded')
      await ws.close()
    } finally {
      warn.mockRestore()
      registerPipeServer('ssh', drain)
    }
  })

  it('logs what a landing the deadline stopped could not land', async () => {
    // One prefix's landing failed and the next one ran out the deadline: the
    // line hears of neither, so the failure that came back is logged.
    let calls = 0
    registerPipeServer('ssh', (files, session) => ({
      ...drain(files, session),
      sync: async () => {
        calls += 1
        if (calls === 1) return [['/data/a.bin', edquot('/data/a.bin')] as [string, unknown]]
        if (calls === 2) await new Promise((resolve) => setTimeout(resolve, 200))
        return []
      },
    }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const ws = workspace(new FakeMachine('ssh'), [], undefined, {
        '@line': new Limit({ timeoutSeconds: 0.05 }),
      })
      const agent = await ws.session('agent', { profile: 'agent' })
      expect((await agent.shell('python3 job.py')).exitCode).toBe(124)
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(warn).toHaveBeenCalledWith('fake: /data/a.bin: Disk quota exceeded')
      await ws.close()
    } finally {
      warn.mockRestore()
      registerPipeServer('ssh', drain)
    }
  })

  it('lands again a landing the deadline stopped', async () => {
    // The landing at the program's exit counts against the line's deadline;
    // one the deadline stops is landed again before the line returns.
    const synced: boolean[] = []
    registerPipeServer('ssh', (files, session) => ({
      ...drain(files, session),
      sync: async () => {
        synced.push(lineRunning())
        if (synced.length === 1) await new Promise((resolve) => setTimeout(resolve, 300))
        return []
      },
    }))
    try {
      const ws = workspace(new FakeMachine('ssh'), [], undefined, {
        '@line': new Limit({ timeoutSeconds: 0.05 }),
      })
      const agent = await ws.session('agent', { profile: 'agent' })
      expect((await agent.shell('python3 job.py')).exitCode).toBe(124)
      expect(synced).toEqual([false, false, false])
      await ws.close()
    } finally {
      registerPipeServer('ssh', drain)
    }
  })

  it('fails loud on a mount of its own under a served prefix', async () => {
    const sandbox = new FakeMachine('both', ['/data/sub'])
    const ws = workspace(sandbox)
    const agent = await ws.session('agent', { profile: 'agent' })
    const result = await agent.shell('python3 job.py')
    expect(result.exitCode).toBe(1)
    expect(DEC.decode(result.stderr)).toBe(
      'python3: fake: the machine mounts /data/sub itself, and serving /data would cover it\n',
    )
    expect(sandbox.pipes).toEqual([])
    await ws.close()
  })

  it('fails loud on a local path under a served prefix', async () => {
    const sandbox = new FakeMachine('ssh')
    const ws = new Workspace(
      { '/': new RAMVFS(), '/data': new RAMVFS(), '/data/native': `@${sandbox.name}` },
      { mode: MountMode.WRITE, profiles: { agent: { paths: { hide: [] } } }, ...on(sandbox) },
    )
    const agent = await ws.session('agent', { profile: 'agent' })
    const result = await agent.shell('python3 job.py')
    expect(result.exitCode).toBe(1)
    expect(DEC.decode(result.stderr)).toBe(
      'python3: fake: the machine mounts /data/native itself, and serving /data would cover it\n',
    )
    expect(sandbox.pipes).toEqual([])
    await ws.close()
  })

  it('serves a mount added later on the next line', async () => {
    const sandbox = new FakeMachine('ssh')
    const ws = workspace(sandbox)
    const agent = await ws.session('agent', { profile: 'agent' })
    expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
    ws.addMount('/extra', new RAMVFS(), MountMode.WRITE)
    expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
    expect(sandbox.served()).toEqual(['/data', '/my notes', '/extra'])
    await ws.close()
  })

  it('starts a server that ended again', async () => {
    const sandbox = new FakeMachine('ssh')
    const ws = workspace(sandbox)
    const agent = await ws.session('agent', { profile: 'agent' })
    expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
    sandbox.ends.get('/data')?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
    expect(sandbox.served()).toEqual(['/data', '/my notes', '/data'])
    await ws.close()
  })

  it.each([
    ['fails', () => Promise.reject(new Error('no server here'))],
    ['ends', () => Promise.resolve()],
  ])('never takes a mount whose server %s before it shows', async (_, serve) => {
    registerPipeServer('ssh', (files, session) => ({ ...drain(files, session), serve }))
    try {
      const sandbox = new FakeMachine('ssh')
      const ws = workspace(sandbox)
      const agent = await ws.session('agent', { profile: 'agent' })
      const result = await agent.shell('python3 job.py')
      expect(result.exitCode).toBe(1)
      expect(DEC.decode(result.stderr)).toContain('fake: sshfs did not mount /data')
      expect(sandbox.commands).not.toContain('python3 job.py')
      expect(sandbox.table.has('/data')).toBe(false)
      expect(sandbox.stopped).toContain('/data')
      await ws.close()
    } finally {
      registerPipeServer('ssh', drain)
    }
  })

  it('kills the sshfs of a mount whose server ended', async () => {
    // A program blocked on a mount nobody answers is freed while its line
    // runs; the next line unmounts the mount and serves the prefix again.
    const sandbox = new FakeMachine('ssh')
    const ws = workspace(sandbox)
    await ws.session('agent', { profile: 'agent' })
    const abort = new AbortController()
    const line = ws
      .shell('python3 slow.py', { sessionId: 'agent', signal: abort.signal })
      .catch(() => undefined)
    await until(() => sandbox.commands.includes('python3 slow.py'))
    const source = sandbox.table.get('/data')?.[0] ?? ''
    sandbox.ends.get('/data')?.()
    await until(() => !sandbox.running.has(source))
    const killed = sandbox.commands.indexOf(killLine(source))
    expect(killed).toBeGreaterThan(-1)
    abort.abort()
    await line
    expect((await ws.shell('python3 job.py', { sessionId: 'agent' })).exitCode).toBe(0)
    expect(
      sandbox.commands.indexOf("fusermount3 -uz '/data' || fusermount -uz '/data'"),
    ).toBeGreaterThan(killed)
    expect(sandbox.served()).toEqual(['/data', '/my notes', '/data'])
    expect(sandbox.table.get('/data')?.[0]).not.toBe(source)
    await ws.close()
  })

  // With no work on the machine no program of Mirage's is blocked, and the
  // server most likely ended as the machine paused itself: nothing runs
  // there until the next line unmounts the sshfs and serves the prefix again.
  it('kills nothing when a server ends with no work on the machine', async () => {
    const sandbox = new FakeMachine('ssh')
    const ws = workspace(sandbox)
    const agent = await ws.session('agent', { profile: 'agent' })
    expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
    const source = sandbox.table.get('/data')?.[0] ?? ''
    sandbox.ends.get('/data')?.()
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(sandbox.commands).not.toContain(killLine(source))
    expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
    expect(sandbox.served()).toEqual(['/data', '/my notes', '/data'])
    await ws.close()
  })

  it('warns when the sshfs of an ended server cannot be killed', async () => {
    const sandbox = new FakeMachine('ssh')
    sandbox.failKill = true
    const ws = workspace(sandbox)
    const agent = await ws.session('agent', { profile: 'agent' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const line = await endedInALine(sandbox, ws)
      await until(() => warn.mock.calls.length > 0)
      expect(warn).toHaveBeenCalledWith(
        'fake: killing the sshfs for /data failed:',
        expect.any(Error),
      )
      await line.stop()
      expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
    } finally {
      warn.mockRestore()
      await ws.close()
    }
  })

  it('runs the next line while the kill of an ended server is unanswered', async () => {
    const sandbox = new FakeMachine('ssh')
    sandbox.hangKill = true
    const ws = workspace(sandbox)
    const agent = await ws.session('agent', { profile: 'agent' })
    const line = await endedInALine(sandbox, ws)
    await until(() => sandbox.commands.some((c) => c.startsWith('for p in /proc/[0-9]*')))
    await line.stop()
    expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
    expect(sandbox.served()).toEqual(['/data', '/my notes', '/data'])
    await ws.close()
  })

  it('lets go of an unanswered kill at its deadline, warning', async () => {
    const sandbox = new FakeMachine('ssh')
    sandbox.hangKill = true
    const ws = workspace(sandbox)
    await ws.session('agent', { profile: 'agent' })
    const timeout = AbortSignal.timeout.bind(AbortSignal)
    const short = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation((ms) => timeout(ms === UNMOUNT_WAIT_SECONDS * 1000 ? 50 : ms))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const line = await endedInALine(sandbox, ws)
      await until(() => warn.mock.calls.length > 0)
      expect(sandbox.killsStopped).toBe(1)
      expect(warn).toHaveBeenCalledWith(
        'fake: killing the sshfs for /data failed:',
        expect.anything(),
      )
      await line.stop()
    } finally {
      short.mockRestore()
      warn.mockRestore()
      await ws.close()
    }
  })

  it('lets go of an unanswered kill when the mounts close, quietly', async () => {
    const sandbox = new FakeMachine('ssh')
    sandbox.hangKill = true
    const ws = workspace(sandbox)
    await ws.session('agent', { profile: 'agent' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const line = await endedInALine(sandbox, ws)
      await until(() => sandbox.commands.some((c) => c.startsWith('for p in /proc/[0-9]*')))
      await line.stop()
      await ws.close()
      await until(() => sandbox.killsStopped === 1)
      expect(warn.mock.calls.filter(([said]) => String(said).includes('killing'))).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })

  it('never kills the sshfs serving a prefix again with a kill that lands late', async () => {
    // Each serve's sshfs carries a source of its own, so the ended one's kill
    // reaches only it.
    const sandbox = new FakeMachine('ssh')
    sandbox.killMs = 50
    const ws = workspace(sandbox)
    const agent = await ws.session('agent', { profile: 'agent' })
    const line = await endedInALine(sandbox, ws)
    const source = sandbox.table.get('/data')?.[0] ?? ''
    await until(() => sandbox.commands.includes(killLine(source)))
    await line.stop()
    expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
    const again = sandbox.table.get('/data')?.[0] ?? ''
    expect(again).not.toBe(source)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(sandbox.running.has(again)).toBe(true)
    expect(sandbox.running.has(source)).toBe(false)
    await ws.close()
  })

  // A restart after the line was admitted took the machine's mounts while
  // the host still serves them: the line never runs over the bare
  // directories, and the next one serves them again.
  it('never runs a line over mounts the machine lost', async () => {
    const sandbox = new FakeMachine('ssh')
    const ws = workspace(sandbox)
    const agent = await ws.session('agent', { profile: 'agent' })
    expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
    sandbox.table.clear()
    sandbox.running.clear()
    const result = await agent.shell('python3 lost.py')
    expect([result.exitCode, DEC.decode(result.stderr)]).toEqual([126, lost('/data')])
    expect(sandbox.commands).not.toContain('python3 lost.py')
    expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
    expect(sandbox.served()).toEqual(['/data', '/my notes', '/data', '/my notes'])
    await ws.close()
  })

  // A mount the machine put over a served prefix is left alone: ending the
  // sshfs under it would take it down too.
  it('leaves a mount over a served prefix alone', async () => {
    const sandbox = new FakeMachine('ssh')
    const ws = workspace(sandbox)
    const agent = await ws.session('agent', { profile: 'agent' })
    expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
    const ours = sandbox.table.get('/data') ?? ['', '']
    sandbox.table.set('/data', [ours[0], 'fuse'])
    const first = await agent.shell('python3 covered.py')
    expect([first.exitCode, DEC.decode(first.stderr)]).toEqual([126, lost('/data')])
    const second = await agent.shell('python3 covered.py')
    expect([second.exitCode, DEC.decode(second.stderr)]).toEqual([
      1,
      'fake: another mount covers /data in this machine; the line did not run\n',
    ])
    expect(sandbox.commands).not.toContain('python3 covered.py')
    expect(sandbox.stopped).toEqual([])
    expect(sandbox.served()).toEqual(['/data', '/my notes'])
    sandbox.table.set('/data', ours)
    expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
    await ws.close()
  })

  // The sandbox mounts its own prefix again once it is back (its entrypoint
  // does): serving it meanwhile would leave the host's sshfs under that mount.
  it.each(['own', 'both'] as const)(
    'waits for a mount of its own it lost (%s)',
    async (mountType) => {
      const sandbox = new FakeMachine(mountType, ['/data'])
      const ws = workspace(sandbox)
      const agent = await ws.session('agent', { profile: 'agent' })
      expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
      const pipes = [...sandbox.pipes]
      sandbox.table.delete('/data')
      for (let i = 0; i < 2; i++) {
        const result = await agent.shell('python3 lost.py')
        expect([result.exitCode, DEC.decode(result.stderr)]).toEqual([126, lost('/data')])
      }
      expect(sandbox.commands).not.toContain('python3 lost.py')
      expect(sandbox.pipes).toEqual(pipes)
      sandbox.table.set('/data', ['tmpfs', 'tmpfs'])
      expect((await agent.shell('python3 back.py')).exitCode).toBe(0)
      expect(sandbox.commands).toContain('python3 back.py')
      expect(sandbox.pipes).toEqual(pipes)
      await ws.close()
    },
  )

  it.each(['own', 'both'] as const)(
    'refuses a line once its own /tmp mount is gone (%s)',
    async (mountType) => {
      const sandbox = new FakeMachine(mountType, ['/tmp'])
      const ws = new Workspace(
        { '/': new RAMVFS(), '/data': new RAMVFS(), '/tmp': new RAMVFS() },
        { mode: MountMode.WRITE, ...on(sandbox) },
      )
      expect((await ws.shell('python3 job.py')).exitCode).toBe(0)
      sandbox.table.delete('/tmp')
      const result = await ws.shell('python3 lost.py')
      expect([result.exitCode, DEC.decode(result.stderr)]).toEqual([126, lost('/tmp')])
      expect(sandbox.commands).not.toContain('python3 lost.py')
      await ws.close()
    },
  )

  it('serves a prefix with a hash and runs its lines', async () => {
    const sandbox = new FakeMachine('ssh')
    const ws = workspace(sandbox)
    ws.addMount('/a#b', new RAMVFS(), MountMode.WRITE)
    const agent = await ws.session('agent', { profile: 'agent' })
    for (let i = 0; i < 2; i++) expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
    expect(sandbox.served()).toContain('/a#b')
    await ws.close()
  })

  // Under fuse the mounts are read again on each line until the machine holds
  // every prefix, so one it mounts late is guarded too; then once per change.
  it.each([
    [['/data', '/my notes'], 1],
    [['/data'], 3],
  ])('reads the mounts over fuse until the machine holds them all (%j)', async (own, reads) => {
    const sandbox = new FakeMachine('own', own)
    const ws = workspace(sandbox)
    const agent = await ws.session('agent', { profile: 'agent' })
    for (let i = 0; i < 3; i++) expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
    expect(sandbox.commands.filter((c) => c === 'cat /proc/mounts')).toHaveLength(reads)
    await ws.close()
  })

  it('guards a mount the machine lays after the first line over fuse', async () => {
    const sandbox = new FakeMachine('own')
    const ws = workspace(sandbox)
    const agent = await ws.session('agent', { profile: 'agent' })
    expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
    sandbox.table.set('/data', ['tmpfs', 'tmpfs'])
    expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
    sandbox.table.delete('/data')
    const result = await agent.shell('python3 lost.py')
    expect([result.exitCode, DEC.decode(result.stderr)]).toEqual([126, lost('/data')])
    expect(sandbox.commands).not.toContain('python3 lost.py')
    await ws.close()
  })

  // A cover over a served prefix whose server ended is left alone too:
  // serving again would mount the host's sshfs over the machine's mount.
  it('leaves a cover over an ended server alone', async () => {
    const sandbox = new FakeMachine('ssh')
    const ws = workspace(sandbox)
    const agent = await ws.session('agent', { profile: 'agent' })
    expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
    sandbox.ends.get('/data')?.()
    sandbox.table.set('/data', ['tmpfs', 'tmpfs'])
    await new Promise((resolve) => setTimeout(resolve, 10))
    const result = await agent.shell('python3 covered.py')
    expect([result.exitCode, DEC.decode(result.stderr)]).toEqual([
      1,
      'fake: another mount covers /data in this machine; the line did not run\n',
    ])
    expect(sandbox.table.get('/data')).toEqual(['tmpfs', 'tmpfs'])
    expect(sandbox.served()).toEqual(['/data', '/my notes'])
    await ws.close()
  })

  // A mount the machine held at a prefix before it was served is no cover:
  // once the server ends it shows again, and the prefix is served over it.
  it("serves again a prefix served over a mount of the machine's", async () => {
    const sandbox = new FakeMachine('ssh')
    sandbox.table.set('/data', ['vol', 'ext4'])
    const ws = workspace(sandbox)
    const agent = await ws.session('agent', { profile: 'agent' })
    expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
    sandbox.ends.get('/data')?.()
    sandbox.table.set('/data', ['vol', 'ext4'])
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect((await agent.shell('python3 again.py')).exitCode).toBe(0)
    expect(sandbox.served()).toEqual(['/data', '/my notes', '/data'])
    await ws.close()
  })

  // While its server still runs, a mount laid over a prefix is a cover even
  // when it looks like the one the prefix was served over.
  it('leaves a cover like the mount under a live server alone', async () => {
    const sandbox = new FakeMachine('ssh')
    sandbox.table.set('/data', ['tmpfs', 'tmpfs'])
    const ws = workspace(sandbox)
    const agent = await ws.session('agent', { profile: 'agent' })
    expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
    sandbox.table.set('/data', ['tmpfs', 'tmpfs'])
    const first = await agent.shell('python3 covered.py')
    expect([first.exitCode, DEC.decode(first.stderr)]).toEqual([126, lost('/data')])
    expect((await agent.shell('python3 covered.py')).exitCode).toBe(1)
    expect(sandbox.stopped).toEqual([])
    expect(sandbox.served()).toEqual(['/data', '/my notes'])
    await ws.close()
  })

  // A covered prefix the workspace no longer mounts is dropped, not refused.
  it('does not refuse a covered prefix the workspace dropped', async () => {
    const sandbox = new FakeMachine('ssh')
    const ws = workspace(sandbox)
    const agent = await ws.session('agent', { profile: 'agent' })
    expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
    sandbox.table.set('/my notes', [sandbox.table.get('/my notes')?.[0] ?? '', 'fuse'])
    await ws.unmount('/my notes')
    for (let i = 0; i < 2; i++) expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
    await ws.close()
  })

  // A mount the workspace dropped is no longer the machine's to wait for, and
  // one added again at that prefix starts afresh.
  it.each(['own', 'both'] as const)(
    'does not wait for a mount the workspace dropped (%s)',
    async (mountType) => {
      const sandbox = new FakeMachine(mountType, ['/my notes'])
      const ws = workspace(sandbox)
      const agent = await ws.session('agent', { profile: 'agent' })
      expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
      sandbox.table.delete('/my notes')
      await ws.unmount('/my notes')
      expect((await agent.shell('python3 gone.py')).exitCode).toBe(0)
      ws.addMount('/my notes', new RAMVFS(), MountMode.WRITE)
      expect((await agent.shell('python3 again.py')).exitCode).toBe(0)
      await ws.close()
    },
  )

  it('runs lines unguarded in a sandbox holding no mount', async () => {
    const sandbox = new FakeMachine('own')
    const ws = workspace(sandbox)
    const agent = await ws.session('agent', { profile: 'agent' })
    expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
    expect(sandbox.guards).toEqual([])
    await ws.close()
  })

  it('stops a pipe whose unmount failed', async () => {
    const sandbox = new FakeMachine('ssh')
    const ws = workspace(sandbox)
    const agent = await ws.session('agent', { profile: 'agent' })
    expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
    sandbox.failUnmount = true
    await ws.close()
    expect(sandbox.stopped).toEqual(['/data', '/my notes'])
  })

  it('unmounts on close when the mount table cannot be read', async () => {
    const sandbox = new FakeMachine('ssh')
    const ws = workspace(sandbox)
    const agent = await ws.session('agent', { profile: 'agent' })
    expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
    sandbox.failTable = true
    await ws.close()
    expect(sandbox.table.size).toBe(0)
    expect(sandbox.stopped).toEqual(['/data', '/my notes'])
  })

  it('keeps pipe diagnostics when the guest goes away during a mount', async () => {
    class UnavailableMachine extends FakeMachine {
      override execLine(
        line: string,
        stdin: ByteSource | null,
        env: Record<string, string>,
        cwd: string,
      ) {
        if (this.pipes.length > 0 && line === 'cat /proc/mounts')
          return Promise.reject(new Error('guest unavailable'))
        return super.execLine(line, stdin, env, cwd)
      }

      override async openPipe(command: string) {
        const pipe = await super.openPipe(command)
        pipe.diagnostic = () => Promise.resolve('msb refused: sandbox is not running')
        return pipe
      }
    }
    const ws = workspace(new UnavailableMachine('ssh', [], true, false))
    try {
      const result = await ws.shell('python3 job.py')
      expect(result.exitCode).toBe(1)
      const said = DEC.decode(result.stderr)
      expect(said).toContain('guest unavailable')
      expect(said).toContain('helper said: msb refused: sandbox is not running')
    } finally {
      await ws.close()
    }
  })

  it('says why a server that fails did', async () => {
    registerPipeServer('ssh', (files, session) => ({
      ...drain(files, session),
      serve: () => Promise.reject(new Error('no server here')),
    }))
    try {
      const sandbox = new FakeMachine('ssh', [], true, false)
      const ws = workspace(sandbox)
      const agent = await ws.session('agent', { profile: 'agent' })
      const result = await agent.shell('python3 job.py')
      expect(result.exitCode).toBe(1)
      expect(DEC.decode(result.stderr)).toContain('the file server failed: no server here')
      await ws.close()
    } finally {
      registerPipeServer('ssh', drain)
    }
  })

  it('lets go of its setup when the line is aborted', async () => {
    const sandbox = new FakeMachine('ssh')
    sandbox.hang = true
    const ws = workspace(sandbox)
    await ws.session('agent', { profile: 'agent' })
    const abort = new AbortController()
    const running = ws.shell('python3 job.py', { sessionId: 'agent', signal: abort.signal })
    await new Promise((resolve) => setTimeout(resolve, 10))
    abort.abort()
    await expect(running).rejects.toThrow()
    sandbox.hang = false
    expect((await ws.shell('python3 job.py', { sessionId: 'agent' })).exitCode).toBe(0)
    await ws.close()
  })
})

describe('MachineMounts on a Mac', () => {
  it('mounts each prefix where its root link leads', async () => {
    const mac = new FakeMac('mirage', ['/data', '/my notes'])
    const ws = workspace(mac)
    const agent = await ws.session('agent', { profile: 'agent' })
    const result = await agent.shell('python3 job.py')
    expect([result.exitCode, DEC.decode(result.stdout)]).toEqual([0, 'ran\n'])
    const points = ['/home/u/.mirage/mnt/data', '/home/u/.mirage/mnt/my notes']
    expect([...mac.table.keys()].sort()).toEqual(points)
    expect(mac.served()).toEqual(points)
    expect(mac.guards[0]?.filter((_, i) => i % 4 === 0)).toEqual(points)
    expect(mac.guards[0]?.filter((_, i) => i % 4 === 2)).toEqual(['macfuse', 'macfuse'])
    await ws.close()
    expect(mac.table.size).toBe(0)
  })

  it("finds only the workspace's own mounts in mount's table", () => {
    const text =
      'mirage-w1.box-0123abcd-1:/data on /home/u/.mirage/mnt/data (macfuse, nodev)\n' +
      'mirage-w2.box-0123abcd-1:/other on /home/u/.mirage/mnt/other (macfuse)\n' +
      'mirage-w1.box-0123abcd-2:/my notes on /home/u/.mirage/mnt/my notes (macfuse)\n' +
      'mirage-w1.box-0123abcd-3:/tmp/a on /b on /home/u/.mirage/mnt/x (macfuse)\n' +
      '/dev/disk1s1 on / (apfs, local)\n'
    expect([...darwinLeft(text, 'mirage-w1.box')].sort()).toEqual([
      '/data',
      '/my notes',
      '/tmp/a',
      '/tmp/a on /b',
    ])
  })

  it('releases the mounts a deleted workspace left', async () => {
    const first = new FakeMac('mirage', ['/data', '/my notes'])
    const one = await workspace(first, [], undefined, undefined, 'w1').session('agent', {
      profile: 'agent',
    })
    expect((await one.shell('python3 job.py')).exitCode).toBe(0)
    expect(first.table.size).toBe(2)
    // The host restarted, and the workspace is deleted before it runs a line.
    const second = new FakeMac('mirage', ['/data', '/my notes'])
    second.table = first.table
    second.running = first.running
    workspace(second, [], undefined, undefined, 'w1')
    await second.destroy()
    expect([first.table.size, first.running.size]).toEqual([0, 0])
  })

  it('names the commands that make a root link it lacks', async () => {
    const mac = new FakeMac('mirage')
    const ws = workspace(mac)
    const agent = await ws.session('agent', { profile: 'agent' })
    const result = await agent.shell('python3 job.py')
    expect(result.exitCode).toBe(1)
    expect(DEC.decode(result.stderr)).toBe(
      `python3: ${darwinAdminHint('fake', '/data', '/home/u/.mirage/mnt')}\n`,
    )
    expect(mac.pipes).toEqual([])
    await ws.close()
  })

  it('refuses a line once its mount is gone', async () => {
    const mac = new FakeMac('mirage', ['/data', '/my notes'])
    const ws = workspace(mac)
    const agent = await ws.session('agent', { profile: 'agent' })
    expect((await agent.shell('python3 job.py')).exitCode).toBe(0)
    mac.table.delete('/home/u/.mirage/mnt/data')
    const result = await agent.shell('python3 job.py')
    expect(result.exitCode).toBe(126)
    expect(DEC.decode(result.stderr)).toBe(
      'fake: /data is no longer mounted in the machine (did it restart?); the line did not run\n',
    )
    await ws.close()
  })

  it('tells a source a workspace names', () => {
    expect(mirageSource('w1-box-0a1b2c3d-4:/data', '/data')).toBe(true)
    expect(mirageSource('w1-box-0a1b2c3d-4:/data', '/other')).toBe(false)
    expect(mirageSource('cryptomator@vault:/data', '/data')).toBe(false)
    expect(mirageSource('-0a1b2c3d-4:/data', '/data')).toBe(false)
  })

  it('leaves a macFUSE mount no workspace made', async () => {
    const mac = new FakeMac('mirage', ['/data', '/my notes'])
    mac.table.set('/home/u/.mirage/mnt/data', ['vault', 'macfuse'])
    const ws = workspace(mac)
    const agent = await ws.session('agent', { profile: 'agent' })
    const result = await agent.shell('python3 job.py')
    expect([result.exitCode, DEC.decode(result.stderr)]).toEqual([
      1,
      'fake: another macFUSE mount serves /data in this machine; ' +
        'give this workspace a machine of its own\n',
    ])
    expect(Object.fromEntries(mac.table)).toEqual({
      '/home/u/.mirage/mnt/data': ['vault', 'macfuse'],
    })
    expect(mac.commands.filter((c) => c.startsWith('umount'))).toEqual([])
    await ws.close()
  })

  it('takes no ssh mount', async () => {
    const mac = new FakeMac('ssh', ['/data', '/my notes'])
    const ws = workspace(mac)
    const agent = await ws.session('agent', { profile: 'agent' })
    const result = await agent.shell('python3 job.py')
    expect(result.exitCode).toBe(1)
    expect(DEC.decode(result.stderr)).toBe(
      'python3: fake: mount_type ssh needs a Linux machine; a Mac takes mount_type mirage\n',
    )
    await ws.close()
  })
})

describe('the kernel cache', () => {
  it('has a line wait out only what another changed under its mounts', async () => {
    const clock = new ManualClock()
    const sandbox = new FakeMachine('ssh')
    const ws = new Workspace(
      { '/': new RAMVFS(), '/data': new RAMVFS() },
      { mode: MountMode.WRITE, clock, ...on(sandbox) },
    )
    expect((await ws.shell('python3 job.py')).exitCode).toBe(0)
    const start = clock.monotonic()
    expect((await ws.shell('python3 job.py')).exitCode).toBe(0)
    expect(clock.monotonic()).toBe(start)
    await ws.vfs.write('/data/f', new TextEncoder().encode('x'))
    expect((await ws.shell('python3 job.py')).exitCode).toBe(0)
    expect(clock.monotonic()).toBe(start + 1)
    await SERVED_BY.run('box', () => ws.vfs.write('/data/g', new TextEncoder().encode('y')))
    expect((await ws.shell('python3 job.py')).exitCode).toBe(0)
    expect(clock.monotonic()).toBe(start + 1)
    await ws.close()
  })
})
