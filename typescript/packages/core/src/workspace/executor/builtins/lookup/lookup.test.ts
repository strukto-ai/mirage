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
import { CommandSpec } from '../../../../commands/spec/types.ts'
import { CLIHandler } from '../../../../commands/cli/types.ts'

import { describe, expect, it } from 'vitest'
import { CLI } from '../../../../commands/cli/types.ts'
import { IOResult, materialize } from '../../../../io/types.ts'
import type { ByteSource } from '../../../../io/types.ts'
import { CLIRegistry } from '../../../cli/registry.ts'
import type { MountRegistry } from '../../../mount/registry.ts'
import { SessionState } from '../../../session/session.ts'
import { handleType, handleWhich } from './lookup.ts'
import { ParseScope } from '../../../../shell/parse/scope.ts'
import { getTestParser } from '../../../fixtures/workspace_fixture.ts'

// Mirrors python/tests/workspace/executor/builtins/lookup/test_handle.py.

const MOUNT_COMMANDS = new Set(['cat', 'grep', 'ls', 'jq'])

function noop(): [null, IOResult] {
  return [null, new IOResult()]
}

const TREE = new CLI({
  spec: new CommandSpec({ name: 'linear', subcommands: [new CommandSpec({ name: 'issue' })] }),
  handlers: { issue: new CLIHandler({ fn: noop }) },
})

function makeRegistry(withCli = false): MountRegistry {
  const clis = new CLIRegistry()
  if (withCli) clis.install('linear', TREE)
  return {
    runtimeEntries: [],
    mountForCommand: (name: string): unknown => (MOUNT_COMMANDS.has(name) ? {} : null),
    clis,
  } as unknown as MountRegistry
}

function makeSession(): SessionState {
  return new SessionState({ sessionId: 's1' })
}

async function body(out: ByteSource | null): Promise<string> {
  if (out === null) return ''
  const buf = out instanceof Uint8Array ? out : await materialize(out as AsyncIterable<Uint8Array>)
  return new TextDecoder().decode(buf)
}

function decode(b: Uint8Array | null): string {
  return b === null ? '' : new TextDecoder().decode(b)
}

describe('handleType', () => {
  it('reports a builtin', async () => {
    const [out, io] = handleType(['cd'], makeSession(), makeRegistry())
    expect(await body(out)).toBe('cd is a shell builtin\n')
    expect(io.exitCode).toBe(0)
  })

  it('reports a keyword', async () => {
    const [out] = handleType(['if'], makeSession(), makeRegistry())
    expect(await body(out)).toBe('if is a shell keyword\n')
  })

  it('-a prints the function under a keyword', async () => {
    const session = makeSession()
    session.functions.then = 'then() { echo x; }'
    const [out] = handleType(
      ['-a', 'then'],
      session,
      makeRegistry(),
      new ParseScope(await getTestParser()),
    )
    expect(await body(out)).toBe(
      'then is a shell keyword\nthen is a function\nfunction then () \n{ \n    echo x\n}\n',
    )
  })

  it('reports an installed CLI by its file', async () => {
    const [out] = handleType(['linear'], makeSession(), makeRegistry(true))
    expect(await body(out)).toBe('linear is /usr/bin/linear\n')
    expect(await body(handleType(['-t', 'linear'], makeSession(), makeRegistry(true))[0])).toBe(
      'file\n',
    )
  })

  it('-t prints the classification word', async () => {
    expect(await body(handleType(['-t', 'cd'], makeSession(), makeRegistry())[0])).toBe('builtin\n')
    expect(await body(handleType(['-t', 'if'], makeSession(), makeRegistry())[0])).toBe('keyword\n')
  })

  it('resolves -t and -p as one group, last one typed winning', async () => {
    // bash: `type -tp cd` prints a path (empty here), `type -pt cd` the
    // type word.
    expect(await body(handleType(['-tp', 'cd'], makeSession(), makeRegistry())[0])).toBe('')
    expect(await body(handleType(['-pt', 'cd'], makeSession(), makeRegistry())[0])).toBe(
      'builtin\n',
    )
    expect(await body(handleType(['-P', 'cd'], makeSession(), makeRegistry())[0])).toBe('')
  })

  it('reports a mount command by its file', async () => {
    const [out] = handleType(['cat'], makeSession(), makeRegistry())
    expect(await body(out)).toBe('cat is /usr/bin/cat\n')
  })

  it('-p prints a program file and -P searches past a builtin', async () => {
    // bash 5.2: -p is quiet for a builtin (still found), -P finds the file
    // behind one, and misses one that has none.
    const run = async (args: string[]): Promise<string> =>
      body(handleType(args, makeSession(), makeRegistry())[0])
    expect(await run(['-p', 'cat'])).toBe('/usr/bin/cat\n')
    expect(await run(['-p', 'echo'])).toBe('')
    expect(await run(['-P', 'echo'])).toBe('/usr/bin/echo\n')
    expect(await run(['-ap', 'echo'])).toBe('/usr/bin/echo\n')
    expect(handleType(['-P', 'cd'], makeSession(), makeRegistry())[1].exitCode).toBe(1)
  })

  it('-a prints every layer holding the name', async () => {
    const session = makeSession()
    session.functions.linear = 'linear() { :; }'
    const [out] = handleType(
      ['-a', 'linear'],
      session,
      makeRegistry(true),
      new ParseScope(await getTestParser()),
    )
    expect(await body(out)).toBe(
      'linear is a function\nlinear () \n{ \n    :\n}\nlinear is /usr/bin/linear\n',
    )
    const [words] = handleType(['-at', 'linear'], session, makeRegistry(true))
    expect(await body(words)).toBe('function\nfile\n')
    const [echo] = handleType(['-a', 'echo'], makeSession(), makeRegistry())
    expect(await body(echo)).toBe('echo is a shell builtin\necho is /usr/bin/echo\n')
  })

  it('-f skips the function table so the CLI below it shows', async () => {
    const session = makeSession()
    session.functions.linear = 'linear() { :; }'
    const [out] = handleType(['-f', 'linear'], session, makeRegistry(true))
    expect(await body(out)).toBe('linear is /usr/bin/linear\n')
    expect(session.functions.linear).toBe('linear() { :; }')
  })

  it('-f on a function-only name is not found', () => {
    const session = makeSession()
    session.functions.myfn = 'myfn() { :; }'
    const [out, io] = handleType(['-f', 'myfn'], session, makeRegistry())
    expect(out).toBeNull()
    expect(io.exitCode).toBe(1)
  })

  it('warns and exits 1 for an unknown name', async () => {
    const [out, io] = handleType(['nope'], makeSession(), makeRegistry())
    expect(out).toBeNull()
    expect(io.exitCode).toBe(1)
    expect(decode(await materialize(io.stderr))).toBe('bash: type: nope: not found\n')
  })

  it('-t is silent for an unknown name', async () => {
    const [out, io] = handleType(['-t', 'nope'], makeSession(), makeRegistry())
    expect(out).toBeNull()
    expect(io.exitCode).toBe(1)
    expect(decode(await materialize(io.stderr))).toBe('')
  })

  it('uses the all-found exit rule', async () => {
    const [out, io] = handleType(['cd', 'nope'], makeSession(), makeRegistry())
    expect(await body(out)).toBe('cd is a shell builtin\n')
    expect(io.exitCode).toBe(1)
  })

  it('-p is empty for a builtin', () => {
    const [out, io] = handleType(['-p', 'cd'], makeSession(), makeRegistry())
    expect(out).toBeNull()
    expect(io.exitCode).toBe(0)
  })

  it('rejects an invalid option', async () => {
    const [, io] = handleType(['-x', 'cd'], makeSession(), makeRegistry())
    expect(io.exitCode).toBe(2)
    expect(
      decode(await materialize(io.stderr)).startsWith('bash: type: -x: invalid option\n'),
    ).toBe(true)
  })
})

