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
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ENCODE_OUTPUT,
  MIRAGE_FUSE_FIND,
  MIRAGE_FUSE_LINE,
  MIRAGE_FUSE_VERSION,
  MOUNT_GUARD,
  PROCESS,
  PROGRAM_CHECK,
  NOT_RUNNING_STATUS,
  RUN_PROGRAM_AT,
  RUN_WRAPPER_JOINED,
  SSHFS_LINE,
  SSHFS_OPTIONS,
  TOOLS_PATH,
  darwinStart,
  decodeOutput,
  isRun,
  mountField,
  machineDirLine,
  runArgv,
  runDoneMark,
  runExitMark,
  runTag,
  scanLine,
  signalLine,
  stopLine,
  wrapLine,
} from './constants.ts'
import { FSPROTO_VERSION } from '../mount/constants.ts'

const PRELUDE = `/bin/sh -c 'CDPATH= cd -- "$1" || exit 126; shift; exec "$@"' sh `

// A run's wrapper hands its program the words and the tag unchanged, and says
// how the program ended on stderr after all the program wrote.
it('gives a run its words and says how its program ended', () => {
  const program = [
    'sh',
    '-c',
    `printf "%s|" "$@" "$${PROCESS}"; echo err >&2; exit 3`,
    'sh',
    'a b',
    '',
  ]
  const argv = runArgv('w:7', 'n1', program)
  expect([argv.slice(RUN_PROGRAM_AT), runTag(argv)]).toEqual([program, 'w:7'])
  const done = spawnSync(argv[0] ?? '', argv.slice(1))
  const ended = new TextDecoder().decode(runDoneMark('n1'))
  expect([done.status, done.stdout.toString()]).toEqual([3, `a b||w:7|${ended}3\n`])
  const mark = new TextDecoder().decode(runExitMark('n1'))
  expect(done.stderr.toString().endsWith(`err\n${mark}3\n`)).toBe(true)
})

// A joined run (`2>&1`) writes the program's stderr into its stdout where the
// program writes it, so the two keep its order; the wrapper's own pid and exit
// lines stay on stderr, and the check that reports a program the machine
// cannot run speaks on stdout too, as bash's redirect makes it.
it('writes the stderr of a joined run into its stdout in order', () => {
  const argv = runArgv(
    'w:7',
    'n1',
    ['sh', '-c', 'echo out1; echo err >&2; echo out2'],
    undefined,
    true,
  )
  expect(isRun(argv) && argv[2] === RUN_WRAPPER_JOINED).toBe(true)
  const done = spawnSync(argv[0] ?? '', argv.slice(1))
  const ended = new TextDecoder().decode(runDoneMark('n1'))
  expect(done.stdout.toString()).toBe(`out1\nerr\nout2\n${ended}0\n`)
  const mark = new TextDecoder().decode(runExitMark('n1'))
  expect(done.stderr.toString().replace(mark, '')).not.toContain('err')
  const missing = runArgv('w:7', 'n1', ['no-such-program-x'], ['bash: x: ', 'nope', ''], true)
  const gone = spawnSync(missing[0] ?? '', missing.slice(1))
  expect([gone.status, gone.stdout.toString()]).toEqual([127, `bash: x: nope\n${ended}127\n`])
})

// A program a signal ended gets no line at the end of its stdout, which may
// have no reader left; its status still comes on stderr.
it('ends the stdout of a run a signal ended with nothing', () => {
  const argv = runArgv('w:7', 'n1', ['sh', '-c', 'echo out; kill -9 $$'])
  const done = spawnSync(argv[0] ?? '', argv.slice(1))
  expect([done.status, done.stdout.toString()]).toEqual([137, 'out\n'])
  const mark = new TextDecoder().decode(runExitMark('n1'))
  expect(done.stderr.toString().endsWith(`${mark}137\n`)).toBe(true)
})

// How the program check reports `path`: its status and stderr.
function checked(path: string): [number | null, string] {
  const done = spawnSync('/bin/sh', [
    '-c',
    PROGRAM_CHECK,
    'sh',
    'x: ',
    'command not found',
    '',
    path,
  ])
  return [done.status, done.stderr.toString()]
}

