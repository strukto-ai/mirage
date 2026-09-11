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
import { z } from 'zod'

import { Option, type FlagValue } from '../../commands/spec/types.ts'
import { CLISpec, type CLIVerbFn } from '../../commands/cli/types.ts'
import { RAMResource } from '../../resource/ram/ram.ts'
import type { Runtime } from '../../runtime/base.ts'
import { VFSRuntime } from '../../runtime/table.ts'
import { ScriptSource } from '../../runtime/routing/types.ts'
import { registerSecrets } from '../../secrets/registry.ts'
import type { EnvEntries, SecretEntries } from '../../secrets/config.ts'
import type { ResolvedSecret } from '../../secrets/types.ts'
import { VarAttr } from '../../shell/variable.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import { MountMode } from '../../types.ts'
import type { Action, CommandContext, Policy } from '../../policy/index.ts'
import type { AskHandler } from '../../policy/decisions.ts'
import { Outcome, Scope, type Decision, type SessionContext } from '../../policy/types.ts'
import { getTestParser, stderrStr, stdoutStr } from '../fixtures/workspace_fixture.ts'
import { guestBound } from './fill.ts'
import { Workspace } from './workspace.ts'

const FakeConfig = z.strictObject({})
type FakeConfig = z.infer<typeof FakeConfig>

function countingSource(fields: Record<string, string>): {
  calls: string[]
  fetch: (config: FakeConfig, ref: string) => Promise<ResolvedSecret>
} {
  const calls: string[] = []
  return {
    calls,
    fetch: (_config, ref) => {
      calls.push(ref)
      return Promise.resolve({ fields: { ...fields } })
    },
  }
}

class DenyNamed implements Policy {
  private readonly name: string

  constructor(name: string) {
    this.name = name
  }

  preCommand(ctx: CommandContext): Action | null {
    if (ctx.command !== this.name) return null
    return { kind: 'deny', reason: `${this.name} is off`, scope: 'command' }
  }
}

class AskNamed implements Policy {
  private readonly name: string

  constructor(name: string) {
    this.name = name
  }

  preCommand(ctx: CommandContext): Action | null {
    if (ctx.command !== this.name) return null
    return { kind: 'ask', reason: `${this.name} needs sign-off` }
  }
}

async function makeWs(
  env: EnvEntries | undefined,
  policies?: Policy[],
  onAsk?: AskHandler,
  secrets?: SecretEntries,
): Promise<Workspace> {
  const parser = await getTestParser()
  return new Workspace(
    { '/': new RAMResource() },
    {
      mode: MountMode.WRITE,
      shellParser: parser,
      ...(env !== undefined ? { env } : {}),
      ...(policies !== undefined ? { policies } : {}),
      ...(onAsk !== undefined ? { onAsk } : {}),
      ...(secrets !== undefined ? { secrets } : {}),
    },
  )
}

function envCliSpec(): CLISpec {
  const leaf: CLIVerbFn = () => null
  return new CLISpec({
    name: 'mycli',
    options: [new Option({ long: '--token', type: 'str', env: 'CLI_ROOT' })],
    subcommands: [
      new CLISpec({
        name: 'alpha',
        fn: leaf,
        options: [new Option({ long: '--a', type: 'str', env: 'CLI_ALPHA' })],
      }),
      new CLISpec({
        name: 'beta',
        fn: leaf,
        options: [new Option({ long: '--b', type: 'str', env: 'CLI_BETA' })],
      }),
    ],
  })
}

function sharedCliSpec(probe: CLIVerbFn): CLISpec {
  return new CLISpec({
    name: 'mycli',
    options: [new Option({ long: '--token', type: 'str', env: 'CLI_SHARED' })],
    subcommands: [
      new CLISpec({
        name: 'alpha',
        fn: probe,
        options: [new Option({ long: '--a', type: 'str', env: 'CLI_SHARED' })],
      }),
    ],
  })
}

