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

import { Outcome } from '../policy/index.ts'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it } from 'vitest'

import { CLISpec, type CLIInvocation } from '../commands/cli/types.ts'
import { Operand, Option } from '../commands/spec/types.ts'
import { IOResult } from '../io/types.ts'
import type { Policy } from '../policy/base.ts'
import type { Action, SessionContext } from '../policy/types.ts'
import { OpsRegistry } from '../ops/registry.ts'
import { RAMResource } from '../resource/ram/ram.ts'
import { createShellParser, type ShellParser } from '../shell/parse/index.ts'
import { MountMode } from '../types.ts'
import { ScriptSource } from '../runtime/routing/types.ts'
import type { RuntimeLanguage } from '../runtime/types.ts'
import { Workspace } from './workspace/workspace.ts'

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

function send(inv: CLIInvocation): [Uint8Array, IOResult] {
  const token = (inv.config as { token: string }).token
  const to = inv.flags.to
  const body = inv.texts.join(' ')
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

  it('command tiers key on the installed name', async () => {
    // Two installs of one spec are two subjects: allow installs one
    // head word and not the other, deny and ask rules name one install
    // and leave its twin alone, and a grant runs the line under the
    // granted install's own config.
    const ram = new RAMResource()
    const registry = new OpsRegistry()
    registry.registerResource(ram)
    const ws = new Workspace(
      { '/data': ram },
      {
        mode: MountMode.WRITE,
        ops: registry,
        shellParser: parser,
        profiles: {
          crew: {
            commands: {
              allow: ['h1', 'h2', 'type'],
              ask: [{ reason: 'outbound needs a nod', commands: ['h1 message send'] }],
              deny: [{ reason: 'beta is read-only', commands: ['h2 message send'] }],
            },
          },
          solo: { commands: { allow: ['h1', 'type'] } },
        },
      },
    )
    const tree = makeTree()
    ws.registerCli('h1', tree, { token: 'one' })
    ws.registerCli('h2', tree, { token: 'two' })
    ws.createSession('c', { profile: 'crew' })
    ws.createSession('s', { profile: 'solo' })
    const denied = await ws.execute('h2 message send -t x hi', { sessionId: 'c' })
    expect([denied.exitCode, dec.decode(denied.stderr)]).toEqual([126, 'h2: Permission denied\n'])
    expect(denied.refusal?.reason).toBe('beta is read-only')
    const asked = await ws.execute('h1 message send -t x hi', { sessionId: 'c' })
    expect(asked.exitCode).toBe(126)
    expect(dec.decode(asked.stderr)).toBe('h1: Permission denied\n')
    expect(asked.refusal?.kind).toBe('pending')
    expect(asked.refusal?.reason.startsWith('outbound needs a nod')).toBe(true)
    const request = ws.decisions.pending()[0]
    if (request === undefined) throw new Error('no pending approval')
    expect(request.command).toBe('h1')
    await ws.decisions.answer(request.id, Outcome.ALLOW)
    const granted = await ws.execute('h1 message send -t x hi', { sessionId: 'c' })
    expect([granted.exitCode, dec.decode(granted.stdout)]).toEqual([0, 'sent[one] to=x: hi\n'])
    const missing = await ws.execute('h2 message send -t x hi', { sessionId: 's' })
    expect(missing.exitCode).toBe(127)
    expect(dec.decode(missing.stderr)).toContain('h2: command not found')
    const typed = await ws.execute('type -t h1; type -t h2', { sessionId: 's' })
    expect([typed.exitCode, dec.decode(typed.stdout)]).toEqual([1, 'cli\n'])
    const listed = await ws.execute('h1 message send -t x hi', { sessionId: 's' })
    expect([listed.exitCode, dec.decode(listed.stdout)]).toEqual([0, 'sent[one] to=x: hi\n'])
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

function buildScriptWorkspace(): Workspace {
  const ram = new RAMResource()
  const registry = new OpsRegistry()
  registry.registerResource(ram)
  return new Workspace(
    { '/data': ram },
    {
      mode: MountMode.WRITE,
      ops: registry,
      shellParser: parser,
      runtimes: ['monty', 'quickjs', 'vfs'],
    },
  )
}

function pagerSpec(source: string, language: RuntimeLanguage = 'python'): CLISpec {
  return new CLISpec({ name: 'pager', script: new ScriptSource(source, language) })
}

describe('script CLI e2e', () => {
  it('a python script CLI runs on monty with verbatim argv', async () => {
    const ws = buildScriptWorkspace()
    try {
      ws.registerCli('pager', pagerSpec("print('paged', argv[1])"))
      const res = await ws.execute('pager report.txt')
      expect([res.exitCode, dec.decode(res.stdout)]).toEqual([0, 'paged report.txt\n'])
    } finally {
      await ws.close()
    }
  }, 60_000)

  it('the install config arrives as MIRAGE_CLI_CONFIG', async () => {
    const ws = buildScriptWorkspace()
    try {
      ws.registerCli('pager', pagerSpec("import os\nprint(os.getenv('MIRAGE_CLI_CONFIG'))"), {
        width: 80,
      })
      const res = await ws.execute('pager')
      expect([res.exitCode, dec.decode(res.stdout)]).toEqual([0, '{"width":80}\n'])
    } finally {
      await ws.close()
    }
  }, 60_000)

  it('the script receives its own flags', async () => {
    // A yaml clis entry declares no grammar, so mirage must not refuse
    // flags on the program's behalf; the program is the parser.
    const ws = buildScriptWorkspace()
    try {
      ws.registerCli('pager', pagerSpec("print('paged', argv[1:])"))
      const res = await ws.execute('pager --width 80 -n report.txt')
      expect([res.exitCode, dec.decode(res.stdout)]).toEqual([
        0,
        "paged ['--width', '80', '-n', 'report.txt']\n",
      ])
    } finally {
      await ws.close()
    }
  }, 60_000)

  it('the script answers its own --help', async () => {
    const ws = buildScriptWorkspace()
    try {
      ws.registerCli('pager', pagerSpec("print('program usage', argv[1:])"))
      const res = await ws.execute('pager --help')
      expect([res.exitCode, dec.decode(res.stdout)]).toEqual([0, "program usage ['--help']\n"])
    } finally {
      await ws.close()
    }
  }, 60_000)

  it('man promises no --help flag for it', async () => {
    const ws = buildScriptWorkspace()
    try {
      ws.registerCli('pager', pagerSpec("print('hi')"))
      const res = await ws.execute('man pager')
      const out = dec.decode(res.stdout)
      expect(res.exitCode).toBe(0)
      expect(out.startsWith('pager\n')).toBe(true)
      expect(out).not.toContain('--help')
    } finally {
      await ws.close()
    }
  }, 60_000)

  it('piped stdin reaches the script', async () => {
    const ws = buildScriptWorkspace()
    try {
      ws.registerCli('pager', pagerSpec('print(stdin.decode())'))
      const res = await ws.execute('echo body | pager')
      expect([res.exitCode, dec.decode(res.stdout)]).toEqual([0, 'body\n\n'])
    } finally {
      await ws.close()
    }
  }, 60_000)

  it('a crash surfaces as stderr and $?', async () => {
    const ws = buildScriptWorkspace()
    try {
      ws.registerCli('pager', pagerSpec("raise ValueError('nope')"))
      const res = await ws.execute('pager')
      expect(res.exitCode).toBe(1)
      expect(dec.decode(res.stderr)).toContain('ValueError')
      const status = await ws.execute('pager; echo status=$?')
      expect(dec.decode(status.stdout)).toContain('status=1')
    } finally {
      await ws.close()
    }
  }, 60_000)

  it('a js script CLI runs on quickjs', async () => {
    const ws = buildScriptWorkspace()
    try {
      // scriptArgs[0] is the installed name, like a qjs script's path.
      ws.registerCli(
        'pager',
        pagerSpec("console.log('paged-js', scriptArgs[0], scriptArgs[1])", 'js'),
      )
      const res = await ws.execute('pager report.txt')
      expect([res.exitCode, dec.decode(res.stdout)]).toEqual([0, 'paged-js pager report.txt\n'])
    } finally {
      await ws.close()
    }
  }, 60_000)

  it('a shell function shadows a script CLI', async () => {
    // The one agent-side override, bash's own rule: function beats
    // CLI, reversible with unset -f.
    const ws = buildScriptWorkspace()
    try {
      ws.registerCli('pager', pagerSpec("print('from-script')"))
      await ws.execute('pager() { echo from-function; }')
      const shadowed = await ws.execute('pager')
      expect([shadowed.exitCode, dec.decode(shadowed.stdout)]).toEqual([0, 'from-function\n'])
      await ws.execute('unset -f pager')
      const unshadowed = await ws.execute('pager')
      expect([unshadowed.exitCode, dec.decode(unshadowed.stdout)]).toEqual([0, 'from-script\n'])
    } finally {
      await ws.close()
    }
  }, 60_000)

  it('a script CLI line records in history', async () => {
    const ws = buildScriptWorkspace()
    try {
      ws.registerCli('pager', pagerSpec("print('hi')"))
      await ws.execute('pager report.txt')
      const res = await ws.execute('history 2')
      expect(res.exitCode).toBe(0)
      expect(dec.decode(res.stdout)).toContain('pager report.txt')
    } finally {
      await ws.close()
    }
  }, 60_000)
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
        routePolicy: (ctx) => {
          seen.push(ctx.commands[0]?.cli ?? null)
          if (ctx.commands[0]?.cli === 'slack-eng') return { deny: 'cli lines are frozen' }
          return null
        },
      },
    )
    ws.registerCli('slack-eng', makeTree(), { token: 'tok' })
    const r = await ws.execute('slack-eng message send -t x hi')
    expect(r.exitCode).toBe(126)
    expect(r.stderrText).toBe('slack-eng: Permission denied\n')
    expect(r.refusal?.kind).toBe('deny')
    expect(seen.at(-1)).toBe('slack-eng')
    const ok = await ws.execute('echo unaffected')
    expect(ok.exitCode).toBe(0)
    expect(seen.at(-1)).toBeNull()
    await ws.close()
  })
})

