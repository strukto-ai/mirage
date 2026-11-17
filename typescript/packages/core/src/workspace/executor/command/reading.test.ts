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
import { Follow, MountMode } from '../../../types.ts'
import { Workspace } from '../../workspace/workspace.ts'
import type { MountRegistry } from '../../mount/registry.ts'
import { linePaths, readLine } from './reading.ts'
import { classifyParts } from '../../expand/classify/index.ts'
import { lineFacts } from '../../lookup/index.ts'

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
  return (ctx.words ?? [])
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
      ['--file=', 'option', '--file', null],
      ['x', 'operand', null, '/workspace/outbox/x'],
    ],
  ],
  [
    'zgrep -f - x',
    ['/workspace/outbox/x'],
    [
      ['-f', 'option', null, null],
      ['-', 'value', '-f', null],
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
    'himalaya message reply 1 --attach rel.csv --body-file /slack/zz',
    ['/workspace/outbox/rel.csv', '/slack/zz'],
    [
      ['message', 'subcommand', null, null],
      ['reply', 'subcommand', null, null],
      ['1', 'operand', null, null],
      ['--attach', 'option', null, null],
      ['rel.csv', 'value', '--attach', '/workspace/outbox/rel.csv'],
      ['--body-file', 'option', null, null],
      ['/slack/zz', 'value', '--body-file', '/slack/zz'],
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
    ['/workspace/outbox/a', '/workspace/outbox/a/b'],
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
    ['/workspace/outbox/f.docx', '/'],
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
    for (const w of ctx.words ?? []) if (w.path) expect(all.has(w.path.virtual)).toBe(true)
  })
})

function tokens(reg: MountRegistry, name: string, argv: string[]): [string[], string[]] {
  const reading = readLine(reg, name, argv, [], '/')
  return [[...reading.tokens], [...reading.program]]
}

describe('readLine', () => {
  it("reads a tree's verb path and keeps the rest raw", async () => {
    const ram = new RAMVFS()
    const ws = new Workspace({ '/ram': ram }, { mode: MountMode.WRITE })
    try {
      ws.registerCli('git', cliSpecFor('git'))
      const reg = ws.registry
      // Options before the verb are not the verb; an alias reads as its
      // canonical name; the leaf's own words follow untouched.
      expect(tokens(reg, 'git', ['-C', '/r', 'reset', '--hard', 'HEAD'])).toEqual([
        ['git', 'reset', '--hard', 'HEAD'],
        ['git', 'reset'],
      ])
      expect(tokens(reg, 'git', ['log', '-1'])).toEqual([
        ['git', 'log', '-1'],
        ['git', 'log'],
      ])
      // A walk the tree refuses (unknown verb, bare head) reads raw.
      expect(tokens(reg, 'git', ['frobnicate', 'x'])).toEqual([['git', 'frobnicate', 'x'], ['git']])
      expect(tokens(reg, 'git', [])).toEqual([['git'], ['git']])
      // Anything else is the name and the raw argv.
      expect(tokens(reg, 'rm', ['-rf', '/x'])).toEqual([['rm', '-rf', '/x'], ['rm']])
      // A group option's value is never read as a verb, even one that
      // spells one (`-C status`, a directory named status).
      const words = readLine(reg, 'git', ['-C', 'status', 'log'], [], '/').words
      expect(words.map((w) => [w.text, w.kind, w.option])).toEqual([
        ['-C', 'option', null],
        ['status', 'value', '-C'],
        ['log', 'subcommand', null],
      ])
    } finally {
      await ws.close()
    }
  })
})

