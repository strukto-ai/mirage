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

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it } from 'vitest'

import { CLISpec, type CLIVerbOpts } from '../commands/cli/types.ts'
import { Operand, Option } from '../commands/spec/types.ts'
import { IOResult } from '../io/types.ts'
import { OpsRegistry } from '../ops/registry.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { createShellParser, type ShellParser } from '../shell/parse.ts'
import { MountMode, type PathSpec } from '../types.ts'
import { Workspace } from './workspace.ts'

// Mirrors python/tests/e2e/test_cli_dispatch.py.

const require = createRequire(import.meta.url)
const engineWasm = readFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'))
const grammarWasm = readFileSync(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))

let parser: ShellParser

beforeAll(async () => {
  parser = await createShellParser({ engineWasm, grammarWasm })
})

const dec = new TextDecoder()

function tokenConfig(input: Record<string, unknown>): { token: string } {
  if (typeof input.token !== 'string') throw new Error('token is required')
  return { token: input.token }
}

function send(
  config: unknown,
  paths: PathSpec[],
  texts: string[],
  opts: CLIVerbOpts,
): [Uint8Array, IOResult] {
  const token = (config as { token: string }).token
  const to = opts.flags.to
  const body = texts.join(' ')
  return [new TextEncoder().encode(`sent[${token}] to=${String(to)}: ${body}\n`), new IOResult()]
}

function makeTree(): CLISpec {
  return new CLISpec({
    name: 'slackish',
    configModel: tokenConfig,
    subcommands: [
      new CLISpec({
        name: 'message',
        subcommands: [
          new CLISpec({
            name: 'send',
            fn: send,
            write: true,
            options: [new Option({ short: '-t', long: '--to', type: 'str', required: true })],
            rest: new Operand({ type: 'str' }),
          }),
        ],
      }),
    ],
  })
}

function buildWorkspace(): Workspace {
  const ram = new RAMResource()
  const registry = new OpsRegistry()
  registry.registerResource(ram)
  return new Workspace(
    { '/data': ram },
    { mode: MountMode.WRITE, ops: registry, shellParser: parser },
  )
}

describe('CLI dispatch e2e', () => {
  it('two accounts dispatch by installed name', async () => {
    const ws = buildWorkspace()
    const tree = makeTree()
    ws.registerCli('slackish', tree, { token: 'eng' })
    ws.registerCli('slackish-sup', tree, { token: 'sup' })
    const eng = await ws.execute("slackish message send -t '#e' hi")
    expect([eng.exitCode, dec.decode(eng.stdout)]).toEqual([0, 'sent[eng] to=#e: hi\n'])
    const sup = await ws.execute("slackish-sup message send -t '#s' yo")
    expect([sup.exitCode, dec.decode(sup.stdout)]).toEqual([0, 'sent[sup] to=#s: yo\n'])
  })

  it('a renamed install attributes to its own head', async () => {
    const ws = buildWorkspace()
    ws.registerCli('sl', makeTree(), { token: 't' })
    const bogus = await ws.execute('sl bogus')
    expect(bogus.exitCode).toBe(1)
    expect(dec.decode(bogus.stderr)).toBe("sl: 'bogus' is not a sl command. See 'sl --help'.\n")
    const help = await ws.execute('sl message send --help')
    expect(help.exitCode).toBe(0)
    expect(dec.decode(help.stdout).startsWith('sl message send\n')).toBe(true)
  })

  it('leaf usage errors exit 2', async () => {
    const ws = buildWorkspace()
    ws.registerCli('sl', makeTree(), { token: 't' })
    const res = await ws.execute('sl message send hi')
    expect(res.exitCode).toBe(2)
    expect(dec.decode(res.stderr)).toMatch(/^sl message send: option '--to' is required/)
  })

  it('unregister returns the name to 127', async () => {
    const ws = buildWorkspace()
    ws.registerCli('sl', makeTree(), { token: 't' })
    ws.unregisterCli('sl')
    const res = await ws.execute('sl message send -t x hi')
    expect(res.exitCode).toBe(127)
    expect(dec.decode(res.stderr)).toContain('sl: command not found')
  })

  it('a CLI head never resolves a mount', async () => {
    const ws = buildWorkspace()
    ws.registerCli('sl', makeTree(), { token: 't' })
    const res = await ws.execute('sl message send -t x /data/a.txt')
    expect(res.exitCode).toBe(0)
    expect(dec.decode(res.stdout)).toBe('sent[t] to=x: /data/a.txt\n')
  })

  it('the clis constructor option installs through the same path', async () => {
    const ram = new RAMResource()
    const registry = new OpsRegistry()
    registry.registerResource(ram)
    const ws = new Workspace(
      { '/data': ram },
      {
        mode: MountMode.WRITE,
        ops: registry,
        shellParser: parser,
        clis: { sl: [makeTree(), { token: 'opt' }] },
      },
    )
    const res = await ws.execute('sl message send -t x hi')
    expect([res.exitCode, dec.decode(res.stdout)]).toEqual([0, 'sent[opt] to=x: hi\n'])
  })
})

describe('policy cli fact', () => {
  it('the policy sees the installed head on ctx.commands', async () => {
    const seen: (string | null)[] = []
    const ram = new RAMResource()
    const ops = new OpsRegistry()
    ops.registerResource(ram)
    const ws = new Workspace(
      { '/data': ram },
      {
        mode: MountMode.WRITE,
        ops,
        shellParser: parser,
        policy: (ctx) => {
          seen.push(ctx.commands[0]?.cli ?? null)
          if (ctx.commands[0]?.cli === 'slack-eng') return { deny: 'cli lines are frozen' }
          return null
        },
      },
    )
    ws.registerCli('slack-eng', makeTree(), { token: 'tok' })
    const r = await ws.execute('slack-eng message send -t x hi')
    expect(r.exitCode).toBe(126)
    expect(r.stderrText).toContain('policy denied')
    expect(seen.at(-1)).toBe('slack-eng')
    const ok = await ws.execute('echo unaffected')
    expect(ok.exitCode).toBe(0)
    expect(seen.at(-1)).toBeNull()
    await ws.close()
  })
})