class DenyAwsWrites implements Policy {
  preSession(ctx: SessionContext): Action | null {
    if (!ctx.key.startsWith('AWS_')) return null
    return { kind: 'deny', reason: 'not yours to set' }
  }
}

/** A leaf that writes the session plane through its door. */
async function stash(inv: CLIInvocation): Promise<[Uint8Array, IOResult]> {
  const view = inv.doors?.sessionView
  if (view === undefined) {
    return [new TextEncoder().encode('no session plane\n'), new IOResult({ exitCode: 1 })]
  }
  const [name, value] = [inv.texts[0] ?? '', inv.texts[1] ?? '']
  await view.set(name, value)
  return [new TextEncoder().encode(`${name}=${view.get(name) ?? ''}\n`), new IOResult()]
}

const STASH = new CLISpec({ name: 'stash', fn: stash, rest: new Operand({ type: 'str' }) })

describe('the session plane reaches a CLI leaf', () => {
  it('a leaf writes the session through its door', async () => {
    // The session plane's door is what a registered CLI has instead of
    // reaching into the session: the write lands, and the shell sees it.
    const ws = buildWorkspace()
    ws.registerCli('stash', STASH)
    const result = await ws.execute('stash TOKEN abc')
    expect([result.exitCode, dec.decode(result.stdout)]).toEqual([0, 'TOKEN=abc\n'])
    const echoed = await ws.execute('echo $TOKEN')
    expect(dec.decode(echoed.stdout)).toBe('abc\n')
  })

  it("a leaf's session write clears the same gate the shell does", async () => {
    // A door that skipped the gate would make an installed CLI the way around
    // every preSession rule, which is the whole reason writes go through one
    // door rather than to the session.
    const ram = new RAMResource()
    const registry = new OpsRegistry()
    registry.registerResource(ram)
    const ws = new Workspace(
      { '/data': ram },
      {
        mode: MountMode.WRITE,
        ops: registry,
        shellParser: parser,
        policies: [new DenyAwsWrites()],
      },
    )
    ws.registerCli('stash', STASH)
    const denied = await ws.execute('stash AWS_PROFILE prod')
    expect(denied.exitCode).not.toBe(0)
    expect(dec.decode(denied.stderr)).toContain('not yours to set')
    expect(dec.decode((await ws.execute('echo $AWS_PROFILE')).stdout)).toBe('\n')
    expect((await ws.execute('stash OTHER fine')).exitCode).toBe(0)
  })
})