describe('what a policy sees', () => {
  async function seenByPolicy(line: string, setup = ''): Promise<CommandContext> {
    const seen: CommandContext[] = []
    const ws = new Workspace(
      { '/workspace': new RAMVFS(), '/slack': new RAMVFS() },
      {
        mode: MountMode.WRITE,
        policies: [
          {
            preCommand(ctx) {
              if (['cd', 'mkdir', 'ln', 'echo'].includes(ctx.command)) return null
              seen.push(ctx)
              return { kind: 'deny', reason: 'captured' }
            },
          },
        ],
      },
    )
    try {
      ws.registerCli('git', cliSpecFor('git'))
      ws.registerCli('pdfinfo', cliSpecFor('pdfinfo'))
      ws.registerCli('himalaya', HIMALAYA, {
        imap_host: 'h',
        smtp_host: 'h',
        username: 'u',
        password: 'p',
      })
      await ws.shell('mkdir -p /workspace/outbox')
      if (setup !== '') await ws.shell(setup)
      await ws.shell('cd /workspace/outbox')
      await ws.shell(line)
      const ctx = seen[seen.length - 1]
      if (ctx === undefined) throw new Error(`no command reached the policy: ${line}`)
      return ctx
    } finally {
      await ws.close()
    }
  }

  it.each([
    [
      'himalaya message reply 1 --attach ../../slack/export.csv',
      '../../slack/export.csv',
      '--attach',
    ],
    [
      'himalaya message reply 1 --attach=../../slack/export.csv',
      '--attach=../../slack/export.csv',
      '--attach',
    ],
    ['git -C ../../slack/export.csv log', '../../slack/export.csv', '-C'],
    ['git -C../../slack/export.csv log', '-C../../slack/export.csv', '-C'],
    ['pdfinfo ../../slack/export.csv', '../../slack/export.csv', null],
    ['tar -cf ../../slack/export.csv a.txt', '../../slack/export.csv', '-cf'],
    ['tar -cf../../slack/export.csv a.txt', '-cf../../slack/export.csv', '-cf'],
    ['tar -C ../.. -Cslack/export.csv -cf x.tar a.txt', '-Cslack/export.csv', '-C'],
    ['grep --file=../../slack/export.csv x', '--file=../../slack/export.csv', '--file'],
    ['grep -f../../slack/export.csv x', '-f../../slack/export.csv', '-f'],
  ])('a path word names the path paths holds: %s', async (line, text, option) => {
    const ctx = await seenByPolicy(line)
    const word = ctx.words?.find((w) => w.text === text)
    expect([word?.option, word?.toDict().path]).toEqual([option, '/slack/export.csv'])
    expect(ctx.paths.map((p) => p.virtual)).toContain('/slack/export.csv')
  })

  it.each([
    ['himalaya message reply 1 --attach x.csv', 'x.csv'],
    ['grep --file=x.csv y', '--file=x.csv'],
    ['tar -cf x.csv a.txt', 'x.csv'],
  ])('a policy sees the file a linked option value opens: %s', async (line, text) => {
    const ctx = await seenByPolicy(
      line,
      'echo s > /slack/export.csv && ln -s /slack/export.csv /workspace/outbox/x.csv',
    )
    const word = ctx.words?.find((w) => w.text === text)
    expect(word?.toDict().path).toBe('/workspace/outbox/x.csv')
    expect(ctx.paths.map((p) => p.virtual)).toContain('/slack/export.csv')
  })

  it.each(['grep --file= x', 'pdfinfo -'])(
    'a dash or an empty value names no file: %s',
    async (line) => {
      const virtuals = (await seenByPolicy(line)).paths.map((p) => p.virtual)
      expect(virtuals).not.toContain('/workspace/outbox')
      expect(virtuals).not.toContain('/workspace/outbox/-')
    },
  )

  it.each([
    [
      'git for-each-ref --fo x.txt',
      [
        ['--fo', 'option', null],
        ['x.txt', 'value', '--fo'],
      ],
    ],
    [
      'git reflog --help x.txt',
      [
        ['--help', 'option', null],
        ['x.txt', 'operand', null],
      ],
    ],
  ] as const)('a leaf word reads as the run parses it: %s', async (line, words) => {
    const seen = (await seenByPolicy(line)).words ?? []
    expect(seen.slice(-words.length).map((w) => [w.text, w.kind, w.option])).toEqual(words)
  })

  it('a dash-led group value is a value', async () => {
    const ctx = await seenByPolicy('git -C -x log')
    const word = ctx.words?.find((w) => w.text === '-x')
    expect([word?.kind, word?.option]).toEqual(['value', '-C'])
  })
})

async function virtuals(w: Workspace, name: string, ...args: string[]): Promise<string[]> {
  const words = await classifyParts([name, ...args], w.registry, '/')
  const reading = readLine(w.registry, name, args, words.slice(1), '/')
  const follows = lineFacts(name, words, '/').follows !== Follow.NONE
  return linePaths(name, reading, follows, w.namespace, '/').map((p) => p.virtual)
}

describe('linePaths', () => {
  it('line paths follow links only for a following command', async () => {
    const w = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    try {
      await w.shell('echo top > /data/secret && ln -s /data/secret /data/link')
      // cat opens the target: the typed path first, then what it resolves
      // to; rm and `ls -l` act on the link itself.
      expect(await virtuals(w, 'cat', '/data/link')).toEqual(['/data/link', '/data/secret'])
      expect(await virtuals(w, 'rm', '/data/link')).toEqual(['/data/link'])
      expect(await virtuals(w, 'ls', '-l', '/data/link')).toEqual(['/data/link'])
      expect(await virtuals(w, 'ls', '/data/link')).toEqual(['/data/link', '/data/secret'])
      // A path that is not a link reads once; no namespace reads typed.
      expect(await virtuals(w, 'cat', '/data/secret')).toEqual(['/data/secret'])
      const words = await classifyParts(['cat', '/data/link'], w.registry, '/')
      const reading = readLine(w.registry, 'cat', ['/data/link'], words.slice(1), '/')
      expect(linePaths('cat', reading, true, null, '/').map((p) => p.virtual)).toEqual([
        '/data/link',
      ])
    } finally {
      await w.close()
    }
  })
})
