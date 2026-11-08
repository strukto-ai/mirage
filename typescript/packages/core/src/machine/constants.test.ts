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
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ENCODE_OUTPUT,
  MOUNT_GUARD,
  PROCESS,
  NOT_RUNNING_STATUS,
  TOOLS_PATH,
  decodeOutput,
  mountField,
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
