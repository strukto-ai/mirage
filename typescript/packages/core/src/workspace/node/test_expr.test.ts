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

// Pinned against GNU bash 5.2.37: `[` is a command, so every operator the
// grammar folds into a `[ ... ]` test reaches it as an operand word, and test
// refuses the ones it does not know rather than never seeing them. Mirrors
// python/tests/workspace/node/test_test_expr.py.

import { describe, expect, it } from 'vitest'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { MountMode } from '../../types.ts'
import { getTestParser, stderrStr, stdoutStr } from '../fixtures/workspace_fixture.ts'
import { Workspace } from '../workspace/workspace.ts'

describe('expandTestExpr', () => {
  it.each([
    ['[ a == a ] && echo y', 'y\n', ''],
    ['[ $ ] && echo y', 'y\n', ''],
    ['[ a =~ a ]; echo $?', '2\n', 'bash: [: =~: binary operator expected\n'],
    ['[ 1 + 1 ]; echo $?', '2\n', 'bash: [: +: binary operator expected\n'],
    ['[ a += b ]; echo $?', '2\n', 'bash: [: +=: binary operator expected\n'],
    ['[ a -= b ]; echo $?', '2\n', 'bash: [: -=: binary operator expected\n'],
  ])('hands every operator in %j to test as a word', async (line, out, err) => {
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      { mode: MountMode.WRITE, shellParser: await getTestParser() },
    )
    const io = await ws.shell(line)
    expect([stdoutStr(io), stderrStr(io)]).toEqual([out, err])
  })
})

it.each([
  ['[[ x == x || -n <(printf unused >&2) ]]; echo $?', '0\n', ''],
  ['[[ x == x || -n >(true) ]]; echo $?', '0\n', ''],
  ['[[ x == y && -n <(printf unused >&2) ]]; echo $?', '1\n', ''],
  ['[[ x == y && -n >(true) ]]; echo $?', '1\n', ''],
  ['[[ x == y || -n <(printf used >&2) ]]; echo $?', '0\n', 'used'],
  ['[[ x == x || ${missing:?unused} ]]; echo $?', '0\n', ''],
  ['x=0; [[ x=5 -eq 5 && $x == 5 ]]; echo "$? $x"', '0 5\n', ''],
  [
    '[[ x == x && -n >(true) ]]; echo after=$?',
    'after=2\n',
    'mirage: unsupported: process substitution >(...)\n',
  ],
])('test_double_bracket_expands_only_reached_operands: %s', async (line, out, err) => {
  const ws = new Workspace(
    { '/data': new RAMVFS() },
    { mode: MountMode.WRITE, shellParser: await getTestParser() },
  )
  try {
    const io = await ws.shell(line)
    expect([io.exitCode, stdoutStr(io), stderrStr(io)]).toEqual([0, out, err])
  } finally {
    await ws.close()
  }
})

it.each([
  ['case b in b) echo chosen;; @(<(printf unused >&2)|b)) :;; esac', 'chosen\n', ''],
  ['case b in b) echo chosen;; @(>(true)|b)) :;; esac', 'chosen\n', ''],
  ['case b in b|$(printf unused >&2)) echo chosen;; esac', 'chosen\n', ''],
  ['case b in b|>(true)) echo chosen;; esac', 'chosen\n', ''],
  [
    'case b in b) echo first;& @(<(printf unused >&2)|b)) echo second;; esac',
    'first\nsecond\n',
    '',
  ],
  ['p=x; case b in b) p=b; echo first;;& "$p") echo second;; esac', 'first\nsecond\n', ''],
  ['case b in @(b|$(printf used >&2))) echo chosen;; esac', 'chosen\n', 'used'],
  ['case b in <(printf used >&2)|b) echo chosen;; esac', 'chosen\n', 'used'],
  [
    'case b in b) echo first;;& >(true)) echo BAD;; esac; echo after=$?',
    'first\nafter=2\n',
    'mirage: unsupported: process substitution >(...)\n',
  ],
  [
    'case b in b) printf body >&2;;& $(printf pattern >&2; printf b)) echo chosen;; esac',
    'chosen\n',
    'bodypattern',
  ],
])('test_case_expands_only_tested_patterns: %s', async (line, out, err) => {
  const ws = new Workspace(
    { '/data': new RAMVFS() },
    { mode: MountMode.WRITE, shellParser: await getTestParser() },
  )
  try {
    await ws.shell('shopt -s extglob')
    const io = await ws.shell(line)
    expect([io.exitCode, stdoutStr(io), stderrStr(io)]).toEqual([0, out, err])
  } finally {
    await ws.close()
  }
})