describe('handleWhich', () => {
  it('prints the file of every program', async () => {
    const registry = makeRegistry(true)
    for (const name of ['linear', 'cat', 'echo', 'xargs']) {
      expect(await body(handleWhich([name], makeSession(), registry)[0])).toBe(`/usr/bin/${name}\n`)
    }
  })

  it('misses a builtin with no program', () => {
    // debianutils which: cd is bash's alone, so nothing and exit 1.
    const [out, io] = handleWhich(['cd'], makeSession(), makeRegistry())
    expect(out).toBeNull()
    expect(io.exitCode).toBe(1)
  })

  it('is silent on a miss and exits 1', async () => {
    const [out, io] = handleWhich(['nope'], makeSession(), makeRegistry())
    expect(out).toBeNull()
    expect(io.exitCode).toBe(1)
    expect(decode(await materialize(io.stderr))).toBe('')
  })

  it('does not resolve a keyword', () => {
    const [out, io] = handleWhich(['if'], makeSession(), makeRegistry())
    expect(out).toBeNull()
    expect(io.exitCode).toBe(1)
  })

  it('does not resolve a function', () => {
    // `which` searches PATH, which holds no function.
    const session = makeSession()
    session.functions.then = 'then() { :; }'
    session.functions.myfn = 'myfn() { :; }'
    for (const name of ['then', 'myfn']) {
      const [out, io] = handleWhich([name], session, makeRegistry())
      expect(out).toBeNull()
      expect(io.exitCode).toBe(1)
    }
  })

  it('uses the all-found exit rule and exits 1 with no operands', async () => {
    const [out, io] = handleWhich(['cat', 'nope'], makeSession(), makeRegistry())
    expect(await body(out)).toBe('/usr/bin/cat\n')
    expect(io.exitCode).toBe(1)
    expect(handleWhich([], makeSession(), makeRegistry())[1].exitCode).toBe(1)
  })

  it('-a prints the one file past a shadowing function and -s reports through the status', async () => {
    // One directory on PATH, so one line; the function has no file.
    const session = makeSession()
    session.functions.linear = 'linear() { :; }'
    const [out] = handleWhich(['-a', 'linear'], session, makeRegistry(true))
    expect(await body(out)).toBe('/usr/bin/linear\n')
    const [quiet, io] = handleWhich(['-s', 'linear'], session, makeRegistry(true))
    expect(quiet).toBeNull()
    expect(io.exitCode).toBe(0)
  })

  it('rejects an invalid option', async () => {
    const [, io] = handleWhich(['-z', 'cd'], makeSession(), makeRegistry())
    expect(io.exitCode).toBe(2)
    expect(decode(await materialize(io.stderr)).startsWith('which: -z: invalid option\n')).toBe(
      true,
    )
  })
})