// A path that names nothing the user can see is reported by its nearest folder
// that exists, as exec reports it: a file there is not a directory, a folder
// the user cannot search denies it, and only a folder that can be searched and
// lacks it makes the program missing.
it('reports a program path by its nearest folder', () => {
  const root = mkdtempSync(join(tmpdir(), 'mirage-check-'))
  const locked = join(root, 'locked')
  try {
    writeFileSync(join(root, 'file'), '')
    expect(checked(join(root, 'file', 'x'))).toEqual([126, 'x: Not a directory\n'])
    expect(checked(join(root, 'gone', 'x'))).toEqual([127, 'x: No such file or directory\n'])
    if (process.getuid?.() === 0) return
    mkdirSync(join(locked, 'sub'), { recursive: true })
    chmodSync(locked, 0)
    expect(checked(join(locked, 'sub', 'x'))).toEqual([126, 'x: Permission denied\n'])
    expect(checked(join(locked, 'x'))).toEqual([126, 'x: Permission denied\n'])
  } finally {
    if (existsSync(locked)) chmodSync(locked, 0o700)
    rmSync(root, { recursive: true, force: true })
  }
})

// The folder the line picks with `home` and `spare` for HOME and TMPDIR, under
// a umask that would leave a new folder group-writable.
function folderFor(home: string, spare: string, prefixes: readonly string[]): string {
  const done = spawnSync(
    '/bin/sh',
    ['-c', `umask 002; ${machineDirLine(prefixes)}printf %s "$d"`],
    { env: { PATH: process.env.PATH ?? '', HOME: home, TMPDIR: spare } },
  )
  expect(done.status, done.stderr.toString()).toBe(0)
  return done.stdout.toString()
}

