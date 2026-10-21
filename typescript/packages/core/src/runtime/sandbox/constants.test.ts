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

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { wrapLine } from './constants.ts'

const PRELUDE = `/bin/sh -c 'CDPATH= cd -- "$1" || exit 126; shift; exec "$@"' sh `

describe('wrapLine', () => {
  it('dresses cwd, env, and the line', () => {
    expect(wrapLine('echo hi', { A: '1' }, '/w')).toBe(
      `${PRELUDE}'/w' env 'A=1' /bin/sh -c 'echo hi'`,
    )
  })

  it('quotes hostile values', () => {
    expect(wrapLine("echo 'hi'", { M: 'two words' }, '/a b')).toBe(
      `${PRELUDE}'/a b' env 'M=two words' /bin/sh -c 'echo '\\''hi'\\'''`,
    )
  })

  it('still runs env with no assignments', () => {
    expect(wrapLine('pwd', {}, '/')).toBe(`${PRELUDE}'/' env /bin/sh -c 'pwd'`)
  })

  it('still runs the line under a PATH that holds no sh', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-path-'))
    try {
      const done = spawnSync('/bin/sh', ['-c', wrapLine('/bin/echo ok', { PATH: dir }, dir)])
      expect([done.status, done.stdout.toString()]).toEqual([0, 'ok\n'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
