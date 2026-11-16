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
import { specOf } from '../../../commands/spec/builtins.ts'
import { CommandSpec, Argument } from '../../../commands/spec/types.ts'
import { DeviceInput } from '../../../io/types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { MountMode, PathSpec } from '../../../types.ts'
import { Workspace } from '../../workspace/workspace.ts'
import { runResult } from '../../../../tests/workspace/fixtures/integration_fixture.ts'
import {
  commandWords,
  defaultCwdOperand,
  optionLoopExits,
  pathFlagScopes,
  programTokens,
  routableScopes,
} from './routing.ts'

describe('optionLoopExits', () => {
  it.each([
    [['--version', '.', '/a', '/b'], true],
    [['.', '/a', '/b', '-V'], true],
    [['--help', '.', '/a', '/b'], true],
    [['--bogus', '.', '/a', '/b'], true],
    [['.', '--', '--version', '/a', '/b'], false],
    [['--arg', 'x', '--version', '.', '/a', '/b'], false],
    [['.', '/a', '/b'], false],
  ] as const)('recognizes only parsed early answers in %j', (argv, expected) => {
    expect(optionLoopExits('jq', specOf('jq'), [...argv], '/')).toBe(expected)
  })

  it('does not apply builtin exit rules to custom grammars', () => {
    const spec = new CommandSpec({
      arguments: [new Argument('--version', { action: 'store_true' })],
    })
    expect(optionLoopExits('jq', spec, ['--version'], '/')).toBe(false)
    expect(optionLoopExits('jq', null, ['--version'], '/')).toBe(false)
  })
})

describe('routableScopes', () => {
  it('drops awk assignment operands', () => {
    const a = new PathSpec({ virtual: '/m/a', directory: '/m', vfsPath: '', rawPath: '/m/a' })
    const assign = new PathSpec({ virtual: '/x=1', directory: '/', vfsPath: '', rawPath: 'x=1' })
    const b = new PathSpec({ virtual: '/m/b', directory: '/m', vfsPath: '', rawPath: '/m/b' })
    expect(routableScopes('awk', [a, assign, b]).map((p) => p.virtual)).toEqual(['/m/a', '/m/b'])
    expect(routableScopes('cat', [a, assign, b])).toEqual([a, assign, b])
  })

  it("keeps a dash that names an output: split's PREFIX", () => {
    const src = new PathSpec({ virtual: '/m/in', directory: '/m', vfsPath: '', rawPath: '/m/in' })
    const dash = new PathSpec({ virtual: '/m/-', directory: '/m', vfsPath: '', rawPath: '-' })
    expect(routableScopes('split', [src, dash])).toEqual([src, dash])
    expect(routableScopes('split', [dash, src])).toEqual([src])
    expect(routableScopes('cat', [src, dash])).toEqual([src])
  })

  it('keeps an awk line with an assignment operand on one mount', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    try {
      await runResult(ws, "printf '1\\n' > /data/a; printf '2\\n' > /data/b")
      expect(await runResult(ws, "awk '{print x, $0}' /data/a x=5 /data/b")).toEqual([
        0,
        ' 1\n5 2\n',
        '',
      ])
    } finally {
      await ws.close()
    }
  })
})

describe('pathFlagScopes', () => {
  it.each([
    ['grep', '-f'],
    ['rg', '-f'],
    ['zgrep', '-f'],
    ['sed', '-f'],
    ['awk', '-f'],
    ['jq', '--from-file'],
  ])('leaves %s %s program file out', (cmd, flag) => {
    // The program file is read before routing, so a pattern file on
    // another mount does not make the line cross-mount, for every command
    // that reads one: the keys come from the reader's own table.
    expect(pathFlagScopes(cmd, [flag, '/other/p', '/data/in'], '/')).toEqual([])
  })

  it.each([
    ['grep', ['--exclude-from', '/other/skip.lst', 'foo', '/data/in']],
    ['curl', ['-o', '/other/body', '-D', '/data/h', 'http://x.test/']],
    ['curl', ['--dump-header', '-', '--output', '/other/body', 'http://x.test/']],
    ['jq', ['--slurpfile', 's', '/other/s.json', '--rawfile', 'r', '/dev/fd/63', '.']],
  ])('leaves the files %s reads or writes through the dispatcher out', (cmd, argv) => {
    // The handler reaches them through the dispatcher, so they name no
    // mount the line has to run on (DISPATCH_FLAG_KEYS).
    expect(pathFlagScopes(cmd, argv, '/')).toEqual([])
  })
})

