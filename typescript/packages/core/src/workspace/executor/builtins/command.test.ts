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

import { describe, expect, it, vi } from 'vitest'
import { IOResult, materialize } from '../../../io/types.ts'
import type { ByteSource } from '../../../io/types.ts'
import type { MountRegistry } from '../../mount/registry.ts'
import { Session } from '../../session/session.ts'
import { handleCommandBuiltin, handleType, parseFlags } from './command.ts'

const MOUNT_COMMANDS = new Set(['cat', 'grep', 'ls', 'jq'])

function makeRegistry(): MountRegistry {
  return {
    mountForCommand: (name: string): unknown => (MOUNT_COMMANDS.has(name) ? {} : null),
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

describe('parseFlags', () => {
  it('last of -v/-V wins', () => {
    expect(parseFlags(['-v', 'ls'])).toEqual(['v', ['ls'], null])
    expect(parseFlags(['-V', 'ls'])).toEqual(['V', ['ls'], null])
    expect(parseFlags(['-vV', 'ls'])).toEqual(['V', ['ls'], null])
    expect(parseFlags(['-Vv', 'ls'])).toEqual(['v', ['ls'], null])
  })

  it('accepts -p but it is inert', () => {
    expect(parseFlags(['-p', 'ls'])).toEqual([null, ['ls'], null])
    expect(parseFlags(['-pv', 'ls'])).toEqual(['v', ['ls'], null])
  })

  it('stops at the first operand (flag after name belongs to target)', () => {
    expect(parseFlags(['ls', '-l'])).toEqual([null, ['ls', '-l'], null])
    expect(parseFlags(['-v', 'ls', '-l'])).toEqual(['v', ['ls', '-l'], null])
  })

  it('-- ends options', () => {
    expect(parseFlags(['--', 'ls'])).toEqual([null, ['ls'], null])
    expect(parseFlags(['-v', '--', 'ls'])).toEqual(['v', ['ls'], null])
  })

  it('reports the first invalid option', () => {
    expect(parseFlags(['-x', 'ls'])).toEqual([null, [], '-x'])
    expect(parseFlags(['-vx', 'ls'])).toEqual([null, [], '-x'])
  })

  it('a bare dash is an operand', () => {
    expect(parseFlags(['-'])).toEqual([null, ['-'], null])
  })
})

describe('handleCommandBuiltin -v/-V', () => {
  it('-v prints the name with no fake path', async () => {
    const [out, io] = await handleCommandBuiltin(
      vi.fn(),
      ['-v', 'cat'],
      makeSession(),
      makeRegistry(),
    )
    expect(await body(out)).toBe('cat\n')
    expect(io.exitCode).toBe(0)
  })

  it('-v on a keyword prints the keyword', async () => {
    const [out, io] = await handleCommandBuiltin(
      vi.fn(),
      ['-v', 'if'],
      makeSession(),
      makeRegistry(),
    )
    expect(await body(out)).toBe('if\n')
    expect(io.exitCode).toBe(0)
  })

  it('-v not-found is silent with rc 1', async () => {
    const [out, io] = await handleCommandBuiltin(
      vi.fn(),
      ['-v', 'nope_xyz'],
      makeSession(),
      makeRegistry(),
    )
    expect(out).toBeNull()
    expect(io.exitCode).toBe(1)
    expect(decode(await materialize(io.stderr))).toBe('')
  })

  it('-v multi-name exits 0 if any found', async () => {
    const [out, io] = await handleCommandBuiltin(
      vi.fn(),
      ['-v', 'ls', 'nope_xyz', 'cat'],
      makeSession(),
      makeRegistry(),
    )
    expect(await body(out)).toBe('ls\ncat\n')
    expect(io.exitCode).toBe(0)
  })

  it('-v multi-name exits 1 if none found', async () => {
    const [, io] = await handleCommandBuiltin(
      vi.fn(),
      ['-v', 'nope1', 'nope2'],
      makeSession(),
      makeRegistry(),
    )
    expect(io.exitCode).toBe(1)
  })

  it('-V verbose line for a builtin', async () => {
    const [out, io] = await handleCommandBuiltin(
      vi.fn(),
      ['-V', 'cd'],
      makeSession(),
      makeRegistry(),
    )
    expect(await body(out)).toBe('cd is a shell builtin\n')
    expect(io.exitCode).toBe(0)
  })

  it('-V verbose line for a keyword', async () => {
    const [out] = await handleCommandBuiltin(vi.fn(), ['-V', 'if'], makeSession(), makeRegistry())
    expect(await body(out)).toBe('if is a shell keyword\n')
  })

  it('-V not-found warns on stderr with rc 1', async () => {
    const [out, io] = await handleCommandBuiltin(
      vi.fn(),
      ['-V', 'nope_xyz'],
      makeSession(),
      makeRegistry(),
    )
    expect(out).toBeNull()
    expect(decode(await materialize(io.stderr))).toBe('command: nope_xyz: not found\n')
    expect(io.exitCode).toBe(1)
  })

  it('reports a function', async () => {
    const session = makeSession()
    session.functions.myfn = []
    const [out, io] = await handleCommandBuiltin(vi.fn(), ['-V', 'myfn'], session, makeRegistry())
    expect(await body(out)).toBe('myfn is a function\n')
    expect(io.exitCode).toBe(0)
  })

  it('last of -vV/-Vv wins for output shape', async () => {
    const [vOut] = await handleCommandBuiltin(
      vi.fn(),
      ['-Vv', 'cat'],
      makeSession(),
      makeRegistry(),
    )
    expect(await body(vOut)).toBe('cat\n')
    const [bigVOut] = await handleCommandBuiltin(
      vi.fn(),
      ['-vV', 'cat'],
      makeSession(),
      makeRegistry(),
    )
    expect(await body(bigVOut)).toBe('cat is a shell builtin\n')
  })
})

describe('handleCommandBuiltin errors and no-op', () => {
  it('invalid option exits 2 with usage', async () => {
    const [, io] = await handleCommandBuiltin(vi.fn(), ['-x', 'ls'], makeSession(), makeRegistry())
    expect(io.exitCode).toBe(2)
    expect(decode(await materialize(io.stderr))).toBe(
      'command: -x: invalid option\ncommand: usage: command [-pVv] command [arg ...]\n',
    )
  })

  it('no args exits 0', async () => {
    const [, io] = await handleCommandBuiltin(vi.fn(), [], makeSession(), makeRegistry())
    expect(io.exitCode).toBe(0)
  })

  it('-v with no name exits 0', async () => {
    const [, io] = await handleCommandBuiltin(vi.fn(), ['-v'], makeSession(), makeRegistry())
    expect(io.exitCode).toBe(0)
  })
})

describe('handleCommandBuiltin run mode', () => {
  it('joins operands and runs them', async () => {
    const shell = vi.fn(() =>
      Promise.resolve(new IOResult({ stdout: new TextEncoder().encode('hello\n') })),
    )
    const [out, io] = await handleCommandBuiltin(
      shell,
      ['echo', 'hello'],
      makeSession(),
      makeRegistry(),
    )
    expect(shell).toHaveBeenCalledWith('echo hello', expect.objectContaining({ sessionId: 's1' }))
    expect(io.exitCode).toBe(0)
    expect(await body(out)).toBe('hello\n')
  })

  it('shell-quotes operands so they survive re-parsing', async () => {
    const shell = vi.fn(() => Promise.resolve(new IOResult()))
    await handleCommandBuiltin(shell, ['echo', 'a b', '$x'], makeSession(), makeRegistry())
    expect(shell).toHaveBeenCalledWith("echo 'a b' '$x'", expect.anything())
  })

  it('forwards pipe stdin to the inner command', async () => {
    const shell = vi.fn(() => Promise.resolve(new IOResult()))
    const piped = new TextEncoder().encode('piped\n')
    await handleCommandBuiltin(shell, ['cat'], makeSession(), makeRegistry(), piped)
    expect(shell).toHaveBeenCalledWith('cat', expect.objectContaining({ stdin: piped }))
  })

  it('masks a shadowing function for the inner run and restores it', async () => {
    const session = makeSession()
    const fnBody = ['<fn-body>']
    session.functions.cat = fnBody
    let maskedDuringCall = false
    const shell = vi.fn(() => {
      maskedDuringCall = !('cat' in session.functions)
      return Promise.resolve(new IOResult())
    })
    await handleCommandBuiltin(shell, ['cat'], session, makeRegistry())
    expect(maskedDuringCall).toBe(true)
    expect(session.functions.cat).toBe(fnBody)
  })
})

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

  it('-t prints the classification word', async () => {
    expect(await body(handleType(['-t', 'cd'], makeSession(), makeRegistry())[0])).toBe('builtin\n')
    expect(await body(handleType(['-t', 'if'], makeSession(), makeRegistry())[0])).toBe('keyword\n')
  })

  it('classifies a mount command as a builtin', async () => {
    const [out] = handleType(['cat'], makeSession(), makeRegistry())
    expect(await body(out)).toBe('cat is a shell builtin\n')
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
