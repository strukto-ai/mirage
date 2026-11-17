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

import { HIMALAYA } from '../../../commands/cli/builtin/himalaya/index.ts'
import { cliSpecFor } from '../../../commands/cli/specs.ts'
import type { CommandContext } from '../../../policy/types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { MountMode } from '../../../types.ts'
import { Workspace } from '../../workspace/workspace.ts'

const SETUP = [
  'mkdir -p /workspace/outbox',
  'ln -s /slack/export.csv /workspace/outbox/x.csv',
  'ln -s /slack /workspace/outbox/s',
  'cd /workspace/outbox',
]

type Row = [string, string, string | null, string | null]

async function seen(line: string): Promise<CommandContext> {
  const captured: CommandContext[] = []
  const ws = new Workspace(
    { '/workspace': new RAMVFS(), '/slack': new RAMVFS() },
    {
      mode: MountMode.WRITE,
      policies: [
        {
          preCommand(ctx) {
            if (['cd', 'mkdir', 'ln'].includes(ctx.command)) return null
            captured.push(ctx)
            return { kind: 'deny', reason: 'captured' }
          },
        },
      ],
    },
  )
  try {
    for (const name of ['git', 'pdfinfo', 'office']) ws.registerCli(name, cliSpecFor(name))
    ws.registerCli('himalaya', HIMALAYA, {
      imap_host: 'h',
      smtp_host: 'h',
      username: 'u',
      password: 'p',
    })
    for (const step of SETUP) await ws.shell(step)
    await ws.shell(line)
    const ctx = captured[captured.length - 1]
    if (ctx === undefined) throw new Error(`no command reached the policy: ${line}`)
    return ctx
  } finally {
    await ws.close()
  }
}

function rows(ctx: CommandContext): Row[] {
  return ctx.words
    .slice(1)
    .map((w): Row => [w.text, w.kind, w.option ?? null, w.path?.virtual ?? null])
}

