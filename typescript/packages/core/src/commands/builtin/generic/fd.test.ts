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
import { MountMode } from '../../../types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'
import { UsageError } from '../../errors.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import type { FlagValue } from '../../spec/types.ts'
import { batchArgv, execArgv, parseFlags } from './fd.ts'

const SETUP =
  'mkdir -p /w/r/.git /w/r/src/sub /w/r/docs /w/r/.hid /w/r/node_modules /w/r/emptyd && ' +
  'cd /w/r && touch src/a.ts src/B.ts src/sub/c.py docs/README.md .hid/x.ts .env ' +
  'node_modules/i.js AGENTS.md empty.txt && echo node_modules > .gitignore && ' +
  "echo hi > src/full.txt && printf 'B.ts\\n' > .fdignore && ln -s src/a.ts link.ts"

const flags = (bag: Record<string, FlagValue>, texts: string[] = []) =>
  parseFlags(new FlagView(bag, specOf('fd')), texts)

describe('parseFlags', () => {
  it('reads types, case and depths', () => {
    const f = flags({ type: ['e'], ignore_case: true, exact_depth: '2' })
    expect([...f.kinds.kinds].sort()).toEqual(['directory', 'file'])
    expect(f.kinds.empty).toBe(true)
    expect(f.ignoreCase).toBe(true)
    expect([f.maxDepth, f.minDepth]).toEqual([2, 2])
    expect(flags({}, ['Foo']).ignoreCase).toBe(false)
    expect(flags({}, ['[a-z]']).ignoreCase).toBe(true)
    expect(flags({ glob: true }, ['*.MD']).ignoreCase).toBe(false)
    const executable = flags({ type: ['x'] }).kinds
    expect([...executable.kinds]).toEqual(['file'])
    expect(executable.executable).toBe(true)
  })

  it.each([
    [
      { type: ['q'] },
      "error: invalid value 'q' for '--type <filetype>'\n  [possible values: file, directory, symlink, block-device, char-device, executable, empty, socket, pipe]",
    ],
    [
      { max_depth: 'abc' },
      "error: invalid value 'abc' for '--max-depth <depth>': invalid digit found in string",
    ],
    [{ exec: [] }, "error: a value is required for '--exec <cmd>...' but none was supplied"],
  ])('refuses %j in clap words', (bag, message) => {
    let caught: unknown
    try {
      flags(bag as Record<string, FlagValue>)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(UsageError)
    expect((caught as UsageError).message).toBe(`${message}\n\nFor more information, try '--help'.`)
    expect((caught as UsageError).exitCode).toBe(2)
  })
})

describe('exec placeholders', () => {
  it('fill or append', () => {
    expect(execArgv(['echo', '{/}', '{//}', '{.}', '{/.}'], './src/sub/c.py')).toEqual([
      'echo',
      'c.py',
      './src/sub',
      'src/sub/c',
      'c',
    ])
    expect(execArgv(['wc', '-l'], 'a.ts')).toEqual(['wc', '-l', 'a.ts'])
    expect(batchArgv(['echo', 'B'], ['a', 'b'])).toEqual(['echo', 'B', 'a', 'b'])
    expect(batchArgv(['echo', '<{}>', 'end'], ['a', 'b'])).toEqual(['echo', '<a>', '<b>', 'end'])
  })
})

async function run(...lines: string[]): Promise<string[]> {
  const ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE })
  const dec = new TextDecoder()
  const out: string[] = []
  try {
    for (const line of lines) {
      const io = await ws.shell(line)
      out.push(dec.decode(io.stdout) + dec.decode(io.stderr))
    }
  } finally {
    await ws.close()
  }
  return out
}

