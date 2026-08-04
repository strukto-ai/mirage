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
import { CLISpec } from '../../../../commands/cli/types.ts'
import { IOResult, materialize } from '../../../../io/types.ts'
import type { ByteSource } from '../../../../io/types.ts'
import { CLIRegistry } from '../../../cli/registry.ts'
import type { MountRegistry } from '../../../mount/registry.ts'
import { Session } from '../../../session/session.ts'
import { handleType, handleWhich } from './handle.ts'

// Mirrors python/tests/workspace/executor/builtins/lookup/test_handle.py.

const MOUNT_COMMANDS = new Set(['cat', 'grep', 'ls', 'jq'])

function noop(): [null, IOResult] {
  return [null, new IOResult()]
}

const TREE = new CLISpec({
  name: 'linear',
  subcommands: [new CLISpec({ name: 'issue', fn: noop })],
})

function makeRegistry(withCli = false): MountRegistry {
  const clis = new CLIRegistry()
  if (withCli) clis.install('linear', TREE)
  return {
    mountForCommand: (name: string): unknown => (MOUNT_COMMANDS.has(name) ? {} : null),
    clis,
  } as unknown as MountRegistry
}

function makeSession(): Session {
  return new Session({ sessionId: 's1' })
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
    session.functions.then = 'then() { :; }'
    const [out] = handleType(['-a', 'then'], session, makeRegistry())
    expect(await body(out)).toBe('then is a shell keyword\nthen is a function\n')
  })

  it('reports an installed CLI as its own kind', async () => {
    const [out] = handleType(['linear'], makeSession(), makeRegistry(true))
    expect(await body(out)).toBe('linear is a mirage CLI\n')
    expect(await body(handleType(['-t', 'linear'], makeSession(), makeRegistry(true))[0])).toBe(
      'cli\n',
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

  it('classifies a mount command as a builtin', async () => {
    const [out] = handleType(['cat'], makeSession(), makeRegistry())
    expect(await body(out)).toBe('cat is a shell builtin\n')
  })

  it('-a prints every layer holding the name', async () => {
    const session = makeSession()
    session.functions.linear = 'linear() { :; }'
    const [out] = handleType(['-a', 'linear'], session, makeRegistry(true))
    expect(await body(out)).toBe('linear is a function\nlinear is a mirage CLI\n')
    const [words] = handleType(['-at', 'linear'], session, makeRegistry(true))
    expect(await body(words)).toBe('function\ncli\n')
  })

  it('-f skips the function table so the CLI below it shows', async () => {
    const session = makeSession()
    session.functions.linear = 'linear() { :; }'
    const [out] = handleType(['-f', 'linear'], session, makeRegistry(true))
    expect(await body(out)).toBe('linear is a mirage CLI\n')
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
    expect(decode(await materialize(io.stderr))).toBe('type: nope: not found\n')
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
    expect(decode(await materialize(io.stderr)).startsWith('type: -x: invalid option\n')).toBe(true)
  })
})

describe('handleWhich', () => {
  it('prints the name for every runnable, with no fake path', async () => {
    const registry = makeRegistry(true)
    expect(await body(handleWhich(['linear'], makeSession(), registry)[0])).toBe('linear\n')
    expect(await body(handleWhich(['cd'], makeSession(), registry)[0])).toBe('cd\n')
    expect(await body(handleWhich(['cat'], makeSession(), registry)[0])).toBe('cat\n')
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

  it('reports the layer under a keyword', async () => {
    // The keyword is filtered before the winner is picked, so the
    // function below it is what `which` resolves.
    const session = makeSession()
    session.functions.then = 'then() { :; }'
    const [out, io] = handleWhich(['then'], session, makeRegistry())
    expect(await body(out)).toBe('then\n')
    expect(io.exitCode).toBe(0)
  })

  it('uses the all-found exit rule and exits 1 with no operands', async () => {
    const [out, io] = handleWhich(['cd', 'nope'], makeSession(), makeRegistry())
    expect(await body(out)).toBe('cd\n')
    expect(io.exitCode).toBe(1)
    expect(handleWhich([], makeSession(), makeRegistry())[1].exitCode).toBe(1)
  })

  it('-a prints a line per layer and -s reports through the status', async () => {
    const session = makeSession()
    session.functions.linear = 'linear() { :; }'
    const [out] = handleWhich(['-a', 'linear'], session, makeRegistry(true))
    expect(await body(out)).toBe('linear\nlinear\n')
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