describe('fillEnv through execute', () => {
  it('lazy fetches only when referenced and only once', async () => {
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-lazy', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-lazy', ref: 'r' } })
    try {
      expect((await ws.execute('echo hi')).exitCode).toBe(0)
      expect(calls).toEqual([])
      expect(stdoutStr(await ws.execute('echo $TOKEN'))).toBe('t0\n')
      expect(calls).toEqual(['r'])
      expect(stdoutStr(await ws.execute('echo $TOKEN'))).toBe('t0\n')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  })

  it('a whole-env command fetches an unspelled name', async () => {
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-whole', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-whole', ref: 'r' } })
    try {
      expect((await ws.execute('ls /')).exitCode).toBe(0)
      expect(calls).toEqual([])
      expect(stdoutStr(await ws.execute('env'))).toContain('TOKEN=t0')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  })

  it('eager joins every line while a lazy sibling waits', async () => {
    const { calls, fetch } = countingSource({ E: 'ev', L: 'lv' })
    registerSecrets('fake-eager', FakeConfig, fetch)
    const ws = await makeWs({
      E: { from: 'fake-eager', ref: 're', fetch: 'eager' },
      L: { from: 'fake-eager', ref: 'rl' },
    })
    try {
      expect((await ws.execute('echo hi')).exitCode).toBe(0)
      expect(calls).toEqual(['re'])
      const session = ws.getSession(ws.defaultSessionId)
      expect(session.vars.E?.value).toBe('ev')
      expect(session.vars.L?.value).toBeNull()
    } finally {
      await ws.close()
    }
  })

  it('two names off one secret is one fetch', async () => {
    const { calls, fetch } = countingSource({ user: 'u', pass: 'p' })
    registerSecrets('fake-group', FakeConfig, fetch)
    const ws = await makeWs({
      DB_USER: { from: 'fake-group', ref: 'db', key: 'user' },
      DB_PASS: { from: 'fake-group', ref: 'db', key: 'pass' },
    })
    try {
      expect(stdoutStr(await ws.execute('echo $DB_USER:$DB_PASS'))).toBe('u:p\n')
      expect(calls).toEqual(['db'])
    } finally {
      await ws.close()
    }
  })

  it('key defaults to the variable name', async () => {
    const { fetch } = countingSource({ API: 'v' })
    registerSecrets('fake-key', FakeConfig, fetch)
    const ws = await makeWs({ API: { from: 'fake-key', ref: 'r' } })
    try {
      expect(stdoutStr(await ws.execute('echo $API'))).toBe('v\n')
    } finally {
      await ws.close()
    }
  })

  it('a missing key names both sides', async () => {
    const { fetch } = countingSource({ a: '1', b: '2' })
    registerSecrets('fake-miss', FakeConfig, fetch)
    const ws = await makeWs({ T: { from: 'fake-miss', ref: 'r', key: 'c' } })
    try {
      const io = await ws.execute('echo $T')
      expect(io.exitCode).toBe(1)
      const err = stderrStr(io)
      expect(err).toContain('T')
      expect(err).toContain("'c'")
      expect(err).toContain('a, b')
    } finally {
      await ws.close()
    }
  })

  it("a per-session env is that session's alone", async () => {
    const { calls, fetch } = countingSource({ S: 'sv' })
    registerSecrets('fake-session', FakeConfig, fetch)
    const ws = await makeWs(undefined)
    try {
      ws.sessionManager.create('s2', { env: { S: { from: 'fake-session', ref: 'r' } } })
      const io = await ws.execute('echo $S', { sessionId: 's2' })
      expect(stdoutStr(io)).toBe('sv\n')
      expect(calls).toEqual(['r'])
      expect('S' in ws.getSession(ws.defaultSessionId).vars).toBe(false)
    } finally {
      await ws.close()
    }
  })

  it('a readonly preset refuses with bash wording', async () => {
    const ws = await makeWs({ EDITOR: { value: 'vi', readonly: true } })
    try {
      let io = await ws.execute('EDITOR=x')
      expect(io.exitCode).toBe(1)
      expect(stderrStr(io)).toBe('bash: EDITOR: readonly variable\n')
      io = await ws.execute('unset EDITOR')
      expect(io.exitCode).toBe(1)
      expect(stderrStr(io)).toBe('bash: unset: EDITOR: cannot unset: readonly variable\n')
      expect(stdoutStr(await ws.execute('echo $EDITOR'))).toBe('vi\n')
    } finally {
      await ws.close()
    }
  })

  it('export -p renders an unfetched managed name unset', async () => {
    // Written straight into the session (no env block), so the fill
    // pass is off and the renderer meets the third state itself.
    const ws = await makeWs(undefined)
    try {
      const session = ws.getSession(ws.defaultSessionId)
      session.vars.T = {
        value: null,
        attrs: new Set([VarAttr.Export]),
        managed: { source: 'fake', ref: 'r', key: 'T', eager: false },
      }
      expect(stdoutStr(await ws.execute('export -p'))).toContain('declare -x T\n')
    } finally {
      await ws.close()
    }
  })

  it('a command substitution fetches through the inner fill', async () => {
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-cmdsub', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-cmdsub', ref: 'r' } })
    try {
      expect(stdoutStr(await ws.execute('x=$(echo $TOKEN); echo $x'))).toBe('t0\n')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  })

  it('a subshell export detaches only the fork', async () => {
    const { fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-fork', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-fork', ref: 'r' } })
    try {
      expect(stdoutStr(await ws.execute('(export TOKEN=y; echo $TOKEN)'))).toBe('y\n')
      expect(ws.getSession(ws.defaultSessionId).vars.TOKEN?.managed).not.toBeUndefined()
      expect(stdoutStr(await ws.execute('echo $TOKEN'))).toBe('t0\n')
    } finally {
      await ws.close()
    }
  })

  it('a write detaches, the next read is session-served, the value serializes', async () => {
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-write', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-write', ref: 'r' } })
    try {
      expect((await ws.execute('export TOKEN=mine')).exitCode).toBe(0)
      const afterWrite = calls.length
      expect(stdoutStr(await ws.execute('echo $TOKEN'))).toBe('mine\n')
      expect(calls.length).toBe(afterWrite)
      const data = ws.getSession(ws.defaultSessionId).toJSON()
      expect((data.env as Record<string, string>).TOKEN).toBe('mine')
      expect('managed' in data).toBe(false)
    } finally {
      await ws.close()
    }
  })

  it('a dead source fails only the command that needs it', async () => {
    registerSecrets('fake-dead', FakeConfig, () => Promise.reject(new Error('connection refused')))
    const ws = await makeWs({ TOKEN: { from: 'fake-dead', ref: 'r' } })
    try {
      const io = await ws.execute('echo $TOKEN')
      expect(io.exitCode).toBe(1)
      // The source's own words stay host-side: the agent learns the
      // variable and the source name, never the exception text.
      expect(stderrStr(io)).toBe('TOKEN: cannot fetch from fake-dead\n')
      expect((await ws.execute('ls /')).exitCode).toBe(0)
    } finally {
      await ws.close()
    }
  })

  it('a failed fetch sets the exit status', async () => {
    registerSecrets('fake-exit', FakeConfig, () => Promise.reject(new Error('connection refused')))
    const ws = await makeWs({ TOKEN: { from: 'fake-exit', ref: 'r' } })
    try {
      expect((await ws.execute('true')).exitCode).toBe(0)
      expect((await ws.execute('echo $TOKEN')).exitCode).toBe(1)
      expect(stdoutStr(await ws.execute('echo $?'))).toBe('1\n')
    } finally {
      await ws.close()
    }
  })

  it('an unknown source fails at construction', async () => {
    await expect(makeWs({ T: { from: 'nope-never', ref: 'r' } })).rejects.toThrowError(
      /unknown secrets source/,
    )
  })

  it('a mutating export detaches without fetching', async () => {
    registerSecrets('fake-detach', FakeConfig, () => Promise.reject(new Error('sealed')))
    const ws = await makeWs({ TOKEN: { from: 'fake-detach', ref: 'r' } })
    try {
      expect((await ws.execute('export TOKEN=local')).exitCode).toBe(0)
      expect(stdoutStr(await ws.execute('echo $TOKEN'))).toBe('local\n')
    } finally {
      await ws.close()
    }
  })

  it('mutating forms do not render the environment', async () => {
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-mutate', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-mutate', ref: 'r' } })
    try {
      for (const line of ['set -u', 'set +u', 'declare -x OTHER=1', 'export OTHER=2']) {
        await ws.execute(line)
      }
      expect(calls).toEqual([])
      expect(stdoutStr(await ws.execute('declare -p TOKEN'))).toContain('t0')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  })

  it('printenv of the name fetches it', async () => {
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-printenv', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-printenv', ref: 'r' } })
    try {
      expect(stdoutStr(await ws.execute('printenv TOKEN'))).toBe('t0\n')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  })

  it('a hidden managed name never fetches', async () => {
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-hidden', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-hidden', ref: 'r', fetch: 'eager' } })
    try {
      const session = ws.getSession(ws.defaultSessionId)
      session.hiddenVars = { names: ['TOKEN'] }
      const io = await ws.execute('env')
      expect(io.exitCode).toBe(0)
      expect(stdoutStr(io)).not.toContain('TOKEN')
      expect(stdoutStr(await ws.execute('echo [$TOKEN]'))).toBe('[]\n')
      expect(calls).toEqual([])
    } finally {
      await ws.close()
    }
  })

  it('a stored function body fills across lines', async () => {
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-fn', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-fn', ref: 'r' } })
    try {
      expect((await ws.execute('f() { echo "t:$TOKEN"; }')).exitCode).toBe(0)
      expect(calls).toEqual([])
      expect(stdoutStr(await ws.execute('f'))).toBe('t:t0\n')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  })

  it('a function calling a function fills transitively', async () => {
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-fn2', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-fn2', ref: 'r' } })
    try {
      await ws.execute('inner() { echo "i:$TOKEN"; }')
      await ws.execute('outer() { inner; }')
      expect(calls).toEqual([])
      expect(stdoutStr(await ws.execute('outer'))).toBe('i:t0\n')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  })

  it('an indirect expansion fetches the target', async () => {
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-indirect', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-indirect', ref: 'r' } })
    try {
      expect((await ws.execute('name=TOKEN')).exitCode).toBe(0)
      expect(calls).toEqual([])
      expect(stdoutStr(await ws.execute('echo ${!name}'))).toBe('t0\n')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  })

  it('a prior-line nameref fetches its target', async () => {
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-nameref', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-nameref', ref: 'r' } })
    try {
      const session = ws.getSession(ws.defaultSessionId)
      // Written straight into the session so the declaring line's own
      // opaque-read fetch cannot mask the deref path.
      session.vars.r2 = { value: 'TOKEN', attrs: new Set([VarAttr.Nameref]) }
      expect(stdoutStr(await ws.execute('echo $r2'))).toBe('t0\n')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  })

  it('an alias body fills on invocation', async () => {
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-alias', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-alias', ref: 'r' } })
    try {
      expect((await ws.execute('shopt -s expand_aliases')).exitCode).toBe(0)
      expect((await ws.execute('alias show=\'echo "a:$TOKEN"\'')).exitCode).toBe(0)
      expect(calls).toEqual([])
      expect(stdoutStr(await ws.execute('show'))).toBe('a:t0\n')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  })

  it('the alias rest word is not a managed read', async () => {
    const { calls, fetch } = countingSource({ token: 'v' })
    registerSecrets('fake-alias-rest', FakeConfig, fetch)
    const ws = await makeWs({
      __mirage_alias_rest__: { from: 'fake-alias-rest', ref: 'r', key: 'token' },
    })
    try {
      await ws.execute('shopt -s expand_aliases')
      await ws.execute("alias ll='echo hi'")
      expect(stdoutStr(await ws.execute('ll'))).toBe('hi\n')
      expect(calls).toEqual([])
    } finally {
      await ws.close()
    }
  })

  it('an alias never fetches while expansion is off', async () => {
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-alias-off', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-alias-off', ref: 'r' } })
    try {
      await ws.execute("alias show='echo $TOKEN'")
      expect((await ws.execute('show')).exitCode).not.toBe(0)
      expect(calls).toEqual([])
    } finally {
      await ws.close()
    }
  })

  it('an invocation before a redefinition fills the stored body', async () => {
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-order', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-order', ref: 'r' } })
    try {
      expect((await ws.execute('f() { echo "t:$TOKEN"; }')).exitCode).toBe(0)
      expect(calls).toEqual([])
      expect(stdoutStr(await ws.execute('f; f() { :; }'))).toBe('t:t0\n')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  })

  it('every same-line redefinition body fills', async () => {
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-redef-multi', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-redef-multi', ref: 'r' } })
    try {
      const io = await ws.execute('f() { :; }; f; f() { echo "e:$TOKEN"; }; f')
      expect(stdoutStr(io)).toBe('e:t0\n')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  })

  it('a body local mask never fetches', async () => {
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-body-local', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-body-local', ref: 'r' } })
    try {
      const io = await ws.execute('f() { local TOKEN=shadow; echo "in:$TOKEN"; }; f')
      expect(stdoutStr(io)).toBe('in:shadow\n')
      expect(calls).toEqual([])
    } finally {
      await ws.close()
    }
  })

  it('a body mask leaves the line read fetching', async () => {
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-body-line', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-body-line', ref: 'r' } })
    try {
      const io = await ws.execute('f() { local TOKEN=shadow; }; f; echo "g:$TOKEN"')
      expect(stdoutStr(io)).toBe('g:t0\n')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  })

  it('a body read before its mask fetches', async () => {
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-body-pre', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-body-pre', ref: 'r' } })
    try {
      const io = await ws.execute('f() { echo "pre:$TOKEN"; local TOKEN=shadow; }; f')
      expect(stdoutStr(io)).toBe('pre:t0\n')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  })

  it('a body assignment masks its own read', async () => {
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-body-assign', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-body-assign', ref: 'r' } })
    try {
      const io = await ws.execute('f() { TOKEN=w; echo "in:$TOKEN"; }; f')
      expect(stdoutStr(io)).toBe('in:w\n')
      expect(calls).toEqual([])
    } finally {
      await ws.close()
    }
  })

  it('a body mask reading the standing value fetches', async () => {
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-body-pin', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-body-pin', ref: 'r' } })
    try {
      const io = await ws.execute('f() { local TOKEN=$TOKEN; echo "in:$TOKEN"; }; f')
      expect(stdoutStr(io)).toBe('in:t0\n')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  })

  it('a stored body mask holds across lines', async () => {
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-stored-mask', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-stored-mask', ref: 'r' } })
    try {
      // The stored statements keep their container, so the body's
      // leading local masks its later reads on a later line exactly
      // as it does when the definition and the call share one.
      const line = 'fshadow() { local TOKEN=shadow; echo "s:$TOKEN"; }'
      expect((await ws.execute(line)).exitCode).toBe(0)
      expect(stdoutStr(await ws.execute('fshadow'))).toBe('s:shadow\n')
      expect(calls).toEqual([])
    } finally {
      await ws.close()
    }
  })

  it('a stored body read before its mask fetches', async () => {
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-stored-read', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-stored-read', ref: 'r' } })
    try {
      const line = 'fread() { echo "r:$TOKEN"; local TOKEN=shadow; }'
      expect((await ws.execute(line)).exitCode).toBe(0)
      expect(stdoutStr(await ws.execute('fread'))).toBe('r:t0\n')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  })

  it('a top-level declaration masks', async () => {
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-top-decl', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-top-decl', ref: 'r' } })
    try {
      const io = await ws.execute('export TOKEN=local; printenv TOKEN')
      expect(stdoutStr(io)).toBe('local\n')
      expect(calls).toEqual([])
    } finally {
      await ws.close()
    }
  })

  it('a top-level local is not a mask', async () => {
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-top-local', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-top-local', ref: 'r' } })
    try {
      const io = await ws.execute('local TOKEN=x; echo "t:$TOKEN"')
      expect(stdoutStr(io)).toBe('t:t0\n')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  })

  it('a tilde expansion fetches HOME', async () => {
    const { calls, fetch } = countingSource({ HOME: '/hh' })
    registerSecrets('fake-tilde', FakeConfig, fetch)
    const ws = await makeWs({ HOME: { from: 'fake-tilde', ref: 'h' } })
    try {
      const io = await ws.execute('echo ~/logs')
      expect(stdoutStr(io)).toBe('/hh/logs\n')
      expect(calls).toEqual(['h'])
    } finally {
      await ws.close()
    }
  })

  it('a bare cd fetches HOME', async () => {
    const { calls, fetch } = countingSource({ HOME: '/d' })
    registerSecrets('fake-cd-home', FakeConfig, fetch)
    const ws = await makeWs({ HOME: { from: 'fake-cd-home', ref: 'h' } })
    try {
      expect((await ws.execute('mkdir /d')).exitCode).toBe(0)
      const io = await ws.execute('cd; pwd')
      expect(stdoutStr(io)).toBe('/d\n')
      expect(calls).toEqual(['h'])
    } finally {
      await ws.close()
    }
  })

  it('cd dash fetches OLDPWD', async () => {
    const { calls, fetch } = countingSource({ OLDPWD: '/d' })
    registerSecrets('fake-cd-old', FakeConfig, fetch)
    const ws = await makeWs({ OLDPWD: { from: 'fake-cd-old', ref: 'o' } })
    try {
      expect((await ws.execute('mkdir /d')).exitCode).toBe(0)
      const io = await ws.execute('cd -')
      expect(stdoutStr(io)).toBe('/d\n')
      expect(calls).toEqual(['o'])
    } finally {
      await ws.close()
    }
  })

  it('a relative cd fetches CDPATH', async () => {
    const { calls, fetch } = countingSource({ CDPATH: '/pp' })
    registerSecrets('fake-cd-path', FakeConfig, fetch)
    const ws = await makeWs({ CDPATH: { from: 'fake-cd-path', ref: 'c' } })
    try {
      expect((await ws.execute('mkdir -p /pp/sub')).exitCode).toBe(0)
      const io = await ws.execute('cd sub')
      expect(stdoutStr(io)).toBe('/pp/sub\n')
      expect(calls).toEqual(['c'])
    } finally {
      await ws.close()
    }
  })

  it('read fetches IFS', async () => {
    const { calls, fetch } = countingSource({ IFS: ' ' })
    registerSecrets('fake-read-ifs', FakeConfig, fetch)
    const ws = await makeWs({ IFS: { from: 'fake-read-ifs', ref: 'i' } })
    try {
      const io = await ws.execute("echo 'a b' | read v")
      expect(io.exitCode).toBe(0)
      expect(calls).toEqual(['i'])
    } finally {
      await ws.close()
    }
  })

  it('getopts fetches OPTIND', async () => {
    const { calls, fetch } = countingSource({ OPTIND: '1' })
    registerSecrets('fake-getopts', FakeConfig, fetch)
    const ws = await makeWs({ OPTIND: { from: 'fake-getopts', ref: 'g' } })
    try {
      const io = await ws.execute('getopts ab o')
      expect(io.exitCode).toBe(1)
      expect(calls).toEqual(['g'])
    } finally {
      await ws.close()
    }
  })

  it('a line mask beats an implicit read', async () => {
    const { calls, fetch } = countingSource({ HOME: '/hh' })
    registerSecrets('fake-mask-tilde', FakeConfig, fetch)
    const ws = await makeWs({ HOME: { from: 'fake-mask-tilde', ref: 'h' } })
    try {
      const io = await ws.execute('HOME=/d; echo ~')
      expect(stdoutStr(io)).toBe('/d\n')
      expect(calls).toEqual([])
    } finally {
      await ws.close()
    }
  })

  it('an arithmetic read chases an earlier value', async () => {
    const { calls, fetch } = countingSource({ TOKEN: '7' })
    registerSecrets('fake-arith-chase', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-arith-chase', ref: 'r' } })
    try {
      expect((await ws.execute('name=TOKEN')).exitCode).toBe(0)
      expect(calls).toEqual([])
      const io = await ws.execute('echo $((name))')
      expect(stdoutStr(io)).toBe('7\n')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  })

  it('an arithmetic read chases a same-line assignment', async () => {
    const { calls, fetch } = countingSource({ TOKEN: '7' })
    registerSecrets('fake-arith-line', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-arith-line', ref: 'r' } })
    try {
      const io = await ws.execute('name=TOKEN; echo $((name))')
      expect(stdoutStr(io)).toBe('7\n')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  })

  it('the arithmetic chase respects a body mask', async () => {
    const { calls, fetch } = countingSource({ TOKEN: '7' })
    registerSecrets('fake-arith-mask', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-arith-mask', ref: 'r' } })
    try {
      const io = await ws.execute('f() { local TOKEN=5; echo $((TOKEN)); }; f')
      expect(stdoutStr(io)).toBe('5\n')
      expect(calls).toEqual([])
    } finally {
      await ws.close()
    }
  })

  it("the arithmetic chase follows a body mask's value", async () => {
    const { calls, fetch } = countingSource({ TOKEN: '7' })
    registerSecrets('fake-arith-bodyval', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-arith-bodyval', ref: 'r' } })
    try {
      const io = await ws.execute('f() { local n=TOKEN; echo $((n)); }; f')
      expect(stdoutStr(io)).toBe('7\n')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  })

  it('a [[ numeric comparison chases', async () => {
    const { calls, fetch } = countingSource({ TOKEN: '7' })
    registerSecrets('fake-arith-test', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-arith-test', ref: 'r' } })
    try {
      expect((await ws.execute('name=TOKEN')).exitCode).toBe(0)
      const io = await ws.execute('[[ name -gt 5 ]]; echo $?')
      expect(stdoutStr(io)).toBe('0\n')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  })

  it('a let operand chases', async () => {
    const { calls, fetch } = countingSource({ TOKEN: '7' })
    registerSecrets('fake-arith-let', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-arith-let', ref: 'r' } })
    try {
      expect((await ws.execute('name=TOKEN')).exitCode).toBe(0)
      const io = await ws.execute('let y=name+1; echo $y')
      expect(stdoutStr(io)).toBe('8\n')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  })

  it('the arithmetic chase follows a dynamic assignment', async () => {
    const { calls, fetch } = countingSource({ TOKEN: '7' })
    registerSecrets('fake-arith-dyn', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-arith-dyn', ref: 'r' } })
    try {
      expect((await ws.execute('other=TOKEN')).exitCode).toBe(0)
      const io = await ws.execute('n=$other; echo $((n))')
      expect(stdoutStr(io)).toBe('7\n')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  })

  it('the arithmetic chase replans after a fetch', async () => {
    const { calls, fetch } = countingSource({ A: 'B', B: '7' })
    registerSecrets('fake-arith-replan', FakeConfig, fetch)
    const ws = await makeWs({
      A: { from: 'fake-arith-replan', ref: 'ra', key: 'A' },
      B: { from: 'fake-arith-replan', ref: 'rb', key: 'B' },
    })
    try {
      // A's fetched value names B, unknowable before the fetch: the
      // second planning pass is what reaches B.
      const io = await ws.execute('echo $((A + 1))')
      expect(stdoutStr(io)).toBe('8\n')
      expect(calls).toEqual(['ra', 'rb'])
    } finally {
      await ws.close()
    }
  })

  it('numeric arithmetic never fetches', async () => {
    const { calls, fetch } = countingSource({ TOKEN: '7' })
    registerSecrets('fake-arith-num', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-arith-num', ref: 'r' } })
    try {
      const io = await ws.execute('echo $((2 + 2))')
      expect(stdoutStr(io)).toBe('4\n')
      expect(calls).toEqual([])
    } finally {
      await ws.close()
    }
  })

  it('a dynamic head fetches everything pending', async () => {
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-dyn', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-dyn', ref: 'r' } })
    try {
      expect((await ws.execute('h=echo')).exitCode).toBe(0)
      expect(calls).toEqual([])
      expect(stdoutStr(await ws.execute('$h hi'))).toBe('hi\n')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  })

  it('a copy carries the env template to new sessions', async () => {
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-copy', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-copy', ref: 'r' }, MODE: 'prod' })
    try {
      const twin = await ws.copy()
      try {
        twin.createSession('later')
        const io = await twin.execute('echo $MODE:$TOKEN', { sessionId: 'later' })
        expect(stdoutStr(io)).toBe('prod:t0\n')
        expect(calls).toEqual(['r'])
      } finally {
        await twin.close()
      }
    } finally {
      await ws.close()
    }
  })

  it('a denied literal line never fetches', async () => {
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-denied', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-denied', ref: 'r' } }, [
      new DenyNamed('printenv'),
    ])
    try {
      const io = await ws.execute('printenv TOKEN')
      expect(io.exitCode).toBe(126)
      expect(io.refusal?.reason).toContain('printenv is off')
      expect(calls).toEqual([])
      expect(stdoutStr(await ws.execute('echo $TOKEN'))).toBe('t0\n')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  })

  it('a dynamic-word deny fetches before the value gate', async () => {
    // The pre-pass reads a line's text; a command carrying a word only
    // expansion can produce is judged at the per-command gate, which
    // reads values. Expansion is what consumes the fetched value, so
    // for such a line the fetch precedes the verdict, the same way the
    // line's earlier commands would already have run.
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-dynamic', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-dynamic', ref: 'r' } }, [new DenyNamed('echo')])
    try {
      const io = await ws.execute('echo $TOKEN')
      expect(io.exitCode).toBe(126)
      expect(io.refusal?.reason).toContain('echo is off')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  })

  it('an asked literal line fetches only after approval', async () => {
    // The fetch is itself an effect, so an ask is answered before it:
    // one question, then one fetch, and the gate spends the grant
    // rather than asking again.
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-ask-allow', FakeConfig, fetch)
    const approve: AskHandler = (record: Decision) => {
      calls.push('ask')
      return Promise.resolve({ ...record, outcome: Outcome.ALLOW })
    }
    const ws = await makeWs(
      { TOKEN: { from: 'fake-ask-allow', ref: 'r' } },
      [new AskNamed('printenv')],
      approve,
    )
    try {
      const io = await ws.execute('printenv TOKEN')
      expect(stdoutStr(io)).toBe('t0\n')
      expect(calls).toEqual(['ask', 'r'])
      expect(ws.decisions.pending()).toEqual([])
    } finally {
      await ws.close()
    }
  })

  it('an asked literal line denied never fetches', async () => {
    // A host's no arrives before the source is contacted, and the
    // refusal still comes from the gate, in the deny voice.
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-ask-deny', FakeConfig, fetch)
    const refuse: AskHandler = (record: Decision) => {
      calls.push('ask')
      return Promise.resolve({ ...record, outcome: Outcome.DENY })
    }
    const ws = await makeWs(
      { TOKEN: { from: 'fake-ask-deny', ref: 'r' } },
      [new AskNamed('printenv')],
      refuse,
    )
    try {
      const io = await ws.execute('printenv TOKEN')
      expect(io.exitCode).toBe(126)
      expect(io.refusal?.reason).toContain('printenv needs sign-off')
      expect(calls).toEqual(['ask'])
    } finally {
      await ws.close()
    }
  })

  it('an asked literal line left pending never fetches', async () => {
    // With no host inline, the question is recorded once and the fetch
    // is skipped; the answered replay fetches and runs.
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-ask-pending', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-ask-pending', ref: 'r' } }, [
      new AskNamed('printenv'),
    ])
    try {
      const io = await ws.execute('printenv TOKEN')
      expect(io.exitCode).toBe(126)
      expect(stderrStr(io)).toBe('printenv: Permission denied\n')
      expect(io.refusal?.kind).toBe('pending')
      expect(calls).toEqual([])
      const pending = ws.decisions.pending()
      expect(pending).toHaveLength(1)
      await ws.decisions.answer(pending[0]?.id ?? '', Outcome.ALLOW, Scope.ONCE)
      const again = await ws.execute('printenv TOKEN')
      expect(stdoutStr(again)).toBe('t0\n')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  })

  it('a denied function body never fetches', async () => {
    // The refusal walk covers the same nodes the read walk covers, so a
    // stored body whose one command is denied contributes no read; the
    // invocation still runs and is refused in place, and the pointer
    // stays live for an allowed line.
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-body-deny', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-body-deny', ref: 'r' } }, [
      new DenyNamed('printenv'),
    ])
    try {
      expect((await ws.execute('f() { printenv TOKEN; }')).exitCode).toBe(0)
      const io = await ws.execute('f')
      expect(io.exitCode).toBe(126)
      expect(io.refusal?.reason).toContain('printenv is off')
      expect(calls).toEqual([])
      expect(stdoutStr(await ws.execute('echo $TOKEN'))).toBe('t0\n')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  })

  it('a denied transitive body never fetches', async () => {
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-body-trans', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-body-trans', ref: 'r' } }, [
      new DenyNamed('printenv'),
    ])
    try {
      await ws.execute('inner() { printenv TOKEN; }')
      await ws.execute('outer() { inner; }')
      const io = await ws.execute('outer')
      expect(io.exitCode).toBe(126)
      expect(calls).toEqual([])
    } finally {
      await ws.close()
    }
  })

  it('a denied body statement keeps a sibling reader fetching', async () => {
    // A stored body joins the walk one statement per node, so a refusal
    // drops exactly the denied statement's reads and the sibling still
    // sees the value. Seeded directly: the prejudge pass refuses
    // defining such a body under the same policy, while a stored
    // function can predate it (per-session profiles).
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-body-mixed', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-body-mixed', ref: 'r' } }, [
      new DenyNamed('printenv'),
    ])
    try {
      const parser = await getTestParser()
      const session = ws.getSession(ws.defaultSessionId)
      const tree = parser.parse('printenv TOKEN; echo "e:$TOKEN"')
      session.functions.f = tree.namedChildren.filter((node) => node.type === 'command')
      const io = await ws.execute('f')
      expect(stdoutStr(io)).toBe('e:t0\n')
      expect(io.refusal?.reason).toContain('printenv is off')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  })

  it('a denied invocation skips the body reads', async () => {
    // The line's own refusal drops the whole walked set: a body never
    // runs when its invocation is refused, so nothing fetches.
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-inv-deny', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-inv-deny', ref: 'r' } }, [new DenyNamed('f')])
    try {
      await ws.execute('f() { printenv TOKEN; }')
      const io = await ws.execute('f')
      expect(io.exitCode).toBe(126)
      expect(calls).toEqual([])
    } finally {
      await ws.close()
    }
  })

  it('defining a denied body is not judged', async () => {
    // A definition stores text: the command inside it neither reads nor
    // answers for the line, so the eager name still fills and no gate
    // question fires for a command that only got stored.
    const { calls, fetch } = countingSource({ TOKEN: 't0', E: 'ev' })
    registerSecrets('fake-def-eager', FakeConfig, fetch)
    const ws = await makeWs(
      {
        TOKEN: { from: 'fake-def-eager', ref: 'r' },
        EAGER: { from: 'fake-def-eager', ref: 're', key: 'E', fetch: 'eager' },
      },
      [new DenyNamed('printenv')],
    )
    try {
      const io = await ws.execute('g() { printenv TOKEN; }')
      expect(io.exitCode).toBe(0)
      expect(calls).toEqual(['re'])
    } finally {
      await ws.close()
    }
  })

  it('an asked function body fetches only after approval', async () => {
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-body-ask', FakeConfig, fetch)
    const approve: AskHandler = (record: Decision) => {
      calls.push('ask')
      return Promise.resolve({ ...record, outcome: Outcome.ALLOW })
    }
    const ws = await makeWs(
      { TOKEN: { from: 'fake-body-ask', ref: 'r' } },
      [new AskNamed('printenv')],
      approve,
    )
    try {
      await ws.execute('f() { printenv TOKEN; }')
      const io = await ws.execute('f')
      expect(stdoutStr(io)).toBe('t0\n')
      expect(calls).toEqual(['ask', 'r'])
      expect(ws.decisions.pending()).toEqual([])
    } finally {
      await ws.close()
    }
  })

  it('an asked function body denied never fetches', async () => {
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-body-ask-deny', FakeConfig, fetch)
    const refuse: AskHandler = (record: Decision) => {
      calls.push('ask')
      return Promise.resolve({ ...record, outcome: Outcome.DENY })
    }
    const ws = await makeWs(
      { TOKEN: { from: 'fake-body-ask-deny', ref: 'r' } },
      [new AskNamed('printenv')],
      refuse,
    )
    try {
      await ws.execute('f() { printenv TOKEN; }')
      const io = await ws.execute('f')
      expect(io.exitCode).toBe(126)
      expect(io.refusal?.reason).toContain('printenv needs sign-off')
      expect(calls).toEqual(['ask'])
    } finally {
      await ws.close()
    }
  })

  it('env ignore-environment never fetches', async () => {
    // `env -i` provably starts empty, so it selects nothing, and the
    // replaced scope drops a pending managed entry too: the inner line
    // must not fetch a name the flag just cleared. The flagless
    // invocation keeps the whole-environment read.
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-env-i', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-env-i', ref: 'r' } })
    try {
      const io = await ws.execute('env -i')
      expect(io.exitCode).toBe(0)
      expect(stdoutStr(io)).toBe('')
      const inner = await ws.execute('env -i printenv TOKEN')
      expect(inner.exitCode).toBe(1)
      expect(stdoutStr(inner)).toBe('')
      expect(calls).toEqual([])
      expect(stdoutStr(await ws.execute('env printenv TOKEN'))).toBe('t0\n')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  })

  it('a masked assignment never fetches', async () => {
    // The line replaces the name before anything can read it, so no
    // source is contacted, and the replacement persists.
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-mask-assign', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-mask-assign', ref: 'r' } })
    try {
      const io = await ws.execute('TOKEN=local; printenv TOKEN')
      expect(stdoutStr(io)).toBe('local\n')
      expect(calls).toEqual([])
      const later = await ws.execute('printenv TOKEN')
      expect(stdoutStr(later)).toBe('local\n')
      expect(calls).toEqual([])
    } finally {
      await ws.close()
    }
  })

  it('a masked unset never fetches', async () => {
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-mask-unset', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-mask-unset', ref: 'r' } })
    try {
      const io = await ws.execute('unset TOKEN; printenv TOKEN')
      expect(io.exitCode).toBe(1)
      expect(stdoutStr(io)).toBe('')
      expect(calls).toEqual([])
    } finally {
      await ws.close()
    }
  })

  it('env removal and override never fetch', async () => {
    // `env -u TOKEN` and `env TOKEN=local` both hand the child an
    // environment that cannot observe the standing value, so neither
    // invocation selects the name; the pointer stays pending for a
    // later line that really reads it.
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-env-excl', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-env-excl', ref: 'r' } })
    try {
      const removed = await ws.execute('env -u TOKEN printenv TOKEN')
      expect(removed.exitCode).toBe(1)
      expect(stdoutStr(removed)).toBe('')
      const overridden = await ws.execute('env TOKEN=local printenv TOKEN')
      expect(stdoutStr(overridden)).toBe('local\n')
      expect(calls).toEqual([])
      const real = await ws.execute('printenv TOKEN')
      expect(stdoutStr(real)).toBe('t0\n')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  })

  it('a prefix override never fetches and keeps the pointer', async () => {
    // `TOKEN=local printenv TOKEN` overrides for that invocation only:
    // no fetch, "local" printed, and the pointer still fetches on the
    // next real read.
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-prefix', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-prefix', ref: 'r' } })
    try {
      const io = await ws.execute('TOKEN=local printenv TOKEN')
      expect(stdoutStr(io)).toBe('local\n')
      expect(calls).toEqual([])
      const real = await ws.execute('echo $TOKEN')
      expect(stdoutStr(real)).toBe('t0\n')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  })

  it('conditional and background masks do not hold', async () => {
    // `A=1 && read` runs the read conditionally and `TOKEN=local &`
    // detaches to a subshell where nothing persists: neither position
    // proves a replacement, so the fetch stands.
    const first = countingSource({ TOKEN: 't0', A: 'a0' })
    registerSecrets('fake-cond', FakeConfig, first.fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-cond', ref: 'r' } })
    try {
      const io = await ws.execute('A=1 && printenv TOKEN')
      expect(stdoutStr(io)).toBe('t0\n')
      expect(first.calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
    const second = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-bg', FakeConfig, second.fetch)
    const ws2 = await makeWs({ TOKEN: { from: 'fake-bg', ref: 'r' } })
    try {
      await ws2.execute('TOKEN=local & printenv TOKEN')
      expect(second.calls).toEqual(['r'])
    } finally {
      await ws2.close()
    }
  })

  it('a self read in the prefix keeps the fetch', async () => {
    // `TOKEN=$TOKEN` reads before it writes, so the mask may not spend
    // the name.
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-selfread', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-selfread', ref: 'r' } })
    try {
      const io = await ws.execute('TOKEN=$TOKEN; printenv TOKEN')
      expect(stdoutStr(io)).toBe('t0\n')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  })

  it('a session-write policy disables masking', async () => {
    // A preSession rule may refuse a write mid-line while later
    // statements still run, so under one no assignment or unset is
    // trusted to land: the fetch keeps today's shape and the output is
    // unchanged.
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-gated', FakeConfig, fetch)
    const gate: Policy = {
      preSession(ctx: SessionContext): Action | null {
        if (ctx.key === 'UNRELATED') {
          return { kind: 'deny', reason: `no writing ${ctx.key}`, scope: 'command' }
        }
        return null
      },
    }
    const ws = await makeWs({ TOKEN: { from: 'fake-gated', ref: 'r' } }, [gate])
    try {
      const io = await ws.execute('TOKEN=local; printenv TOKEN')
      expect(stdoutStr(io)).toBe('local\n')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  })

  it('a cli fetches only the invoked verb path', async () => {
    const { calls, fetch } = countingSource({ CLI_ROOT: 'r0', CLI_ALPHA: 'a0', CLI_BETA: 'b0' })
    registerSecrets('fake-cli-path', FakeConfig, fetch)
    const ws = await makeWs({
      CLI_ROOT: { from: 'fake-cli-path', ref: 'root' },
      CLI_ALPHA: { from: 'fake-cli-path', ref: 'alpha' },
      CLI_BETA: { from: 'fake-cli-path', ref: 'beta' },
    })
    try {
      ws.registerCli('mycli', envCliSpec())
      await ws.execute('mycli alpha')
      expect([...calls].sort()).toEqual(['alpha', 'root'])
    } finally {
      await ws.close()
    }
  })

  it('a supplied cli option skips its env', async () => {
    const { calls, fetch } = countingSource({ CLI_ROOT: 'r0', CLI_ALPHA: 'a0' })
    registerSecrets('fake-cli-supplied', FakeConfig, fetch)
    const ws = await makeWs({
      CLI_ROOT: { from: 'fake-cli-supplied', ref: 'root' },
      CLI_ALPHA: { from: 'fake-cli-supplied', ref: 'alpha' },
    })
    try {
      ws.registerCli('mycli', envCliSpec())
      // Typed outranks environment: the parser never reads CLI_ROOT
      // when --token is on the line, so nothing may fetch it.
      await ws.execute('mycli --token explicit alpha')
      expect(calls).toEqual(['alpha'])
      await ws.execute('mycli --token explicit alpha --a explicit2')
      expect(calls).toEqual(['alpha'])
    } finally {
      await ws.close()
    }
  })

  it('an abbreviated option still fetches', async () => {
    const { calls, fetch } = countingSource({ CLI_ROOT: 'r0', CLI_ALPHA: 'a0' })
    registerSecrets('fake-cli-abbrev', FakeConfig, fetch)
    const ws = await makeWs({
      CLI_ROOT: { from: 'fake-cli-abbrev', ref: 'root' },
      CLI_ALPHA: { from: 'fake-cli-abbrev', ref: 'alpha' },
    })
    try {
      ws.registerCli('mycli', envCliSpec())
      // An abbreviation is never claimed as supplied: the scan stops
      // and the fetch keeps today's shape, over-fetching only.
      await ws.execute('mycli --tok explicit alpha')
      expect([...calls].sort()).toEqual(['alpha', 'root'])
    } finally {
      await ws.close()
    }
  })

  it('a group env option reaches the leaf', async () => {
    const seen: Record<string, FlagValue>[] = []
    const probe: CLIVerbFn = (inv) => {
      seen.push({ ...inv.flags })
      return null
    }
    const { calls, fetch } = countingSource({ CLI_ROOT: 'r0' })
    registerSecrets('fake-cli-group-env', FakeConfig, fetch)
    const ws = await makeWs({ CLI_ROOT: { from: 'fake-cli-group-env', ref: 'root' } })
    try {
      ws.registerCli(
        'mycli',
        new CLISpec({
          name: 'mycli',
          options: [new Option({ long: '--token', type: 'str', env: 'CLI_ROOT' })],
          subcommands: [new CLISpec({ name: 'alpha', fn: probe })],
        }),
      )
      const io = await ws.execute('mycli alpha')
      expect(io.exitCode).toBe(0)
      expect(calls).toEqual(['root'])
      // The walk fills the group level from the same environment the
      // leaf parse reads, so the fetched value reaches the handler.
      expect(seen).toEqual([{ token: 'r0' }])
    } finally {
      await ws.close()
    }
  })

  it('a shared env with an unsupplied reader still fetches', async () => {
    const seen: Record<string, FlagValue>[] = []
    const probe: CLIVerbFn = (inv) => {
      seen.push({ ...inv.flags })
      return null
    }
    const { calls, fetch } = countingSource({ CLI_SHARED: 's0' })
    registerSecrets('fake-cli-shared-one', FakeConfig, fetch)
    const ws = await makeWs({ CLI_SHARED: { from: 'fake-cli-shared-one', ref: 'shared' } })
    try {
      ws.registerCli('mycli', sharedCliSpec(probe))
      // --token is typed, but --a still falls back to the variable the
      // two declare, so it must fetch.
      const io = await ws.execute('mycli --token typed alpha')
      expect(io.exitCode).toBe(0)
      expect(calls).toEqual(['shared'])
      expect(seen).toEqual([{ token: 'typed', a: 's0' }])
    } finally {
      await ws.close()
    }
  })

  it('a shared env with every reader supplied skips the fetch', async () => {
    const seen: Record<string, FlagValue>[] = []
    const probe: CLIVerbFn = (inv) => {
      seen.push({ ...inv.flags })
      return null
    }
    const { calls, fetch } = countingSource({ CLI_SHARED: 's0' })
    registerSecrets('fake-cli-shared-all', FakeConfig, fetch)
    const ws = await makeWs({ CLI_SHARED: { from: 'fake-cli-shared-all', ref: 'shared' } })
    try {
      ws.registerCli('mycli', sharedCliSpec(probe))
      const io = await ws.execute('mycli --token typed alpha --a typed2')
      expect(io.exitCode).toBe(0)
      expect(calls).toEqual([])
      expect(seen).toEqual([{ token: 'typed', a: 'typed2' }])
    } finally {
      await ws.close()
    }
  })

  it('an append assignment fetches before extending', async () => {
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-append', FakeConfig, fetch)
    const ws = await makeWs({ TOKEN: { from: 'fake-append', ref: 'r' } })
    try {
      // The append alone on its line is a read: it starts from the
      // value it extends, then the write detaches the name.
      expect((await ws.execute('TOKEN+=x')).exitCode).toBe(0)
      expect(calls).toEqual(['r'])
      expect(stdoutStr(await ws.execute('echo $TOKEN'))).toBe('t0x\n')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  })

  it('getopts consults a managed OPTERR', async () => {
    const { calls, fetch } = countingSource({ OPTERR: '0' })
    registerSecrets('fake-opterr', FakeConfig, fetch)
    const ws = await makeWs({ OPTERR: { from: 'fake-opterr', ref: 'oe' } })
    try {
      const io = await ws.execute('getopts a opt -z')
      expect(calls).toEqual(['oe'])
      expect(stderrStr(io)).toBe('')
      expect(io.exitCode).toBe(0)
    } finally {
      await ws.close()
    }
  })

  it('an alias-invoked cli fetches its env', async () => {
    // The alias value is a textual prefix, so the verb is unknowable
    // until dispatch appends the rest; the walk falls back to the
    // whole spec tree rather than reading "no verb selected".
    const { calls, fetch } = countingSource({ CLI_ROOT: 'r0', CLI_ALPHA: 'a0' })
    registerSecrets('fake-cli-alias', FakeConfig, fetch)
    const ws = await makeWs({
      CLI_ROOT: { from: 'fake-cli-alias', ref: 'root' },
      CLI_ALPHA: { from: 'fake-cli-alias', ref: 'alpha' },
    })
    try {
      ws.registerCli('mycli', envCliSpec())
      await ws.execute('shopt -s expand_aliases')
      await ws.execute("alias n='mycli'")
      expect(calls).toEqual([])
      await ws.execute('n alpha')
      expect(calls).toContain('alpha')
      expect(calls).toContain('root')
    } finally {
      await ws.close()
    }
  })

  it('a shadowed cli head does not fetch', async () => {
    const { calls, fetch } = countingSource({ CLI_ROOT: 'r0' })
    registerSecrets('fake-cli-shadow', FakeConfig, fetch)
    const ws = await makeWs({ CLI_ROOT: { from: 'fake-cli-shadow', ref: 'root' } })
    try {
      ws.registerCli('mycli', envCliSpec())
      await ws.execute('mycli() { echo shadowed; }')
      expect(stdoutStr(await ws.execute('mycli'))).toBe('shadowed\n')
      expect(calls).toEqual([])
      await ws.execute('unset -f mycli')
      await ws.execute('mycli')
      expect(calls).toEqual(['root'])
    } finally {
      await ws.close()
    }
  })
})

describe('guestBound', () => {
  it('a non-vfs binding on a line word counts; vfs does not', async () => {
    const parser = await getTestParser()
    const node = parser.parse('python3 -c "print()"') as unknown as TSNodeLike
    const guest = { name: 'monty' } as unknown as Runtime
    expect(guestBound([node], null, { python3: guest })).toBe(true)
    expect(guestBound([node], null, { python3: new VFSRuntime() })).toBe(false)
    expect(guestBound([node], null, { other: guest })).toBe(false)
    expect(guestBound([node], null, { '*': guest })).toBe(true)
  })

  it('a decision replaces the static table', async () => {
    const parser = await getTestParser()
    const node = parser.parse('echo hi') as unknown as TSNodeLike
    const guest = { name: 'monty' } as unknown as Runtime
    const decision = { bindings: { echo: guest }, fallback: null } as never
    expect(guestBound([node], decision, {})).toBe(true)
    expect(guestBound([node], null, { echo: null })).toBe(false)
  })
})

const AccountConfig = z.strictObject({
  account: z.string().default('default'),
  token: z.string().optional(),
})
type AccountConfig = z.infer<typeof AccountConfig>

function accountSource(): (config: AccountConfig, ref: string) => Promise<ResolvedSecret> {
  return (config, ref) =>
    Promise.resolve({
      fields: { credential: `${config.account}:${ref}:${config.token ?? 'none'}` },
    })
}

describe('declared source instances', () => {
  it('carries an instance config to the fetch', async () => {
    registerSecrets('acct-one', AccountConfig, accountSource())
    const ws = await makeWs(
      { TOKEN: { from: 'prod', ref: 'r', key: 'credential' } },
      undefined,
      undefined,
      { prod: { source: 'acct-one', config: { account: 'a1' } } },
    )
    try {
      expect(stdoutStr(await ws.execute('echo "$TOKEN"'))).toBe('a1:r:none\n')
    } finally {
      await ws.close()
    }
  })

  it('keeps two instances of one source apart', async () => {
    registerSecrets('acct-two', AccountConfig, accountSource())
    const ws = await makeWs(
      {
        A: { from: 'prod', ref: 'r', key: 'credential' },
        B: { from: 'test', ref: 'r', key: 'credential' },
      },
      undefined,
      undefined,
      {
        prod: { source: 'acct-two', config: { account: 'a1' } },
        test: { source: 'acct-two', config: { account: 'a2' } },
      },
    )
    try {
      expect(stdoutStr(await ws.execute('echo "$A"; echo "$B"'))).toBe('a1:r:none\na2:r:none\n')
    } finally {
      await ws.close()
    }
  })

  it('reads an instance config from its bootstrap source', async () => {
    registerSecrets('acct-boot', AccountConfig, accountSource())
    registerSecrets('env', z.strictObject({}), () =>
      Promise.resolve({ fields: { FILL_PROBE_TOKEN: 's3cr3t' } }),
    )
    const ws = await makeWs(
      { TOKEN: { from: 'prod', ref: 'r', key: 'credential' } },
      undefined,
      undefined,
      {
        prod: {
          source: 'acct-boot',
          config: { token: { from: 'env', key: 'FILL_PROBE_TOKEN' } },
        },
      },
    )
    try {
      expect(stdoutStr(await ws.execute('echo "$TOKEN"'))).toBe('default:r:s3cr3t\n')
    } finally {
      await ws.close()
    }
  })

  it('leaves a bare source name on ambient defaults', async () => {
    registerSecrets('acct-bare', AccountConfig, accountSource())
    const ws = await makeWs(
      { TOKEN: { from: 'acct-bare', ref: 'r', key: 'credential' } },
      undefined,
      undefined,
      { prod: { source: 'acct-bare', config: { account: 'a1' } } },
    )
    try {
      expect(stdoutStr(await ws.execute('echo "$TOKEN"'))).toBe('default:r:none\n')
    } finally {
      await ws.close()
    }
  })

  it('refuses a non-mapping secrets block', async () => {
    // An untyped REST override can hand over an array, and
    // Object.entries on one yields nothing -- the declarations would
    // vanish silently and every restored pointer would read as an
    // unknown source.
    await expect(makeWs({}, undefined, undefined, [] as never)).rejects.toThrowError(
      /must be a mapping/,
    )
  })

  it('fails at construction for an instance naming an unknown source', async () => {
    await expect(
      makeWs({}, undefined, undefined, { prod: { source: 'nope' } }),
    ).rejects.toThrowError(/unknown secrets source/)
  })

  it('never resolves the block for a denied line', async () => {
    // The managed source was already out of reach for a refused line;
    // so is the bootstrap source the declarations themselves read.
    const calls: string[] = []
    registerSecrets('env', FakeConfig, (_config: unknown, ref: string) => {
      calls.push(ref)
      return Promise.resolve({ fields: { TOKEN: 't' } })
    })
    registerSecrets('acct-denied', AccountConfig, accountSource())
    const ws = await makeWs(
      { TOKEN: { from: 'prod', ref: 'r', key: 'credential' } },
      [new DenyNamed('printenv')],
      undefined,
      { prod: { source: 'acct-denied', config: { token: { from: 'env', key: 'TOKEN' } } } },
    )
    try {
      const denied = await ws.execute('printenv TOKEN')
      expect(denied.exitCode).toBe(126)
      expect(calls).toEqual([])
      expect(stdoutStr(await ws.execute('echo "$TOKEN"'))).toBe('default:r:t\n')
      expect(calls).toEqual([''])
    } finally {
      await ws.close()
    }
  })

  it('redacts like env when an instance aliases it', async () => {
    // The summary is told the source behind the instance: an instance
    // name is the deployment's word, and `{prod: {source: env}}` must
    // hide the host's variable names however few of them there are.
    registerSecrets('env', FakeConfig, () => Promise.resolve({ fields: { HOME: '/root' } }))
    const ws = await makeWs(
      { TOKEN: { from: 'prod', ref: '', key: 'NOPE' } },
      undefined,
      undefined,
      {
        prod: { source: 'env' },
      },
    )
    try {
      const io = await ws.execute('echo "$TOKEN"')
      expect(io.exitCode).toBe(1)
      const message = stderrStr(io)
      expect(message).toContain('1 fields')
      expect(message).not.toContain('HOME')
    } finally {
      await ws.close()
    }
  })

  it('resolves the block once for concurrent first lines', async () => {
    // The memo is written after an await, so caching only the result
    // lets both sessions read every bootstrap source, and a rotation
    // between the two reads leaves the loser's config on one line.
    const calls: string[] = []
    registerSecrets('env', FakeConfig, async (_config: unknown, ref: string) => {
      calls.push(ref)
      await new Promise((resolve) => setTimeout(resolve, 10))
      return { fields: { TOKEN: 't' } }
    })
    registerSecrets('acct-race', AccountConfig, accountSource())
    const ws = await makeWs(
      { TOKEN: { from: 'prod', ref: 'r', key: 'credential' } },
      undefined,
      undefined,
      {
        prod: { source: 'acct-race', config: { token: { from: 'env', key: 'TOKEN' } } },
      },
    )
    ws.createSession('a')
    ws.createSession('b')
    try {
      const [first, second] = await Promise.all([
        ws.execute('echo "$TOKEN"', { sessionId: 'a' }),
        ws.execute('echo "$TOKEN"', { sessionId: 'b' }),
      ])
      expect(stdoutStr(first)).toBe('default:r:t\n')
      expect(stdoutStr(second)).toBe('default:r:t\n')
      expect(calls).toEqual([''])
    } finally {
      await ws.close()
    }
  })

  it('a copy keeps the declared instances', async () => {
    registerSecrets('acct-copy', AccountConfig, accountSource())
    const ws = await makeWs(
      { TOKEN: { from: 'prod', ref: 'r', key: 'credential' } },
      undefined,
      undefined,
      {
        prod: { source: 'acct-copy', config: { account: 'a1' } },
      },
    )
    try {
      const copy = await ws.copy()
      try {
        expect(stdoutStr(await copy.execute('echo "$TOKEN"'))).toBe('a1:r:none\n')
      } finally {
        await copy.close()
      }
    } finally {
      await ws.close()
    }
  })

  it('validates a pointer named after a prototype member', async () => {
    await expect(
      makeWs({ TOKEN: { from: 'constructor', ref: '', key: 'credential' } }),
    ).rejects.toThrowError(/unknown secrets source/)
  })

  it('needs no source of the instance name', async () => {
    registerSecrets('acct-named', AccountConfig, accountSource())
    const ws = await makeWs(
      { TOKEN: { from: 'prod', ref: 'r', key: 'credential' } },
      undefined,
      undefined,
      { prod: { source: 'acct-named' } },
    )
    await ws.close()
  })

  it('fails the lines that read a bad instance config', async () => {
    // Only those lines: the declarations are read when an admitted
    // node wants a value, so a line naming no secret runs and one the
    // per-command gate refuses never reaches a bootstrap source. An
    // unknown source name still fails at construction; what is left
    // for resolution to find is a config the source refuses.
    registerSecrets('acct-bad', AccountConfig, accountSource())
    const ws = await makeWs(
      { TOKEN: { from: 'prod', ref: 'r', key: 'credential' } },
      undefined,
      undefined,
      { prod: { source: 'acct-bad', config: { nonesuch: 'x' } } },
    )
    try {
      expect((await ws.execute('echo hi')).exitCode).toBe(0)
      const out = await ws.execute('echo "$TOKEN"')
      expect(out.exitCode).toBe(1)
      expect(stderrStr(out)).toContain('secrets.prod')
    } finally {
      await ws.close()
    }
  })
})

// A profile policy at the session door and one away from it: only the
// first is a session-write gate, and only for the sessions under its
// profile.
const SESSION_GATE = `\
def pre_session(ctx):
    if ctx['write']['key'].startswith('AWS_'):
        return 'deny'
    return None
`

const COMMAND_JUDGE = `\
def pre_command(ctx):
    return None
`

async function scriptedWs(env: EnvEntries, source: string): Promise<Workspace> {
  const parser = await getTestParser()
  return new Workspace(
    { '/': new RAMResource() },
    {
      mode: MountMode.WRITE,
      shellParser: parser,
      env,
      profiles: {
        release: { policy: { script: new ScriptSource(source, 'python'), runtime: 'monty' } },
      } as never,
      profile: 'release',
    },
  )
}

describe('fillEnv under a profile policy', () => {
  it('a policy at the session door drops the masks', async () => {
    // Its preSession may refuse the assignment mid-line, so the standing
    // value is fetched, as under a coded preSession policy.
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-scripted-gate', FakeConfig, fetch)
    const ws = await scriptedWs({ TOKEN: { from: 'fake-scripted-gate', ref: 'r' } }, SESSION_GATE)
    try {
      const io = await ws.execute('TOKEN=local; printenv TOKEN')
      expect(stdoutStr(io)).toBe('local\n')
      expect(calls).toEqual(['r'])
    } finally {
      await ws.close()
    }
  }, 120000)

  it('a policy away from the session door keeps the masks', async () => {
    // The script policy stands at every door of every workspace, but
    // this program says nothing at the session door, so the fill's masks
    // hold and no source is contacted.
    const { calls, fetch } = countingSource({ TOKEN: 't0' })
    registerSecrets('fake-scripted-judge', FakeConfig, fetch)
    const ws = await scriptedWs({ TOKEN: { from: 'fake-scripted-judge', ref: 'r' } }, COMMAND_JUDGE)
    try {
      const io = await ws.execute('TOKEN=local; printenv TOKEN')
      expect(stdoutStr(io)).toBe('local\n')
      expect(calls).toEqual([])
    } finally {
      await ws.close()
    }
  }, 120000)
})