// Mirage's folder is the user's alone, made or tightened to 700, and never
// under a workspace prefix, which a mount there would cover, nor a symlink.
it("keeps Mirage's folder private and off every workspace prefix", () => {
  const root = mkdtempSync(join(tmpdir(), 'mirage-dir-'))
  try {
    const [work, spare, home] = [join(root, 'work'), join(root, 'spare'), join(root, 'home')]
    mkdirSync(join(work, 'home'), { recursive: true })
    mkdirSync(spare)
    mkdirSync(home)
    const folder = join(spare, `.mirage-${String(process.getuid?.() ?? 0)}`)
    mkdirSync(folder)
    chmodSync(folder, 0o775)
    expect(folderFor(join(work, 'home'), spare, [work])).toBe(folder)
    expect(statSync(folder).mode & 0o777).toBe(0o700)
    symlinkSync(work, join(home, '.mirage'))
    expect(folderFor(home, spare, [])).toBe(folder)
    unlinkSync(join(home, '.mirage'))
    expect(folderFor(home, spare, [work])).toBe(join(home, '.mirage'))
    expect(statSync(join(home, '.mirage')).mode & 0o777).toBe(0o700)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('wrapLine', () => {
  it('dresses cwd, env, and the argv', () => {
    expect(wrapLine(['echo', 'hi'], { A: '1' }, '/w')).toBe(`${PRELUDE}'/w' env 'A=1' 'echo' 'hi'`)
  })

  it('quotes hostile values', () => {
    expect(wrapLine(['/bin/sh', '-c', "echo 'hi'"], { M: 'two words' }, '/a b')).toBe(
      `${PRELUDE}'/a b' env 'M=two words' '/bin/sh' '-c' 'echo '\\''hi'\\'''`,
    )
  })

  it('still runs env with no assignments', () => {
    expect(wrapLine(['pwd'], {}, '/')).toBe(`${PRELUDE}'/' env 'pwd'`)
  })

  it('hands the program its argv unchanged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-argv-'))
    try {
      const argv = ['/bin/sh', '-c', 'printf "[%s]\\n" "$@"', 'sh', 'a b', '$(x)', '']
      const done = spawnSync('/bin/sh', ['-c', wrapLine(argv, {}, dir)])
      expect([done.status, done.stdout.toString()]).toEqual([0, '[a b]\n[$(x)]\n[]\n'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('still runs the line under a PATH that holds no sh', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-path-'))
    try {
      const wrapped = wrapLine(['/bin/sh', '-c', '/bin/echo ok'], { PATH: dir }, dir)
      const done = spawnSync('/bin/sh', ['-c', wrapped])
      expect([done.status, done.stdout.toString()]).toEqual([0, 'ok\n'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// A run's program may ignore TERM, and the config may set a PATH that
// holds no grep: the stop line still ends every process of the run.
describe.skipIf(!existsSync('/proc/self'))('stopLine', () => {
  it.each([[undefined], ['/nowhere']])(
    'ends a run that ignores TERM (PATH %s)',
    async (path) => {
      const tag = `${crypto.randomUUID().replaceAll('-', '')}:9`
      const program = spawn(
        '/bin/sh',
        ['-c', 'trap "" TERM; echo ready; while :; do sleep 1; done'],
        {
          env: { ...process.env, [PROCESS]: tag },
        },
      )
      const ready = new Promise<void>((resolve) => {
        program.stdout.once('data', () => {
          resolve()
        })
      })
      const ended = new Promise<string | null>((resolve) => {
        program.once('exit', (_code, signal) => {
          resolve(signal)
        })
      })
      try {
        await ready
        const done = spawnSync('/bin/sh', ['-c', stopLine(tag)], {
          env: path === undefined ? process.env : { PATH: path },
          timeout: 10_000,
        })
        expect(done.status).toBe(0)
        expect(await ended).toBe('SIGKILL')
      } finally {
        program.kill('SIGKILL')
      }
    },
    15_000,
  )

  // A hangup reaches only what is still in the run's session, and nothing is
  // killed after it: a setsid daemon and a child that ignores HUP keep
  // running, as a dropped terminal leaves them.
  it('spares what left the run, or ignores a hangup', async () => {
    const tag = `${crypto.randomUUID().replaceAll('-', '')}:9`
    const program = spawn(
      '/bin/sh',
      [
        '-c',
        "setsid sleep 300 & echo $!; (trap '' HUP; exec sleep 301) & echo $!; " +
          'while :; do sleep 1; done',
      ],
      { env: { ...process.env, [PROCESS]: tag }, detached: true },
    )
    const left = await new Promise<number[]>((resolve) => {
      let text = ''
      program.stdout.on('data', (d: Buffer) => {
        text += d.toString()
        const pids = text.split('\n').filter(Boolean).map(Number)
        if (pids.length >= 2) resolve(pids.slice(0, 2))
      })
    })
    const ended = new Promise<string | null>((resolve) => {
      program.once('exit', (_code, signal) => {
        resolve(signal)
      })
    })
    try {
      await new Promise((resolve) => setTimeout(resolve, 500))
      const root = { pid: program.pid ?? 0, started: 0, exited: null }
      const done = spawnSync('/bin/sh', ['-c', stopLine(tag, 1, root)], { timeout: 10_000 })
      expect(done.status).toBe(0)
      expect(await ended).toBe('SIGHUP')
      for (const pid of left) expect(() => process.kill(pid, 0)).not.toThrow()
    } finally {
      spawnSync('/bin/sh', ['-c', stopLine(tag)], { timeout: 10_000 })
      program.kill('SIGKILL')
    }
  }, 15_000)

  // Once the run's program has exited, a hangup still spares what setsid
  // moved out of the session, even once that session's leader has exited
  // too, and a stopped process is continued so the hangup ends it.
  it('keeps to the session once the program is gone', async () => {
    const tag = `${crypto.randomUUID().replaceAll('-', '')}:9`
    const program = spawn(
      '/bin/sh',
      [
        '-c',
        'setsid sleep 300 & echo $!; sleep 301 & echo $!; sleep 302 & echo $!; ' +
          "setsid sh -c 'sleep 303 & echo $!'",
      ],
      { env: { ...process.env, [PROCESS]: tag }, detached: true },
    )
    const pids = new Promise<number[]>((resolve) => {
      let text = ''
      program.stdout.on('data', (d: Buffer) => {
        text += d.toString()
        const lines = text.split('\n').slice(0, -1).filter(Boolean).map(Number)
        if (lines.length >= 4) resolve(lines.slice(0, 4))
      })
    })
    const exited = new Promise((resolve) => program.once('exit', resolve))
    const [[kept, hung, stopped, orphan]] = (await Promise.all([pids, exited])) as [
      [number, number, number, number],
      unknown,
    ]
    const ended = (pid: number): boolean => {
      let stat: string
      try {
        stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8')
      } catch {
        return true
      }
      const state = stat
        .slice(stat.lastIndexOf(')') + 1)
        .trim()
        .split(/\s+/)[0]
      return state === 'Z' || state === 'X'
    }
    try {
      process.kill(stopped, 'SIGSTOP')
      const root = { pid: program.pid ?? 0, started: 0, exited: null }
      const done = spawnSync('/bin/sh', ['-c', stopLine(tag, 1, root)], { timeout: 10_000 })
      expect(done.status).toBe(0)
      for (let i = 0; i < 50 && !(ended(hung) && ended(stopped)); i++) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      expect(ended(hung) && ended(stopped)).toBe(true)
      expect(ended(kept) || ended(orphan)).toBe(false)
    } finally {
      spawnSync('/bin/sh', ['-c', stopLine(tag)], { timeout: 10_000 })
    }
  }, 15_000)

  // A tag names one process: the stop line for w:9 leaves the run of w:90
  // running.
  it('matches its process tag whole', async () => {
    const workspace = crypto.randomUUID().replaceAll('-', '')
    const program = spawn('/bin/sh', ['-c', 'echo ready; while :; do sleep 1; done'], {
      env: { ...process.env, [PROCESS]: `${workspace}:90` },
    })
    try {
      await new Promise<void>((resolve) => {
        program.stdout.once('data', () => {
          resolve()
        })
      })
      const done = spawnSync('/bin/sh', ['-c', stopLine(`${workspace}:9`)], { timeout: 10_000 })
      expect(done.status).toBe(NOT_RUNNING_STATUS)
      expect(program.exitCode).toBeNull()
    } finally {
      program.kill('SIGKILL')
    }
  }, 15_000)

  // A box that holds no process of the run says so, apart from one whose
  // processes it stopped.
  it('answers a run it does not hold', () => {
    const done = spawnSync('/bin/sh', ['-c', stopLine(crypto.randomUUID().replaceAll('-', ''))], {
      timeout: 10_000,
    })
    expect(done.status).toBe(NOT_RUNNING_STATUS)
  })
})

// The temporary directories the guard's tables live in, removed after each test.
const tables: string[] = []

function guarded(table: string, ...entries: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(
    '/bin/sh',
    [
      '-c',
      MOUNT_GUARD,
      'sh',
      '',
      'command not found',
      '',
      table,
      ...entries,
      '--',
      '/bin/echo',
      'ran',
    ],
    {
      env: { PATH: '/nowhere' },
      encoding: 'utf8',
      timeout: 10_000,
    },
  )
}

function expected(prefix: string, source: string, kind: string): string[] {
  return [mountField(prefix), mountField(source, true), kind, `lost ${prefix}`]
}

function tableDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mirage-mounts-'))
  tables.push(dir)
  return dir
}

function tableOf(rows: string): string {
  const table = join(tableDir(), 'mounts')
  writeFileSync(table, rows)
  return table
}

describe('MOUNT_GUARD', () => {
  afterEach(() => {
    for (const dir of tables.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('escapes what the kernel escapes', () => {
    expect(mountField('/a b\tc\nd\\e#')).toBe('/a\\040b\\011c\\012d\\134e#')
    expect(mountField('m:/a b#', true)).toBe('m:/a\\040b\\043')
  })

  // The guard runs the program once every mount it expects is on top, read
  // through the kernel's escapes, with only sh's builtins on the PATH.
  it('runs the program over its mounts', () => {
    const table = tableOf(
      'mirage-x:/my\\040notes /my\\040notes fuse.sshfs rw 0 0\n' + 'tmpfs /a\\134b tmpfs rw 0 0\n',
    )
    const done = guarded(
      table,
      ...expected('/my notes', 'mirage-x:/my notes', 'fuse.sshfs'),
      ...expected('/a\\b', 'tmpfs', 'tmpfs'),
    )
    expect([done.status, done.stdout, done.stderr]).toEqual([0, 'ran\n', ''])
  })

  // The kernel escapes a # in a source, never in a mountpoint; an older mount
  // under ours is no matter.
  it.each([
    ['hash', 'mirage-x:/a\\043b /a#b fuse.sshfs rw 0 0\n', '/a#b', 'mirage-x:/a#b'],
    [
      'over an older mount',
      'tmpfs /data tmpfs rw 0 0\nmirage-x:/data /data fuse.sshfs rw 0 0\n',
      '/data',
      'mirage-x:/data',
    ],
  ])('runs over the top mount (%s)', (_name, rows, prefix, source) => {
    const done = guarded(tableOf(rows), ...expected(prefix, source, 'fuse.sshfs'))
    expect([done.status, done.stdout, done.stderr]).toEqual([0, 'ran\n', ''])
  })

  // The guard's own names never reach the program's environment.
  it('hands the program its environment', () => {
    const words = ['t', 'f', 's', 'm', 'k', 'o']
    const done = spawnSync(
      '/bin/sh',
      [
        '-c',
        MOUNT_GUARD,
        'sh',
        '',
        'command not found',
        '',
        tableOf('mirage-x:/data /data fuse.sshfs rw 0 0\n'),
        ...expected('/data', 'mirage-x:/data', 'fuse.sshfs'),
        '--',
        '/usr/bin/env',
      ],
      {
        env: { PATH: '/nowhere', ...Object.fromEntries(words.map((w) => [w, `keep-${w}`])) },
        encoding: 'utf8',
        timeout: 10_000,
      },
    )
    expect(done.status).toBe(0)
    const lines = done.stdout.split('\n')
    for (const w of words) expect(lines).toContain(`${w}=keep-${w}`)
  })

  it('checks every mount', () => {
    const done = guarded(
      tableOf('mirage-x:/data /data fuse.sshfs rw 0 0\n'),
      ...expected('/data', 'mirage-x:/data', 'fuse.sshfs'),
      ...expected('/a\\b', 'tmpfs', 'tmpfs'),
    )
    expect([done.status, done.stdout, done.stderr]).toEqual([126, '', 'lost /a\\b\n'])
  })

  it.each([
    ['gone', ''],
    ['another source', 'mirage-y:/data /data fuse.sshfs rw 0 0\n'],
    ['another type', 'mirage-x:/data /data tmpfs rw 0 0\n'],
    ['covered', 'mirage-x:/data /data fuse.sshfs rw 0 0\ntmpfs /data tmpfs rw 0 0\n'],
  ])('refuses a mount not on top (%s)', (_name, rows) => {
    const done = guarded(tableOf(rows), ...expected('/data', 'mirage-x:/data', 'fuse.sshfs'))
    expect([done.status, done.stdout, done.stderr]).toEqual([126, '', 'lost /data\n'])
  })

  it('refuses without a mount table', () => {
    const missing = join(tableDir(), 'missing')
    const done = guarded(missing, ...expected('/data', 'mirage-x:/data', 'fuse.sshfs'))
    expect([done.status, done.stdout, done.stderr]).toEqual([126, '', 'lost /data\n'])
  })
})

// A line the machine's own shell writes (no encoder there) is not base64
// and comes back as it is, between the decoded lines; a blank line adds
// nothing.
describe('decodeOutput', () => {
  it('keeps a plain line as it is', () => {
    const text = 'YQ==\r\nmirage: no base64\n\nAP8=\n'
    expect([...decodeOutput(text)]).toEqual([
      ...new TextEncoder().encode('amirage: no base64\n'),
      0,
      255,
    ])
  })
  it('keeps a plain line longer in bytes than in characters', () => {
    expect(new TextDecoder().decode(decodeOutput('mirage: é€'))).toBe('mirage: é€\n')
  })
})

// A sandbox without dd or base64 runs nothing: the script says so in plain
// text and exits 127.
describe('ENCODE_OUTPUT', () => {
  it('runs nothing in a sandbox without the encoder', () => {
    const empty = mkdtempSync(join(tmpdir(), 'mirage-noenc-'))
    try {
      const script = ENCODE_OUTPUT.replaceAll(TOOLS_PATH, empty)
      const done = spawnSync('/bin/sh', ['-c', script, 'sh', '/bin/sh', '-c', 'echo ran'], {
        encoding: 'utf8',
        timeout: 10_000,
      })
      expect([done.status, done.stdout, done.stderr]).toEqual([
        127,
        '',
        'mirage: the machine needs dd and base64 to return output\n',
      ])
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})

describe('SSHFS_OPTIONS', () => {
  it('keeps names and attributes a second and never contents', () => {
    expect(SSHFS_OPTIONS.split(',')).toEqual(
      expect.arrayContaining([
        'attr_timeout=1',
        'entry_timeout=1',
        'negative_timeout=1',
        'dir_cache=no',
        'direct_io',
      ]),
    )
  })
})

// Stand-ins for the tools SSHFS_LINE calls, on a PATH of their own: sudo runs
// what it is given when SUDO_OK is set, apt-get installs sshfs only once its
// lists were updated, and every call is logged.
const FAKE_TOOLS: Record<string, string> = {
  id: '#!/bin/sh\necho "${FAKE_UID:-1000}"\n',
  sudo: '#!/bin/sh\n[ -n "$SUDO_OK" ] || exit 1\n[ "$1" = -n ] && shift\n[ "$1" = true ] && exit 0\nexec "$@"\n',
  env: '#!/bin/sh\nwhile case "$1" in *=*) true;; *) false;; esac; do export "$1"; shift; done\nexec "$@"\n',
  'apt-get':
    '#!/bin/sh\necho "apt-get $*" >> "$LOG"\n' +
    'case " $* " in *" update "*) : > "$TOOLS/lists"; exit 0;; esac\n' +
    '[ -f "$TOOLS/lists" ] || exit 100\n' +
    'printf \'#!/bin/sh\\n\' > "$TOOLS/sshfs"\n' +
    '/bin/chmod +x "$TOOLS/sshfs"\n',
}

describe('SSHFS_LINE', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  const tools = (names: string[], files: string[] = []): string => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-sshfs-'))
    dirs.push(dir)
    for (const name of names) {
      writeFileSync(join(dir, name), FAKE_TOOLS[name] ?? '')
      chmodSync(join(dir, name), 0o755)
    }
    for (const name of files) {
      writeFileSync(join(dir, name), '#!/bin/sh\n')
      chmodSync(join(dir, name), 0o755)
    }
    writeFileSync(join(dir, 'log'), '')
    return dir
  }

  const line = (dir: string, env: Record<string, string> = {}): [number | null, string[]] => {
    const done = spawnSync('/bin/sh', ['-c', SSHFS_LINE], {
      env: { PATH: dir, TOOLS: dir, LOG: join(dir, 'log'), ...env },
    })
    const log = readFileSync(join(dir, 'log'), 'utf8')
    return [done.status, log.split('\n').filter((row) => row !== '')]
  }

  it('leaves a machine that has sshfs alone', () => {
    expect(line(tools(['id', 'apt-get'], ['sshfs']))).toEqual([0, []])
  })
  it('installs through sudo from fresh lists', () => {
    expect(line(tools(['id', 'sudo', 'env', 'apt-get']), { SUDO_OK: '1' })).toEqual([
      0,
      [
        'apt-get -y -qq install --no-install-recommends sshfs',
        'apt-get -y -qq update',
        'apt-get -y -qq install --no-install-recommends sshfs',
      ],
    ])
  })
  it('installs as root without sudo', () => {
    const dir = tools(['id', 'env', 'apt-get'], ['lists'])
    expect(line(dir, { FAKE_UID: '0' })).toEqual([
      0,
      ['apt-get -y -qq install --no-install-recommends sshfs'],
    ])
  })
  it.each([
    ['no sudo', ['id', 'sudo', 'env', 'apt-get'], {}],
    ['no package manager', ['id', 'sudo', 'env'], { SUDO_OK: '1' }],
  ])('fails when it cannot install: %s', (_, names, env) => {
    expect(line(tools(names), env)).toEqual([1, []])
  })
})

// Stand-ins for the installers MIRAGE_FUSE_LINE calls, on a PATH of their own:
// each logs its call and, unless told to fail, puts a mirage-fuse speaking
// this host's fsproto where it was asked to. npm, as npm does, refuses to
// replace a file there without --force.
const FUSE = `#!/bin/sh\necho "mirage-fuse 0 fsproto ${String(FSPROTO_VERSION)}"\n`
const FAKE_INSTALLERS: Record<string, string> = {
  uv:
    '#!/bin/sh\necho "uv $* in $UV_TOOL_BIN_DIR" >> "$LOG"\n' +
    '[ -z "$UV_FAILS" ] || exit 1\n/bin/mkdir -p "$UV_TOOL_BIN_DIR"\n' +
    `printf '%s' '${FUSE}' > "$UV_TOOL_BIN_DIR/mirage-fuse"\n` +
    '/bin/chmod +x "$UV_TOOL_BIN_DIR/mirage-fuse"\n',
  npm:
    '#!/bin/sh\necho "npm $*" >> "$LOG"\nf=; p=\n' +
    'while [ $# -gt 0 ]; do case $1 in --force) f=1;; ' +
    '--prefix) p=$2;; esac; shift; done\n' +
    '[ -e "$p/bin/mirage-fuse" ] && [ -z "$f" ] && exit 1\n' +
    '/bin/mkdir -p "$p/bin"\n' +
    `printf '%s' '${FUSE}' > "$p/bin/mirage-fuse"\n` +
    '/bin/chmod +x "$p/bin/mirage-fuse"\n',
}

describe('MIRAGE_FUSE_LINE', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  const machine = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-fuse-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'bin'))
    writeFileSync(join(dir, 'log'), '')
    return dir
  }

  const line = (
    dir: string,
    names: string[],
    env: Record<string, string> = {},
  ): [number | null, string[]] => {
    for (const name of names) {
      writeFileSync(join(dir, 'bin', name), FAKE_INSTALLERS[name] ?? '')
      chmodSync(join(dir, 'bin', name), 0o755)
    }
    const done = spawnSync('/bin/sh', ['-c', MIRAGE_FUSE_LINE], {
      env: { PATH: join(dir, 'bin'), HOME: join(dir, 'home'), LOG: join(dir, 'log'), ...env },
    })
    const log = readFileSync(join(dir, 'log'), 'utf8')
    return [done.status, log.split('\n').filter((row) => row !== '')]
  }

  it('is the npm spelling of this release', () => {
    const cargo = readFileSync(join(import.meta.dirname, '../../../../../rust/Cargo.toml'), 'utf8')
    expect(cargo).toContain(`\nversion = "${MIRAGE_FUSE_VERSION}"\n`)
  })
  it('leaves a machine that has it alone', () => {
    const dir = machine()
    writeFileSync(join(dir, 'bin', 'mirage-fuse'), FUSE)
    chmodSync(join(dir, 'bin', 'mirage-fuse'), 0o755)
    expect(line(dir, ['uv', 'npm'])).toEqual([0, []])
  })
  it("installs with uv into Mirage's folder", () => {
    const dir = machine()
    const folder = join(dir, 'home', '.mirage', 'bin')
    expect(line(dir, ['uv', 'npm'])).toEqual([
      0,
      [`uv tool install --force mirage-fuse==${MIRAGE_FUSE_VERSION} in ${folder}`],
    ])
    expect(existsSync(join(folder, 'mirage-fuse'))).toBe(true)
  })
  it('falls back to npm', () => {
    const dir = machine()
    const home = join(dir, 'home')
    expect(line(dir, ['uv', 'npm'], { UV_FAILS: '1' })).toEqual([
      0,
      [
        `uv tool install --force mirage-fuse==${MIRAGE_FUSE_VERSION} in ${home}/.mirage/bin`,
        `npm install -g --force --prefix ${home}/.mirage @struktoai/mirage-fuse@${MIRAGE_FUSE_VERSION}`,
      ],
    ])
  })
  it('replaces one speaking another fsproto', () => {
    const dir = machine()
    const stale = join(dir, 'home', '.mirage', 'bin', 'mirage-fuse')
    mkdirSync(join(dir, 'home', '.mirage', 'bin'), { recursive: true })
    writeFileSync(stale, '#!/bin/sh\necho "mirage-fuse 0 fsproto 0"\n')
    chmodSync(stale, 0o755)
    const [code, calls] = line(dir, ['npm'])
    expect([code, calls.length]).toEqual([0, 1])
    expect(readFileSync(stale, 'utf8')).not.toContain('fsproto 0')
  })
  it('takes the PATH one past a stale home one', () => {
    const dir = machine()
    const home = join(dir, 'home')
    const stale = join(home, '.mirage', 'bin', 'mirage-fuse')
    mkdirSync(join(home, '.mirage', 'bin'), { recursive: true })
    writeFileSync(stale, '#!/bin/sh\necho "mirage-fuse 0 fsproto 0"\n')
    chmodSync(stale, 0o755)
    const fuse = join(dir, 'bin', 'mirage-fuse')
    writeFileSync(fuse, FUSE)
    chmodSync(fuse, 0o755)
    expect(line(dir, [])).toEqual([0, []])
    const found = spawnSync('/bin/sh', ['-c', `${MIRAGE_FUSE_FIND}printf %s "$f"`], {
      env: { PATH: join(dir, 'bin'), HOME: home },
      encoding: 'utf8',
    })
    expect(found.stdout).toBe(fuse)
  })
  it('fails without uv or npm', () => {
    expect(line(machine(), [])).toEqual([1, []])
  })
})

const onMac = process.platform === 'darwin' ? describe : describe.skip

function sh(line: string): { status: number; stdout: string } {
  const done = spawnSync('/bin/sh', ['-c', line], { encoding: 'utf8' })
  return { status: done.status ?? 1, stdout: done.stdout }
}

// The tag, pid and parent of each row a scan prints.
function scanned(stdout: string): [string, number, number][] {
  return stdout
    .split('\n')
    .filter((row) => row.startsWith('M '))
    .map((row) => {
      const [, tag = '', pid = '', ppid = ''] = row.split(' ')
      return [tag, Number(pid), Number(ppid)]
    })
}

async function settled(child: ReturnType<typeof spawn>): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode
  return new Promise((resolve) =>
    child.on('exit', (code) => {
      resolve(code)
    }),
  )
}

onMac('a Mac', () => {
  it('knows a run by its program and what runs under it', async () => {
    const tagged = { ...process.env, [PROCESS]: 'w1:9' }
    const untagged = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => name !== PROCESS),
    )
    const wrapper = spawn('/bin/sh', ['-c', '/bin/sleep 30', 'sh', `${PROCESS}=w1:9`], {
      env: untagged,
    })
    const other = spawn('/bin/sh', ['-c', 'exec /bin/sleep 31'], {
      env: { ...process.env, [PROCESS]: 'w1:90' },
    })
    const program = spawn('/bin/sh', ['-c', '/bin/sleep 32 & wait'], { env: tagged })
    try {
      await new Promise((resolve) => setTimeout(resolve, 500))
      const pid = program.pid ?? 0
      const started = Number(sh(darwinStart(String(pid))).stdout)
      const rows = scanned(sh(scanLine('w1', new Map([[pid, ['w1:9', started]]]))).stdout)
      expect(
        new Set(rows.map(([tag, row, parent]) => `${tag} ${String(parent === pid || row)}`)),
      ).toEqual(new Set([`w1:9 ${String(pid)}`, 'w1:9 true']))
      expect(sh(signalLine({ pid, started: started + 100 }, 0)).status).toBe(NOT_RUNNING_STATUS)
      expect(sh(signalLine({ pid, started }, 0)).status).toBe(0)
      expect(sh(stopLine('w1:9', 15, { pid, started })).status).toBe(0)
      await settled(program)
      expect(sh(stopLine('w1:9', 15, { pid, started })).status).toBe(NOT_RUNNING_STATUS)
      for (const child of [wrapper, other]) {
        expect(sh(`ps -o state= -p ${String(child.pid ?? 0)}`).stdout.trim()).toMatch(/^[^Z]/)
      }
    } finally {
      for (const child of [wrapper, other, program]) child.kill('SIGKILL')
      await Promise.all([wrapper, other, program].map((child) => settled(child)))
    }
  })

  it('stops what outlives the program', async () => {
    const untagged = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => name !== PROCESS),
    )
    const dir = mkdtempSync(join(tmpdir(), 'mirage-stop-'))
    const pidfile = join(dir, 'child')
    const program = spawn(
      '/bin/sh',
      [
        '-c',
        '/bin/sh -c \'trap "" TERM; echo $$ > "$1"; while :; do /bin/sleep 0.05; done\' sh "$0" & wait',
        pidfile,
      ],
      { env: untagged },
    )
    let child = 0
    try {
      for (let i = 0; i < 50 && child === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        child = Number(sh(`cat '${pidfile}' 2>/dev/null`).stdout.trim())
      }
      const pid = program.pid ?? 0
      const started = Number(sh(darwinStart(String(pid))).stdout)
      expect(sh(stopLine('w1:9', 15, { pid, started })).status).toBe(0)
      await settled(program)
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(sh(`kill -0 ${String(child)}`).status).not.toBe(0)
    } finally {
      program.kill('SIGKILL')
      await settled(program)
      if (child) sh(`kill -KILL ${String(child)}`)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
