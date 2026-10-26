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

import { describe, expect, it } from 'vitest'
import { runAsProgram } from '../../../../context/session_context.ts'
import { materialize } from '../../../../io/types.ts'
import { Limit, MountMode } from '../../../../types.ts'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import { SessionState } from '../../../session/session.ts'
import { Workspace } from '../../../workspace/workspace.ts'
import { handlePrintf } from './printf.ts'

// Mirrors python's test_printf.py program-run cases: what coreutils 9.7
// printed for each (debian:stable-slim), which a program run answers as.
const DEC = new TextDecoder()

async function programPrintf(args: string[]): Promise<[string | null, string, number]> {
  const session = new SessionState({ sessionId: 's1' })
  const [out, io, node] = await runAsProgram(session, () => handlePrintf(args, session))
  const text = out === null ? null : DEC.decode(await materialize(out))
  expect(io.exitCode).toBe(node.exitCode)
  return [text, DEC.decode(await materialize(io.stderr)), node.exitCode]
}

function excess(word: string): string {
  return `printf: warning: ignoring excess arguments, starting with ${word}\n`
}

describe('printf run as a program', () => {
  it.each([
    [['x\n', 'a', 'b'], 'x\n', excess("'a'")],
    [['%%s\n', 'x'], '%s\n', excess("'x'")],
    [['', 'a'], '', excess("'a'")],
    [['x\n', "it's"], 'x\n', excess("'it\\'s'")],
    [['x\n', 'é'], 'x\n', excess("'\\303\\251'")],
    [['x\n', 'a\tb'], 'x\n', excess("'a\\tb'")],
    [['x\n', ''], 'x\n', excess("''")],
    [['--', 'x\n', 'a'], 'x\n', excess("'a'")],
    [['-v', 'v', 'x\n'], '-v', excess("'v'")],
    [['%s-%s\n', 'a', 'b', 'c'], 'a-b\nc-\n', ''],
    [['x\\c', 'a'], 'x', ''],
  ])('%j warns about what it drops', async (args, out, err) => {
    expect(await programPrintf(args)).toEqual([out, err, 0])
  })

  it.each([[[]], [['--']]])('%j needs a format', async (args) => {
    expect(await programPrintf(args)).toEqual([
      null,
      "printf: missing operand\nTry 'printf --help' for more information.\n",
      1,
    ])
  })

  it('stays silent as the builtin', async () => {
    const [out, io] = await handlePrintf(['x\n', 'a'], new SessionState({ sessionId: 's1' }))
    expect([DEC.decode(await materialize(out)), io.stderr, io.exitCode]).toEqual(['x\n', null, 0])
  })
})

// Each of these execs its command, so printf is coreutils' there.
describe('printf under a command runner', () => {
  it.each([
    ["env printf 'x\\n' a", 'a'],
    ["echo a | xargs printf 'x\\n'", 'a'],
    ["timeout 5 printf 'x\\n' a", 'a'],
    ["find /data -maxdepth 0 -exec printf 'x\\n' {} \\;", '/data'],
  ])('%s is the program', async (line, word) => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    const io = await ws.shell(line)
    expect([io.stdoutText, io.stderrText, io.exitCode]).toEqual(['x\n', excess(`'${word}'`), 0])
    await ws.close()
  })

  // A function one of them runs is shell code, whose printf is the shell's.
  it.each(['env g', 'echo a | xargs g', 'timeout 5 g'])(
    'a function %s runs has the builtin',
    async (runner) => {
      const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
      const io = await ws.shell(
        `g() { printf -v r ok; printf 'x\\n' extra; echo "[$r]"; }; ${runner}`,
      )
      expect([io.stdoutText, io.stderrText, io.exitCode]).toEqual(['x\n[ok]\n', '', 0])
      await ws.close()
    },
  )
})

it.each(['', 'env '])(
  'applies the command output limit after formatting for %s',
  async (prefix) => {
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      {
        commandLimits: { printf: new Limit({ maxBytes: 4 }) },
      },
    )
    try {
      const io = await ws.shell(prefix + "printf '%s' abcdefgh")
      expect(io.stdoutText).toBe('abcd')
      expect(io.exitCode).toBe(0)
      expect(io.stderrText).toContain('output truncated')
    } finally {
      await ws.close()
    }
  },
)

describe('printf in a pipeline', () => {
  it('keeps its status when its reader stops early', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    const io = await ws.shell(`printf '%d' bad | head -c 1; echo " \${PIPESTATUS[*]}"`)
    expect([io.stdoutText, io.stderrText]).toEqual([
      '0 1 0\n',
      'bash: printf: bad: invalid number\n',
    ])
    await ws.close()
  })
})