describe('programTokens', () => {
  it('walks a CLI verb path and keeps the rest raw', async () => {
    const ram = new RAMVFS()
    const ws = new Workspace({ '/ram': ram }, { mode: MountMode.WRITE })
    try {
      ws.registerCli('git', cliSpecFor('git'))
      const reg = ws.registry
      // Options before the verb are not the verb; an alias reads as its
      // canonical name; the leaf's own words follow untouched.
      expect(programTokens(reg, 'git', ['-C', '/r', 'reset', '--hard', 'HEAD'], '/')).toEqual([
        ['git', 'reset', '--hard', 'HEAD'],
        ['git', 'reset'],
      ])
      expect(programTokens(reg, 'git', ['log', '-1'], '/')).toEqual([
        ['git', 'log', '-1'],
        ['git', 'log'],
      ])
      // A walk the tree refuses (unknown verb, bare head) reads raw.
      expect(programTokens(reg, 'git', ['frobnicate', 'x'], '/')).toEqual([
        ['git', 'frobnicate', 'x'],
        ['git'],
      ])
      expect(programTokens(reg, 'git', [], '/')).toEqual([['git'], ['git']])
      // Anything else is the name and the raw argv.
      expect(programTokens(reg, 'rm', ['-rf', '/x'], '/')).toEqual([['rm', '-rf', '/x'], ['rm']])
      // A group option's value is never read as a verb, even one that
      // spells one (`-C status`, a directory named status).
      const words = commandWords(reg, 'git', ['-C', 'status', 'log'], [], [], '/')
      expect(words.map((w) => [w.text, w.kind, w.option])).toEqual([
        ['git', 'name', null],
        ['-C', 'option', null],
        ['status', 'value', '-C'],
        ['log', 'subcommand', null],
      ])
    } finally {
      await ws.close()
    }
  })
})

describe('commandWords', () => {
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
  ])('a path word names the path paths holds: %s', async (line, text, option) => {
    const seen: CommandContext[] = []
    const ws = new Workspace(
      { '/workspace': new RAMVFS(), '/slack': new RAMVFS() },
      {
        mode: MountMode.WRITE,
        policies: [
          {
            preCommand(ctx) {
              if (ctx.command === 'cd' || ctx.command === 'mkdir') return null
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
      await ws.shell('cd /workspace/outbox')
      await ws.shell(line)
      const ctx = seen[seen.length - 1]
      const word = ctx?.words?.find((w) => w.text === text)
      expect([word?.option, word?.toDict().path]).toEqual([option, '/slack/export.csv'])
      expect(ctx?.paths.map((p) => p.virtual)).toContain('/slack/export.csv')
    } finally {
      await ws.close()
    }
  })
})

describe('defaultCwdOperand', () => {
  it('searches the cwd once rg -f - takes stdin', async () => {
    // ripgrep 14.1.1: an attached stdin wins over the cwd, but `-f -` reads
    // it for patterns first, which leaves only the cwd to search. The `-`
    // arrives classified, so its spelling is what says stdin.
    const ws = new Workspace({ '/ram': new RAMVFS() }, { mode: MountMode.WRITE })
    try {
      const reg = ws.registry
      const stdin = new TextEncoder().encode('a\n')
      const dash = new PathSpec({
        virtual: '/ram/-',
        directory: '/ram/',
        vfsPath: '',
        resolved: true,
        rawPath: '-',
      })
      expect(defaultCwdOperand(['rg', '-f', dash], 'rg', reg, '/ram', stdin)?.rawPath).toBe('')
      const file = new PathSpec({ virtual: '/ram/p', directory: '/ram/', vfsPath: '' })
      expect(defaultCwdOperand(['rg', '-f', file], 'rg', reg, '/ram', stdin)).toBeNull()
      expect(defaultCwdOperand(['rg', 'a'], 'rg', reg, '/ram', stdin)).toBeNull()
    } finally {
      await ws.close()
    }
  })

  it('searches the cwd when rg stdin is a device', async () => {
    // ripgrep 14.1.1 searches stdin only when a file, FIFO or socket is
    // attached (grep_cli::is_readable_stdin): `rg a < /dev/null` searches the
    // cwd, while an empty file or pipe is still searched.
    const ws = new Workspace({ '/ram': new RAMVFS() }, { mode: MountMode.WRITE })
    try {
      const reg = ws.registry
      const device = new DeviceInput(0)
      expect(defaultCwdOperand(['rg', 'a'], 'rg', reg, '/ram', device)?.rawPath).toBe('')
      expect(defaultCwdOperand(['rg', 'a'], 'rg', reg, '/ram', new Uint8Array(0))).toBeNull()
    } finally {
      await ws.close()
    }
  })
})
