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
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ENCODE_OUTPUT,
  JOB_REMOVE,
  JOB_START,
  JOB_VIEW,
  MOUNT_GUARD,
  PROCESS,
  NOT_RUNNING_STATUS,
  SETSID_PROBE,
  TOOLS_PATH,
  decodeOutput,
  mountField,
  signalLine,
  stopLine,
  wrapLine,
} from './constants.ts'

const PRELUDE = `/bin/sh -c 'CDPATH= cd -- "$1" || exit 126; shift; exec "$@"' sh `

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
    ['-c', MOUNT_GUARD, 'sh', table, ...entries, '--', '/bin/echo', 'ran'],
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

// The scripts a detached job runs are the same bytes on both hosts:
// Python's constants test pins the same digests.
describe('job scripts', () => {
  it.each([
    ['start', JOB_START, '0ef05838d35b5277'],
    ['view', JOB_VIEW, 'b1159bcdc7dbf586'],
    ['remove', JOB_REMOVE, '7cde63f731a3578a'],
    ['probe', SETSID_PROBE, '45361050d388f83b'],
  ])('%s matches Python', (_, script, digest) => {
    expect(createHash('sha256').update(script).digest('hex').slice(0, 16)).toBe(digest)
  })
})

const detaches =
  existsSync('/proc/self') && spawnSync('/bin/sh', ['-c', 'command -v setsid']).status === 0

function startJob(folder: string, tag: string, ...argv: string[]) {
  return spawnSync('/bin/sh', ['-c', JOB_START, 'sh', folder, tag, ...argv], { timeout: 20_000 })
}

function viewJob(folder: string, out = 0, err = 0) {
  return spawnSync('/bin/sh', ['-c', JOB_VIEW, 'sh', folder, String(out), String(err), 's'], {
    timeout: 20_000,
  })
}

function jobPids(folder: string): number[] {
  return readFileSync(join(folder, 'pid'), 'utf8').trim().split(' ').map(Number)
}

describe.skipIf(!detaches)('a detached job in a real sh', () => {
  const folders: string[] = []
  const fresh = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-job-'))
    folders.push(dir)
    return join(dir, 'jobs', 'job')
  }
  const tag = (): string => `t${crypto.randomUUID().replaceAll('-', '')}:9`
  afterEach(() => {
    for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  // It runs with its arguments intact, and a viewer prints its output from
  // the offsets it is given, then the end mark with the exit code.
  it('is viewed to its exit code', () => {
    const folder = fresh()
    const args = ['sh', '-c', 'echo "arg: $1"; echo e1 >&2; exit 3', 'x', 'a b']
    expect(startJob(folder, tag(), ...args).status).toBe(0)
    const viewed = viewJob(folder)
    expect(viewed.stdout.toString()).toBe('arg: a b\n')
    expect(viewed.stderr.toString()).toBe('e1\n\0mirage-job s 3\n')
    expect(viewJob(folder, 5, 3).stdout.toString()).toBe('a b\n')
  })

  it('tags only its program, which leads its own group', () => {
    const folder = fresh()
    const named = tag()
    expect(startJob(folder, named, 'sleep', '30').status).toBe(0)
    const [program, wrapper] = jobPids(folder)
    try {
      const entries = (pid: number | undefined): string[] =>
        readFileSync(`/proc/${String(pid)}/environ`, 'utf8').split('\0')
      expect(entries(program)).toContain(`${PROCESS}=${named}`)
      expect(entries(wrapper)).not.toContain(`${PROCESS}=${named}`)
    } finally {
      process.kill(program ?? 0, 9)
    }
  })

  // A group stop reaches what the program started, and the wrapper lives on
  // to write the code the signal left.
  it('keeps the exit code a group stop left', () => {
    const folder = fresh()
    const named = tag()
    expect(startJob(folder, named, 'sh', '-c', 'sleep 30 & sleep 30').status).toBe(0)
    expect(spawnSync('/bin/sh', ['-c', signalLine(named, 15, true)]).status).toBe(0)
    expect(viewJob(folder).stderr.toString()).toBe('\0mirage-job s 143\n')
  })

  // A group stop reaches the children a program that exited left holding
  // its output, in the group it led.
  it('reaches the children a program that exited left', () => {
    const folder = fresh()
    const named = tag()
    expect(startJob(folder, named, 'sh', '-c', '(sleep 30; echo late) & exit 7').status).toBe(0)
    while (!existsSync(join(folder, 'exit'))) spawnSync('sleep', ['0.05'])
    expect(spawnSync('/bin/sh', ['-c', signalLine(named, 15, true)]).status).toBe(0)
    const viewed = viewJob(folder)
    expect([viewed.stdout.toString(), viewed.stderr.toString()]).toEqual(['', '\0mirage-job s 7\n'])
  })

  // A job's folder is the user's alone: none other reads its output.
  it("keeps its folder the user's alone", () => {
    const folder = fresh()
    expect(startJob(folder, tag(), 'true').status).toBe(0)
    expect(statSync(folder).mode & 0o077).toBe(0)
  })

  // It ends once what its program started has stopped too, as an attached
  // run ends once every writer closed its output.
  it('ends once what it started stopped', () => {
    const folder = fresh()
    const program = '(sleep 1; echo late) & echo early; exit 7'
    expect(startJob(folder, tag(), 'sh', '-c', program).status).toBe(0)
    const viewed = viewJob(folder)
    expect(viewed.stdout.toString()).toBe('early\nlate\n')
    expect(viewed.stderr.toString()).toBe('\0mirage-job s 7\n')
  })

  // Folders the user made writable by others before are made the user's alone
  // again before the job writes there.
  it('makes the folders above it private', () => {
    const jobs = join(fresh(), '..', '..', 'open')
    mkdirSync(jobs)
    chmodSync(jobs, 0o777)
    expect(startJob(join(jobs, 'job'), tag(), 'true').status).toBe(0)
    expect(statSync(jobs).mode & 0o777).toBe(0o700)
  })

  // A child that closed its output does not hold the job open, as it would
  // not hold an attached run: only one still holding `out` or `err` does.
  it('is not held by a child that closed its output', () => {
    const folder = fresh()
    const named = tag()
    const program = 'sleep 30 </dev/null >/dev/null 2>&1 & exit 7'
    expect(startJob(folder, named, 'sh', '-c', program).status).toBe(0)
    const began = Date.now()
    expect(viewJob(folder).stderr.toString()).toBe('\0mirage-job s 7\n')
    expect(Date.now() - began).toBeLessThan(5000)
    spawnSync('/bin/sh', ['-c', stopLine(named, 9)])
  })

  it('ends lost when its wrapper or folder went', () => {
    const folder = fresh()
    expect(startJob(folder, tag(), 'sleep', '30').status).toBe(0)
    const [program, wrapper] = jobPids(folder)
    process.kill(wrapper ?? 0, 9)
    process.kill(program ?? 0, 9)
    spawnSync('sleep', ['0.3'])
    expect(viewJob(folder).stderr.toString()).toBe('\0mirage-job s lost\n')
    expect(viewJob(join(folder, 'none')).stderr.toString()).toBe('\0mirage-job s lost\n')
  })
})
