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

import { CLISpec, type CLIVerbFn, type CLIVerbOpts } from '../../../commands/cli/types.ts'
import { Operand, Option } from '../../../commands/spec/types.ts'
import { IOResult, materialize } from '../../../io/types.ts'
import { Limit, type PathSpec } from '../../../types.ts'
import type { CLIInstall } from '../../cli/types.ts'
import { Session } from '../../session/session.ts'
import { handleCli } from './cli.ts'

// Mirrors python/tests/workspace/executor/command/test_cli.py.

interface Call {
  config: unknown
  paths: PathSpec[]
  texts: string[]
  opts: CLIVerbOpts
}

const calls: Call[] = []
const dec = new TextDecoder()

function send(
  config: unknown,
  paths: PathSpec[],
  texts: string[],
  opts: CLIVerbOpts,
): [Uint8Array, IOResult] {
  calls.push({ config, paths, texts, opts })
  const token = (config as { token: string }).token
  return [new TextEncoder().encode(`sent[${token}]\n`), new IOResult()]
}

function makeInstall(name = 'prog'): CLIInstall {
  const spec = new CLISpec({
    name: 'prog',
    configModel: (input) => input,
    options: [new Option({ short: '-v', long: '--verbose', count: true })],
    subcommands: [
      new CLISpec({
        name: 'message',
        subcommands: [
          new CLISpec({
            name: 'send',
            fn: send,
            options: [new Option({ short: '-t', long: '--to', type: 'str', required: true })],
            rest: new Operand({ type: 'str' }),
          }),
        ],
      }),
    ],
  })
  return { name, spec, config: { token: 'tok' } }
}

describe('handleCli', () => {
  it('runs the leaf with config, group flags, and texts', async () => {
    calls.length = 0
    const install = makeInstall()
    const parts = ['prog', '-vv', 'message', 'send', '-t', '#eng', 'hello', 'world']
    const [stdout, io, node] = await handleCli(install, parts, new Session({ sessionId: 't' }))
    expect(io.exitCode).toBe(0)
    expect(dec.decode(await materialize(stdout))).toBe('sent[tok]\n')
    const call = calls.pop()
    expect((call?.config as { token: string }).token).toBe('tok')
    expect(call?.texts).toEqual(['hello', 'world'])
    expect(call?.opts.flags.to).toBe('#eng')
    expect(call?.opts.flags.verbose).toBe(2)
    expect(node.command).toBe('prog -vv message send -t #eng hello world')
  })

  it('refuses an unknown verb with git wording, exit 1', async () => {
    const install = makeInstall('renamed')
    const [, io, node] = await handleCli(
      install,
      ['renamed', 'bogus'],
      new Session({ sessionId: 't' }),
    )
    expect(io.exitCode).toBe(1)
    expect(dec.decode(await materialize(io.stderr))).toBe(
      "renamed: 'bogus' is not a renamed command. See 'renamed --help'.\n",
    )
    expect(node.exitCode).toBe(1)
  })

  it('bare group prints usage to stdout, exit 1', async () => {
    const install = makeInstall()
    const [stdout, io] = await handleCli(
      install,
      ['prog', 'message'],
      new Session({ sessionId: 't' }),
    )
    expect(io.exitCode).toBe(1)
    const out = dec.decode(await materialize(stdout))
    expect(out).toContain('Usage: prog message')
    expect(out).toContain('send')
  })

  it('leaf --help prints the installed prog, exit 0', async () => {
    const install = makeInstall('renamed')
    const [stdout, io] = await handleCli(
      install,
      ['renamed', 'message', 'send', '--help'],
      new Session({ sessionId: 't' }),
    )
    expect(io.exitCode).toBe(0)
    const out = dec.decode(await materialize(stdout))
    expect(out.startsWith('renamed message send\n')).toBe(true)
    expect(out).toContain('--help')
  })

  it('leaf usage errors exit 2 with prog attribution', async () => {
    const install = makeInstall()
    const [, io] = await handleCli(
      install,
      ['prog', 'message', 'send', 'hi'],
      new Session({ sessionId: 't' }),
    )
    expect(io.exitCode).toBe(2)
    expect(dec.decode(await materialize(io.stderr))).toMatch(
      /^prog message send: option '--to' is required/,
    )
  })

  it('the leaf limit bounds the handler', async () => {
    // The declared limit wraps the handler body like mount
    // dispatch: a blocking leaf times out instead of hanging.
    const slow: CLIVerbFn = async () => {
      await new Promise((resolve) => setTimeout(resolve, 500))
      return [null, new IOResult()]
    }
    const spec = new CLISpec({
      name: 'prog',
      subcommands: [
        new CLISpec({
          name: 'run',
          fn: slow,
          limit: new Limit({ timeoutSeconds: 0.05 }),
        }),
      ],
    })
    const install: CLIInstall = { name: 'prog', spec, config: null }
    await expect(
      handleCli(install, ['prog', 'run'], new Session({ sessionId: 't' })),
    ).rejects.toThrow(/prog run: timed out/)
  })

  it('injects stdin into the opts bag', async () => {
    calls.length = 0
    const install = makeInstall()
    const stdin = new TextEncoder().encode('body')
    await handleCli(
      install,
      ['prog', 'message', 'send', '-t', 'x'],
      new Session({ sessionId: 't' }),
      stdin,
    )
    expect(calls.pop()?.opts.stdin).toBe(stdin)
  })
})