const LINES: [string, string[], Row[]][] = [
  [
    'cat a.txt a.txt',
    ['/workspace/outbox/a.txt', '/workspace/outbox/a.txt'],
    [
      ['a.txt', 'operand', null, '/workspace/outbox/a.txt'],
      ['a.txt', 'operand', null, '/workspace/outbox/a.txt'],
    ],
  ],
  [
    'sort -o out.txt in.txt',
    ['/workspace/outbox/out.txt', '/workspace/outbox/in.txt'],
    [
      ['-o', 'option', null, null],
      ['out.txt', 'value', '-o', '/workspace/outbox/out.txt'],
      ['in.txt', 'operand', null, '/workspace/outbox/in.txt'],
    ],
  ],
  [
    'grep -f a.txt -f b.txt x y.txt',
    [
      '/workspace/outbox/a.txt',
      '/workspace/outbox/b.txt',
      '/workspace/outbox/x',
      '/workspace/outbox/y.txt',
    ],
    [
      ['-f', 'option', null, null],
      ['a.txt', 'value', '-f', '/workspace/outbox/a.txt'],
      ['-f', 'option', null, null],
      ['b.txt', 'value', '-f', '/workspace/outbox/b.txt'],
      ['x', 'operand', null, '/workspace/outbox/x'],
      ['y.txt', 'operand', null, '/workspace/outbox/y.txt'],
    ],
  ],
  [
    'grep --file=a.txt pat b.txt',
    ['/workspace/outbox/pat', '/workspace/outbox/b.txt', '/workspace/outbox/a.txt'],
    [
      ['--file=a.txt', 'option', '--file', '/workspace/outbox/a.txt'],
      ['pat', 'operand', null, '/workspace/outbox/pat'],
      ['b.txt', 'operand', null, '/workspace/outbox/b.txt'],
    ],
  ],
  [
    'grep --file= x',
    ['/workspace/outbox/x'],
    [
      ['--file=', 'option', null, null],
      ['x', 'operand', null, '/workspace/outbox/x'],
    ],
  ],
  [
    'zgrep -f - x',
    ['/workspace/outbox/-', '/workspace/outbox/x'],
    [
      ['-f', 'option', null, null],
      ['-', 'value', '-f', '/workspace/outbox/-'],
      ['x', 'operand', null, '/workspace/outbox/x'],
    ],
  ],
  [
    'tar -C /slack -cf x.tar a.txt',
    ['/slack', '/workspace/outbox/x.tar', '/slack/a.txt'],
    [
      ['-C', 'option', null, null],
      ['/slack', 'value', '-C', '/slack'],
      ['-cf', 'option', null, null],
      ['x.tar', 'value', '-cf', '/workspace/outbox/x.tar'],
      ['a.txt', 'operand', null, '/slack/a.txt'],
    ],
  ],
  [
    'tar -C a -Cb -cf o.tar f',
    [
      '/workspace/outbox/a',
      '/workspace/outbox/o.tar',
      '/workspace/outbox/a/b/f',
      '/workspace/outbox/a/b',
    ],
    [
      ['-C', 'option', null, null],
      ['a', 'value', '-C', '/workspace/outbox/a'],
      ['-Cb', 'option', '-C', '/workspace/outbox/a/b'],
      ['-cf', 'option', null, null],
      ['o.tar', 'value', '-cf', '/workspace/outbox/o.tar'],
      ['f', 'operand', null, '/workspace/outbox/a/b/f'],
    ],
  ],
  ['ls', ['/workspace/outbox'], []],
  [
    'cat x.csv',
    ['/workspace/outbox/x.csv', '/slack/export.csv'],
    [['x.csv', 'operand', null, '/workspace/outbox/x.csv']],
  ],
  [
    'cat s/../x.csv',
    ['/workspace/outbox/x.csv', '/x.csv'],
    [['s/../x.csv', 'operand', null, '/workspace/outbox/x.csv']],
  ],
  [
    'cat a.txt > out.txt',
    ['/workspace/outbox/a.txt', '/workspace/outbox/out.txt'],
    [
      ['a.txt', 'operand', null, '/workspace/outbox/a.txt'],
      ['out.txt', 'redirect', null, '/workspace/outbox/out.txt'],
    ],
  ],
  [
    'himalaya message reply 1 --attach rel.csv /slack/zz',
    ['/slack/zz', '/workspace/outbox/rel.csv'],
    [
      ['message', 'subcommand', null, null],
      ['reply', 'subcommand', null, null],
      ['1', 'operand', null, null],
      ['--attach', 'option', null, null],
      ['rel.csv', 'value', '--attach', '/workspace/outbox/rel.csv'],
      ['/slack/zz', 'operand', null, '/slack/zz'],
    ],
  ],
  [
    'himalaya message reply 1 --attach=all.csv',
    ['/workspace/outbox/all.csv'],
    [
      ['message', 'subcommand', null, null],
      ['reply', 'subcommand', null, null],
      ['1', 'operand', null, null],
      ['--attach=all.csv', 'option', '--attach', '/workspace/outbox/all.csv'],
    ],
  ],
  [
    'himalaya message reply 1 --attach x.csv',
    ['/workspace/outbox/x.csv', '/slack/export.csv'],
    [
      ['message', 'subcommand', null, null],
      ['reply', 'subcommand', null, null],
      ['1', 'operand', null, null],
      ['--attach', 'option', null, null],
      ['x.csv', 'value', '--attach', '/workspace/outbox/x.csv'],
    ],
  ],
  [
    'himalaya message reply 1 --attach s/../x.csv',
    ['/workspace/outbox/x.csv', '/x.csv'],
    [
      ['message', 'subcommand', null, null],
      ['reply', 'subcommand', null, null],
      ['1', 'operand', null, null],
      ['--attach', 'option', null, null],
      ['s/../x.csv', 'value', '--attach', '/workspace/outbox/x.csv'],
    ],
  ],
  [
    'git -C ../../slack log',
    ['/slack'],
    [
      ['-C', 'option', null, null],
      ['../../slack', 'value', '-C', '/slack'],
      ['log', 'subcommand', null, null],
    ],
  ],
  [
    'git -C a -Cb log',
    ['/workspace/outbox/a/b', '/workspace/outbox/a'],
    [
      ['-C', 'option', null, null],
      ['a', 'value', '-C', '/workspace/outbox/a'],
      ['-Cb', 'option', '-C', '/workspace/outbox/a/b'],
      ['log', 'subcommand', null, null],
    ],
  ],
  [
    'git -C -x log',
    ['/workspace/outbox/-x'],
    [
      ['-C', 'option', null, null],
      ['-x', 'value', '-C', '/workspace/outbox/-x'],
      ['log', 'subcommand', null, null],
    ],
  ],
  [
    'pdfinfo rel.pdf',
    ['/workspace/outbox/rel.pdf'],
    [['rel.pdf', 'operand', null, '/workspace/outbox/rel.pdf']],
  ],
  ['pdfinfo -', [], [['-', 'operand', null, null]]],
  [
    'office get f.docx /',
    ['/', '/workspace/outbox/f.docx'],
    [
      ['get', 'subcommand', null, null],
      ['f.docx', 'operand', null, '/workspace/outbox/f.docx'],
      ['/', 'operand', null, '/'],
    ],
  ],
]

describe('a line read for a policy', () => {
  it.each(LINES)('%s: each word and the paths the line reaches', async (line, paths, words) => {
    const ctx = await seen(line)
    expect(ctx.paths.map((p) => p.virtual)).toEqual(paths)
    expect(rows(ctx)).toEqual(words)
  })

  it.each(LINES.map(([line]) => line))('%s: every path a word names is in paths', async (line) => {
    const ctx = await seen(line)
    const all = new Set(ctx.paths.map((p) => p.virtual))
    for (const w of ctx.words) if (w.path) expect(all.has(w.path.virtual)).toBe(true)
  })
})
