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
import type { Context } from '../../commands/config.ts'
import { materialize } from '../../io/types.ts'
import { LanguageRuntime } from '../../runtime/language.ts'
import type { RunResult } from '../../runtime/types.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { MountMode } from '../../types.ts'
import { parse, syntaxRefusal } from '../../shell/parse/parse.ts'
import { Workspace } from '../workspace/workspace.ts'
import { parserAliases } from './command_dispatch.ts'

const DEC = new TextDecoder()

function makeWs(mounts: Record<string, RAMVFS> = { '/data': new RAMVFS() }): Workspace {
  return new Workspace(mounts, {
    mode: MountMode.WRITE,
  })
}

function text(bytes: Uint8Array | null): string {
  return bytes === null ? '' : DEC.decode(bytes)
}

describe('the empty operand', () => {
  it('is removed by nothing, rm -f included', async () => {
    // rm -f silences the empty name's ENOENT, and the bookkeeping after a
    // clean rm used to purge the node table under its `virtual`, the
    // working directory, taking every link there with it.
    const ws = makeWs()
    await ws.shell('mkdir -p /data/d; echo x > /data/d/f; ln -s f /data/d/l')
    const r = await ws.shell("cd /data/d && rm -rf ''")
    expect(r.exitCode).toBe(0)
    expect(ws.namespace.isLink('/data/d/l')).toBe(true)
    expect(text((await ws.shell('cat /data/d/f')).stdout)).toBe('x\n')
  })

  it('routes nowhere, so the line is not cross-mount', async () => {
    // Its `virtual` is the working directory, here the root mount, which
    // used to make the line span mounts it never names.
    const ws = makeWs()
    await ws.shell('echo a > /data/a.txt')
    const r = await ws.shell("cd / && cat '' /data/a.txt")
    expect(r.exitCode).toBe(1)
    expect(text(r.stdout)).toBe('a\n')
    expect(text(r.stderr)).toBe("cat: '': No such file or directory\n")
  })

  it('does not fan out over the mounts under the cwd', async () => {
    const ws = makeWs({ '/base': new RAMVFS(), '/base/inner': new RAMVFS() })
    for (const [line, err] of [
      ["du ''", 'du: invalid zero-length file name\n'],
      ["find ''", "find: '': No such file or directory\n"],
    ] as const) {
      const r = await ws.shell(`cd /base && ${line}`)
      expect(r.exitCode).toBe(1)
      expect(text(r.stdout)).toBe('')
      expect(text(r.stderr)).toBe(err)
    }
  })
})

describe('a link loop', () => {
  it('fails its operand, not the line', async () => {
    const ws = makeWs()
    await ws.shell(
      'echo a > /data/a.txt; echo b > /data/b.txt; ln -s /data/l2 /data/l1; ln -s /data/l1 /data/l2',
    )
    const r = await ws.shell('cat /data/a.txt /data/l1 /data/b.txt')
    expect(r.exitCode).toBe(1)
    expect(text(r.stdout)).toBe('a\nb\n')
    expect(text(r.stderr)).toBe('cat: /data/l1: Too many levels of symbolic links\n')
  })
})

class ShellsOut extends LanguageRuntime {
  readonly language = 'python'
  readonly name = 'shellsout'
  constructor() {
    super({ captures: ['python3'] })
  }
  async interpret(_engine: unknown, _program: unknown, ctx: Context): Promise<RunResult> {
    const nested = await ctx.shell?.('printenv TOKEN')
    return { stdout: await materialize(nested?.stdout ?? null), stderr: null, exitCode: 0 }
  }
}

// A run starts as its output is read, after dispatch returned, and the lines
// it shells out still run under its prefix assignment.
describe('a prefix assignment', () => {
  it.each(['TOKEN=one python3 -c x', 'TOKEN=one python3 -c x | cat'])(
    'reaches the lines %s shells out',
    async (line) => {
      const ws = new Workspace(
        { '/data': new RAMVFS() },
        { mode: MountMode.EXEC, runtimes: [new ShellsOut()] },
      )
      try {
        expect(text((await ws.shell(line)).stdout)).toBe('one\n')
        expect(text((await ws.shell('echo "[$TOKEN]"')).stdout)).toBe('[]\n')
      } finally {
        await ws.close()
      }
    },
  )
})

// Pinned against bash 5.2.37: a name stays reserved only inside the text its
// alias put there, a trailing blank's chained one included. Spans are in the
// line as typed, which a continuation shifts.
it.each([
  ['echo F; fi', [['fi', 0, 10]], 'fi'],
  ['echo F; fi', [['fi', 0, 7]], null],
  [
    'echo C; fi echo F',
    [
      ['c', 0, 11],
      ['fi', 11, 17],
    ],
    null,
  ],
  [
    'echo C; echo F; fi',
    [
      ['c', 0, 8],
      ['fi', 8, 18],
    ],
    'fi',
  ],
  ['echo F \\\n; fi', [['fi', 0, 13]], 'fi'],
  ['echo F \\\n; fi', [['fi', 0, 10]], null],
] as [string, [string, number, number][], string | null][])(
  'reads %j with alias text %j as %j',
  (line, spans, word) => {
    const owners = Array.from(
      { length: line.length },
      (_, at) =>
        new Set(spans.filter(([, start, end]) => start <= at && at < end).map(([name]) => name)),
    )
    const aliases = parserAliases(line, new Set(spans.map(([name]) => name)), owners)
    const io = syntaxRefusal(parse(line, aliases))
    expect(io === null ? null : new TextDecoder().decode(io.stderr as Uint8Array)).toBe(
      word === null ? null : `mirage: syntax error near '${word}'\n`,
    )
  },
)
