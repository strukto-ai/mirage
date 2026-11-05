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
  bashLineArgv,
  EXEC_ID,
  MOUNT_GUARD,
  mountField,
  programsProbe,
  REAP_ABSENT,
  reapLine,
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
describe.skipIf(!existsSync('/proc/self'))('reapLine', () => {
  it.each([[undefined], ['/nowhere']])(
    'ends a run that ignores TERM (PATH %s)',
    async (path) => {
      const execId = crypto.randomUUID().replaceAll('-', '')
      const program = spawn(
        '/bin/sh',
        ['-c', 'trap "" TERM; echo ready; while :; do sleep 1; done'],
        {
          env: { ...process.env, [EXEC_ID]: execId },
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
        const done = spawnSync('/bin/sh', ['-c', reapLine(execId)], {
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

  // A box that holds no process of the run says so, apart from one whose
  // processes it stopped.
  it('answers a run it does not hold', () => {
    const done = spawnSync('/bin/sh', ['-c', reapLine(crypto.randomUUID().replaceAll('-', ''))], {
      timeout: 10_000,
    })
    expect(done.status).toBe(REAP_ABSENT)
  })
})

describe('programsProbe', () => {
  it('asks for each interpreter in sorted order, as Python does', () => {
    expect(programsProbe()).toBe(
      'for p in js node python python3; do command -v "$p" >/dev/null 2>&1 && echo "$p"; done; true',
    )
  })
})

describe('bashLineArgv', () => {
  it('passes the line and the name as positional words, as Python does', () => {
    expect(bashLineArgv('box', 'x')).toEqual([
      '/bin/sh',
      '-c',
      'command -v bash >/dev/null 2>&1 || { echo "mirage: $2 has no bash; a line using the sandbox\'s own files needs bash" >&2; exit 127; }; l=$1; shift 2; exec bash "$@" -c "$l"',
      'sh',
      'x',
      'box',
    ])
  })

  it('runs the line in bash and names a missing bash', () => {
    const [program = '', ...args] = bashLineArgv('box', '[[ a == a ]] && echo "$0" ok')
    const ran = spawnSync(program, args, { encoding: 'utf8' })
    expect(ran.stdout).toBe('bash ok\n')
    const [shell = '', ...rest] = bashLineArgv('box', 'true')
    const missing = spawnSync(shell, rest, { encoding: 'utf8', env: { PATH: '/nonexistent' } })
    expect(missing.status).toBe(127)
    expect(missing.stderr).toBe(
      "mirage: box has no bash; a line using the sandbox's own files needs bash\n",
    )
  })

  it('starts bash with the options it is given', () => {
    const [program = '', ...args] = bashLineArgv(
      'box',
      'case $- in *C*) echo C;; esac; shopt -q nullglob && echo on',
      ['-o', 'noclobber', '-O', 'nullglob'],
    )
    expect(spawnSync(program, args, { encoding: 'utf8' }).stdout).toBe('C\non\n')
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
