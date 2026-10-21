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
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EXEC_ID, reapLine, wrapLine } from './constants.ts'

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
  it.each([[undefined], ['/nowhere']])('ends a run that ignores TERM (PATH %s)', async (path) => {
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
  })
})