describe('fdGeneric', () => {
  it('lists sorted entries under ignore rules', async () => {
    const out = await run(
      SETUP,
      'cd /w/r && fd',
      "cd /w/r && fd -H -t f '^(AGENTS\\.md|\\.env)$'",
      'cd /w/r && fd -u i.js',
      'cd /w/r && fd -t d . src',
      'cd /w/r && fd -e ts -t l',
      'cd /w/r && fd -t e',
    )
    expect(out.slice(1)).toEqual([
      'AGENTS.md\ndocs/\ndocs/README.md\nempty.txt\nemptyd/\nlink.ts\nsrc/\nsrc/a.ts\nsrc/full.txt\nsrc/sub/\nsrc/sub/c.py\n',
      '.env\nAGENTS.md\n',
      'node_modules/i.js\n',
      'src/sub/\n',
      'link.ts\n',
      'AGENTS.md\ndocs/README.md\nempty.txt\nemptyd/\nsrc/a.ts\nsrc/sub/c.py\n',
    ])
  })

  it('runs a command per result or one for all', async () => {
    const out = await run(
      SETUP,
      "cd /w/r && fd '\\.py$' -x echo {/} {//}",
      'cd /w/r && fd -e ts . src -X echo B',
      'cd /w/r && fd -0 c.py | od -c | head -1',
    )
    expect(out.slice(1)).toEqual([
      'c.py ./src/sub\n',
      'B src/a.ts\n',
      '0000000   .   /   s   r   c   /   s   u   b   /   c   .   p   y  \\0\n',
    ])
  })

  it('reports search paths and patterns it cannot use', async () => {
    const out = await run(
      SETUP,
      'cd /w/r && fd c.py nosuch src; echo $?',
      'cd /w/r && fd c.py nosuch; echo $?',
      "cd /w/r && fd '['; echo $?",
      'cd /w/r && fd -q zzz; echo $?',
    )
    expect(out[1]).toBe("src/sub/c.py\n0\n[fd error]: Search path 'nosuch' is not a directory.\n")
    expect(out[2]).toBe(
      "1\n[fd error]: Search path 'nosuch' is not a directory.\n[fd error]: No valid search paths given.\n",
    )
    expect(
      out[3]?.startsWith(
        '1\n[fd error]: regex parse error:\n    [\n    ^\nerror: unclosed character class\n\nNote: ',
      ),
    ).toBe(true)
    expect(out[4]).toBe('1\n')
  })
  const HINT = "\n\nFor more information, try '--help'.\n"

  it('refuses arguments that cannot be used together', async () => {
    const out = await run(
      SETUP,
      'cd /w/r && fd -q -x echo {} a.ts',
      'cd /w/r && fd -1 -q -X echo \\;',
      'cd /w/r && fd a src --strip-cwd-prefix',
      'cd /w/r && fd -F -g x',
      'cd /w/r && fd -q --max-results 2 -1 zzz; echo $?',
    )
    expect(out[1]).toBe(
      "error: the argument '--quiet' cannot be used with:\n" +
        '  --exec <cmd>...\n  --exec-batch <cmd>...\n  --list-details\n\n' +
        `Usage: fd --quiet [pattern] [path]...${HINT}`,
    )
    expect(out[2]).toBe(
      "error: the argument '-1' cannot be used with:\n" +
        '  --exec-batch <cmd>...\n  --exec <cmd>...\n  --list-details\n\n' +
        `Usage: fd -1 --quiet [pattern] [path]...${HINT}`,
    )
    expect(out[3]).toBe(
      "error: the argument '[path]...' cannot be used with '--strip-cwd-prefix[=<when>]'\n\n" +
        `Usage: fd <pattern> <path>...${HINT}`,
    )
    expect(out[4]).toBe(
      "error: the argument '--fixed-strings' cannot be used with '--glob'\n\n" +
        `Usage: fd --fixed-strings <pattern> [path]...${HINT}`,
    )
    expect(out[5]).toBe('1\n')
  })

  it('lets the later of an overriding pair win', async () => {
    const out = await run(
      SETUP,
      'cd /w/r && fd -g --regex ts src',
      'cd /w/r && fd --regex -g ts src',
      'cd /w/r && fd -1 --max-results 2 -t f . src',
      'cd /w/r && fd --max-results 2 -1 -t f . src',
    )
    expect(out.slice(1)).toEqual(['src/a.ts\n', '', 'src/a.ts\nsrc/full.txt\n', 'src/a.ts\n'])
  })

  it('runs every repeated command', async () => {
    const out = await run(
      SETUP,
      'cd /w/r && fd -t f -x echo first {} \\; -x echo second {} \\; c.py',
      'cd /w/r && fd -t f -X echo one \\; -X echo two \\; c.py',
    )
    expect(out.slice(1)).toEqual([
      'first ./src/sub/c.py\nsecond ./src/sub/c.py\n',
      'one ./src/sub/c.py\ntwo ./src/sub/c.py\n',
    ])
  })

  it('roots excludes at its first search path', async () => {
    const out = await run(
      'mkdir -p /w/d/data/cache /w/d/src && touch /w/d/data/cache/x /w/d/src/a',
      'cd /w/d && fd -E /cache . data',
      'cd /w/d && fd -E /cache . src data',
      'cd / && fd -E /cache . /w/d/data',
    )
    expect(out.slice(1)).toEqual(['', 'data/cache/\ndata/cache/x\nsrc/a\n', ''])
  })

  it('keeps the first results in its order', async () => {
    const out = await run(
      SETUP,
      'cd /w/r && fd --max-results 2 -t f . src docs',
      'cd /w/r && fd -1 -t f',
    )
    expect(out.slice(1)).toEqual(['src/a.ts\nsrc/full.txt\n', 'AGENTS.md\n'])
  })

  it("stops at the mount's walk limit", async () => {
    const capped = new RAMVFS()
    capped.walkLimit = 2
    const ws = new Workspace({ '/': new RAMVFS(), '/m': capped }, { mode: MountMode.WRITE })
    try {
      await ws.shell('mkdir -p /m/d && touch /m/d/a /m/d/b /m/d/c')
      const io = await ws.shell('fd . /m/d')
      expect(io.exitCode).toBe(1)
      expect(new TextDecoder().decode(io.stdout)).toBe('/m/d/a\n/m/d/b\n')
      expect(new TextDecoder().decode(io.stderr)).toBe(
        '[fd error]: /m/d: stopped after 2 files (walk_limit); narrow the path\n',
      )
    } finally {
      await ws.close()
    }
  })

  it('keeps the rules around a bad ignore line', async () => {
    const out = await run(
      "mkdir -p /w/i && cd /w/i && touch a.log b.txt c.tmp && printf '[\\n*.log\\n' > .ignore && " +
        "printf '[1\\n*.tmp\\n' > one && printf '[2\\n[3\\n' > two",
      'cd /w/i && fd -t f . --ignore-file one',
      'cd /w/i && fd -t f . --ignore-file two',
    )
    expect(out[1]).toBe(
      'b.txt\none\ntwo\n[fd error]: Malformed pattern in custom ignore file. one: line 1: ' +
        "error parsing glob '[1': unclosed character class; missing ']'.\n",
    )
    expect(out[2]).toBe('b.txt\nc.tmp\none\ntwo\n')
  })

  it('matches ignore rules on the path it walked', async () => {
    const out = await run(
      'mkdir -p /w/L/repo /w/L/other && touch /w/L/other/a.log /w/L/other/b.txt && ' +
        "printf '*.log\\n' > /w/L/repo/.ignore && ln -s ../other /w/L/repo/link",
      'cd /w/L/repo && fd -L -t f',
    )
    expect(out[1]).toBe('link/b.txt\n')
  })
  it('refuses what it reads once its options parse', async () => {
    const out = await run(
      SETUP,
      'cd /w/r && fd -j 0 x; echo $?',
      "cd /w/r && fd -X './{/.}' a.ts; echo $?",
      'cd /w/r && fd -X echo {} {/} a.ts; echo $?',
      "cd /w/r && fd -E '[z-a]' x; echo $?",
    )
    const usage = '\n\nUsage: fd [OPTIONS] [pattern] [path]...'
    expect(out[1]).toBe(
      "2\nerror: invalid value '0' for '--threads <num>': number would be zero for non-zero type" +
        HINT,
    )
    expect(out[2]).toBe(
      `2\nerror: First argument of exec-batch is expected to be a fixed executable${usage}${HINT}`,
    )
    expect(out[3]).toBe(`2\nerror: Only one placeholder allowed for batch commands${usage}${HINT}`)
    expect(out[4]).toBe(
      "1\n[fd error]: Malformed exclude pattern: error parsing glob '![z-a]': invalid range; 'z' > 'a'\n",
    )
  })

  it('reads a bare --strip-cwd-prefix as always', async () => {
    const out = await run(SETUP, 'cd /w/r && fd -0 --strip-cwd-prefix c.py | od -c | head -1')
    expect(out[1]).toBe('0000000   s   r   c   /   s   u   b   /   c   .   p   y  \\0\n')
  })

  it('charges a linked mount its own walk limit', async () => {
    const capped = new RAMVFS()
    capped.walkLimit = 2
    const ws = new Workspace({ '/': new RAMVFS(), '/m': capped }, { mode: MountMode.WRITE })
    try {
      await ws.shell('mkdir -p /m/d /w && touch /m/d/a /m/d/b /m/d/c && ln -s /m/d /w/l')
      const io = await ws.shell('fd -L . /w')
      expect(io.exitCode).toBe(1)
      expect(new TextDecoder().decode(io.stdout)).toBe('/w/l/\n/w/l/a\n/w/l/b\n')
      expect(new TextDecoder().decode(io.stderr)).toBe(
        '[fd error]: /m: stopped after 2 files (walk_limit); narrow the path\n',
      )
    } finally {
      await ws.close()
    }
  })
})
