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
import { GENERAL_COMMANDS } from '../../commands/builtin/general/index.ts'
import { IOResult, materialize } from '../../io/types.ts'
import type { ByteSource } from '../../io/types.ts'
import { RAMResource } from '../../resource/ram/ram.ts'
import { CallStack } from '../../shell/call_stack.ts'
import { FileStat, FileType, MountMode } from '../../types.ts'
import { MountRegistry } from '../mount/registry.ts'
import type { MountEntry } from '../mount/mount.ts'
import { Namespace } from '../mount/namespace/namespace.ts'
import { Session } from '../session/session.ts'
import type { ResolveFn } from '../dispatcher.ts'
import type { DispatchFn } from './cross_mount.ts'
import {
  handleCd,
  handleEcho,
  handleEval,
  handleExport,
  handleLocal,
  handleMan,
  handlePrintenv,
  handlePrintf,
  handleRead,
  handleReturn,
  handleSet,
  handleShift,
  handleSleep,
  handleSource,
  handleTest,
  handleTimeout,
  handleTrap,
  handleUnset,
  handleWhoami,
  handleXargs,
} from './builtins/index.ts'
import { parseDuration } from './builtins/timeout.ts'
import { ReturnSignal } from './command.ts'

function wireMount(mount: MountEntry): void {
  const cmds = mount.resource.commands?.()
  if (cmds !== undefined) {
    for (const cmd of cmds) {
      if (cmd.filetype !== null) mount.register(cmd)
      else if (cmd.resource === null) mount.registerGeneral(cmd)
      else mount.register(cmd)
    }
  }
  for (const cmd of GENERAL_COMMANDS) {
    mount.registerGeneral(cmd)
  }
}

function wireRegistry(reg: MountRegistry): void {
  for (const m of reg.allMounts()) wireMount(m)
}

async function readBody(out: ByteSource | null): Promise<string> {
  if (out === null) return ''
  const buf = out instanceof Uint8Array ? out : await materialize(out as AsyncIterable<Uint8Array>)
  return new TextDecoder().decode(buf)
}

function decode(b: Uint8Array | null): string {
  if (b === null) return ''
  return new TextDecoder().decode(b)
}

describe('handleExport / handleUnset / handlePrintenv', () => {
  it('export KEY=VAL sets session env', () => {
    const s = new Session({ sessionId: 'test' })
    handleExport(['FOO=bar', 'BAZ=qux'], s)
    expect(s.env.FOO).toBe('bar')
    expect(s.env.BAZ).toBe('qux')
  })

  it('export KEY (no =) initializes empty if missing', () => {
    const s = new Session({ sessionId: 'test', env: { X: 'existing' } })
    handleExport(['X', 'Y'], s)
    expect(s.env.X).toBe('existing')
    expect(s.env.Y).toBe('')
  })

  it('unset removes keys', () => {
    const s = new Session({ sessionId: 'test', env: { A: '1', B: '2' } })
    handleUnset(['A'], s)
    expect('A' in s.env).toBe(false)
    expect(s.env.B).toBe('2')
  })

  it('printenv VAR emits value + newline; exit 1 if missing', () => {
    const s = new Session({ sessionId: 'test', env: { X: 'yes' } })
    const [out, io] = handlePrintenv('X', s)
    expect(decode(out as Uint8Array)).toBe('yes\n')
    expect(io.exitCode).toBe(0)
    const [, io2] = handlePrintenv('MISSING', s)
    expect(io2.exitCode).toBe(1)
  })

  it('printenv with no name lists sorted KEY=VAL', () => {
    const s = new Session({ sessionId: 'test', env: { B: '2', A: '1' } })
    const [out] = handlePrintenv(null, s)
    expect(decode(out as Uint8Array)).toBe('A=1\nB=2\n')
  })
})

describe('handleWhoami', () => {
  const unusedResolve: ResolveFn = () => Promise.reject(new Error('unused'))
  const emptyRegistry = () => new MountRegistry({}, MountMode.READ)

  it('prints the workspace user + newline, exit 0, no stderr', () => {
    const ns = new Namespace(emptyRegistry(), unusedResolve, undefined, 'alice')
    const [out, io] = handleWhoami(ns)
    expect(decode(out as Uint8Array)).toBe('alice\n')
    expect(io.exitCode).toBe(0)
    expect(io.stderr).toBeNull()
  })

  it('errors without an identity', () => {
    const ns = new Namespace(emptyRegistry(), unusedResolve)
    const [out, io] = handleWhoami(ns)
    expect(out).toBeNull()
    expect(io.exitCode).toBe(1)
    expect(decode(io.stderr as Uint8Array)).toBe('whoami: cannot find name for user ID\n')
  })
})

describe('handleEcho', () => {
  it('joins args with space and appends newline', () => {
    const [out] = handleEcho(['hi', 'there'])
    expect(decode(out as Uint8Array)).toBe('hi there\n')
  })

  it('-n suppresses trailing newline', () => {
    const [out] = handleEcho(['-n', 'hi'])
    expect(decode(out as Uint8Array)).toBe('hi')
  })

  it('-e interprets backslash escapes', () => {
    const [out] = handleEcho(['-e', 'hello\\nworld'])
    expect(decode(out as Uint8Array)).toBe('hello\nworld\n')
  })

  it('-e \\t becomes tab', () => {
    const [out] = handleEcho(['-e', 'a\\tb'])
    expect(decode(out as Uint8Array)).toBe('a\tb\n')
  })

  it('-e unknown escape passes through literally', () => {
    const [out] = handleEcho(['-e', '\\z'])
    expect(decode(out as Uint8Array)).toBe('\\z\n')
  })

  it('-e \\c stops output at that point', () => {
    const [out] = handleEcho(['-e', 'hi\\cgone'])
    expect(decode(out as Uint8Array)).toBe('hi\n')
  })
})

describe('handlePrintf', () => {
  it('empty args → empty output', () => {
    const [out] = handlePrintf([])
    expect((out as Uint8Array).byteLength).toBe(0)
  })

  it('format string only → literal output', () => {
    const [out] = handlePrintf(['hello'])
    expect(decode(out as Uint8Array)).toBe('hello')
  })

  it('%s substitution', () => {
    const [out] = handlePrintf(['name=%s', 'alice'])
    expect(decode(out as Uint8Array)).toBe('name=alice')
  })

  it('\\n escape becomes newline in format', () => {
    const [out] = handlePrintf(['a\\nb'])
    expect(decode(out as Uint8Array)).toBe('a\nb')
  })
})

describe('handleSleep', () => {
  it('rejects invalid seconds', async () => {
    const [, io] = await handleSleep(['abc'])
    expect(io.exitCode).toBe(1)
    expect(decode(io.stderr as Uint8Array)).toBe("sleep: invalid time interval 'abc'\n")
  })

  it('rejects missing operand', async () => {
    const [, io] = await handleSleep([])
    expect(io.exitCode).toBe(1)
    expect(decode(io.stderr as Uint8Array)).toBe('sleep: missing operand\n')
  })

  it.each(['-1', 'inf', 'Infinity', 'nan', 'NaN', '0x10', '1_0', '1e309', ''])(
    'rejects %j as invalid time interval',
    async (raw) => {
      const [, io] = await handleSleep([raw])
      expect(io.exitCode).toBe(1)
      expect(decode(io.stderr as Uint8Array)).toBe(`sleep: invalid time interval '${raw}'\n`)
    },
  )

  it.each(['0', '0.', '.01', '+0.01', '1e-3'])('accepts %j and exits 0', async (raw) => {
    const [, io] = await handleSleep([raw])
    expect(io.exitCode).toBe(0)
    expect(io.stderr).toBeNull()
  })

  it('sleeps for 0 seconds', async () => {
    const start = Date.now()
    const [, io] = await handleSleep(['0'])
    const elapsed = Date.now() - start
    expect(io.exitCode).toBe(0)
    expect(elapsed).toBeLessThan(50)
  })
})

describe('handleCd', () => {
  it('resolves to / for root', async () => {
    const dispatch = vi.fn<DispatchFn>(() =>
      Promise.resolve<[unknown, IOResult]>([null, new IOResult()]),
    )
    const s = new Session({ sessionId: 'test', cwd: '/ram' })
    const [, io] = await handleCd(dispatch, () => false, '/', s)
    expect(io.exitCode).toBe(0)
    expect(s.cwd).toBe('/')
  })

  it('sets cwd when target is a directory', async () => {
    const dispatch = vi.fn<DispatchFn>(() =>
      Promise.resolve<[unknown, IOResult]>([
        new FileStat({ name: 'data', type: FileType.DIRECTORY }),
        new IOResult(),
      ]),
    )
    const s = new Session({ sessionId: 'test', cwd: '/ram' })
    await handleCd(dispatch, () => true, '/ram/data', s)
    expect(s.cwd).toBe('/ram/data')
  })

  it('rejects non-directory targets', async () => {
    const dispatch = vi.fn<DispatchFn>(() =>
      Promise.resolve<[unknown, IOResult]>([
        new FileStat({ name: 'file', type: FileType.TEXT }),
        new IOResult(),
      ]),
    )
    const s = new Session({ sessionId: 'test', cwd: '/ram' })
    const [, io] = await handleCd(dispatch, () => true, '/ram/file', s)
    expect(io.exitCode).toBe(1)
    expect(decode(io.stderr as Uint8Array)).toMatch(/Not a directory/)
  })

  it('rejects when stat returns null and path is not a mount root', async () => {
    const dispatch = vi.fn<DispatchFn>(() =>
      Promise.resolve<[unknown, IOResult]>([null, new IOResult()]),
    )
    const s = new Session({ sessionId: 'test', cwd: '/' })
    const [, io] = await handleCd(dispatch, () => false, '/missing', s)
    expect(io.exitCode).toBe(1)
    expect(decode(io.stderr as Uint8Array)).toMatch(/No such file or directory/)
    expect(s.cwd).toBe('/')
  })

  it('rejects when stat throws not-found and path is not a mount root', async () => {
    const dispatch = vi.fn<DispatchFn>(() => Promise.reject(new Error('not found: /x')))
    const s = new Session({ sessionId: 'test', cwd: '/' })
    const [, io] = await handleCd(dispatch, () => false, '/missing', s)
    expect(io.exitCode).toBe(1)
    expect(decode(io.stderr as Uint8Array)).toMatch(/No such file or directory/)
    expect(s.cwd).toBe('/')
  })

  it('allows cd to a mount root even when stat returns null', async () => {
    const dispatch = vi.fn<DispatchFn>(() =>
      Promise.resolve<[unknown, IOResult]>([null, new IOResult()]),
    )
    const s = new Session({ sessionId: 'test', cwd: '/' })
    const [, io] = await handleCd(dispatch, (p) => p === '/data', '/data', s)
    expect(io.exitCode).toBe(0)
    expect(s.cwd).toBe('/data')
  })
})

describe('handleEval', () => {
  it('calls the provided executeFn with joined args', async () => {
    const exec = vi.fn(() => Promise.resolve(new IOResult({ exitCode: 7 })))
    const s = new Session({ sessionId: 'sess' })
    const [, io] = await handleEval(exec, ['echo', 'hi'], s)
    expect(io.exitCode).toBe(7)
    expect(exec).toHaveBeenCalledWith('echo hi', { sessionId: 'sess' })
  })
})

describe('handleTest', () => {
  const dispatch = vi.fn<DispatchFn>(() =>
    Promise.resolve<[unknown, IOResult]>([new FileStat({ name: 'x' }), new IOResult()]),
  )
  const session = new Session({ sessionId: 'test' })

  it('-z on empty string → true (exit 0)', async () => {
    const [, io] = await handleTest(dispatch, ['-z', ''], session)
    expect(io.exitCode).toBe(0)
  })

  it('-z on non-empty → false (exit 1)', async () => {
    const [, io] = await handleTest(dispatch, ['-z', 'x'], session)
    expect(io.exitCode).toBe(1)
  })

  it('integer comparison -eq', async () => {
    const [, io] = await handleTest(dispatch, ['3', '-eq', '3'], session)
    expect(io.exitCode).toBe(0)
    const [, io2] = await handleTest(dispatch, ['3', '-eq', '4'], session)
    expect(io2.exitCode).toBe(1)
  })

  it('string equality =', async () => {
    const [, io] = await handleTest(dispatch, ['foo', '=', 'foo'], session)
    expect(io.exitCode).toBe(0)
  })

  it('-f relative operand resolves against session.cwd', async () => {
    const spy = vi.fn<DispatchFn>((op, scope) => {
      const ps = scope
      if (ps.virtual === '/data/plain.txt') {
        return Promise.resolve<[unknown, IOResult]>([
          new FileStat({ name: 'plain.txt' }),
          new IOResult(),
        ])
      }
      return Promise.reject(new Error(`not found: ${ps.virtual}`))
    })
    const s = new Session({ sessionId: 'test' })
    s.cwd = '/data'
    const [, io] = await handleTest(spy, ['-f', 'plain.txt'], s)
    expect(io.exitCode).toBe(0)
    const [, io2] = await handleTest(spy, ['-f', 'missing.txt'], s)
    expect(io2.exitCode).toBe(1)
  })

  it('-f empty operand is false without dispatch', async () => {
    const spy = vi.fn<DispatchFn>(() =>
      Promise.resolve<[unknown, IOResult]>([new FileStat({ name: 'x' }), new IOResult()]),
    )
    const s = new Session({ sessionId: 'test' })
    const [, io] = await handleTest(spy, ['-f', ''], s)
    expect(io.exitCode).toBe(1)
    expect(spy).not.toHaveBeenCalled()
  })

  it('-d relative operand resolves against session.cwd', async () => {
    const spy = vi.fn<DispatchFn>((op, scope) => {
      const ps = scope
      if (op === 'readdir' && ps.virtual === '/data/sub') {
        return Promise.resolve<[unknown, IOResult]>([[], new IOResult()])
      }
      return Promise.reject(new Error(`not found: ${ps.virtual}`))
    })
    const s = new Session({ sessionId: 'test' })
    s.cwd = '/data'
    const [, io] = await handleTest(spy, ['-d', 'sub'], s)
    expect(io.exitCode).toBe(0)
  })
})

describe('handleShift', () => {
  it('shifts call-stack positional args', () => {
    const cs = new CallStack()
    cs.push(['a', 'b', 'c', 'd'])
    handleShift(['2'], cs, null)
    expect(cs.getAllPositional()).toEqual(['c', 'd'])
  })

  it('shifts session.positionalArgs when call stack empty', () => {
    const cs = new CallStack()
    const s = new Session({ sessionId: 'test', positionalArgs: ['x', 'y', 'z'] })
    handleShift(['1'], cs, s)
    expect(s.positionalArgs).toEqual(['y', 'z'])
  })
})

describe('handleSet', () => {
  it('no args → print env', () => {
    const s = new Session({ sessionId: 'test', env: { A: '1' } })
    const [out] = handleSet([], s)
    expect(decode(out as Uint8Array)).toBe('A=1\n')
  })

  it('"-- a b" sets positional args', () => {
    const s = new Session({ sessionId: 'test' })
    handleSet(['--', 'a', 'b'], s)
    expect(s.positionalArgs).toEqual(['a', 'b'])
  })
})

describe('handleTrap / handleReturn / handleLocal', () => {
  it('handleTrap is a no-op with exit 0', () => {
    const session = new Session({ sessionId: 'test' })
    const [, io] = handleTrap(session)
    expect(io.exitCode).toBe(0)
  })

  it('handleReturn throws ReturnSignal with exit code', () => {
    expect(() => handleReturn(['42'])).toThrow(ReturnSignal)
    try {
      handleReturn(['42'])
    } catch (err) {
      if (err instanceof ReturnSignal) expect(err.exitCode).toBe(42)
    }
  })

  it('handleLocal assigns to session.env', () => {
    const s = new Session({ sessionId: 'test' })
    handleLocal(['X=1'], s)
    expect(s.env.X).toBe('1')
  })
})

describe('handleRead', () => {
  it('reads single line into one variable', async () => {
    const s = new Session({ sessionId: 'test' })
    const stdin = new TextEncoder().encode('hello world\nrest\n')
    const [, io] = await handleRead(['LINE'], s, stdin)
    expect(io.exitCode).toBe(0)
    expect(s.env.LINE).toBe('hello world')
  })

  it('splits whitespace across multiple variables', async () => {
    const s = new Session({ sessionId: 'test' })
    const stdin = new TextEncoder().encode('alice 30 engineer\n')
    await handleRead(['NAME', 'AGE', 'ROLE'], s, stdin)
    expect(s.env.NAME).toBe('alice')
    expect(s.env.AGE).toBe('30')
    expect(s.env.ROLE).toBe('engineer')
  })

  it('last variable absorbs remainder', async () => {
    const s = new Session({ sessionId: 'test' })
    const stdin = new TextEncoder().encode('one two three four five\n')
    await handleRead(['A', 'B', 'C'], s, stdin)
    expect(s.env.A).toBe('one')
    expect(s.env.B).toBe('two')
    expect(s.env.C).toBe('three four five')
  })

  it('EOF / null stdin: assign empty + exit 1', async () => {
    const s = new Session({ sessionId: 'test' })
    const [, io] = await handleRead(['X', 'Y'], s, null)
    expect(io.exitCode).toBe(1)
    expect(s.env.X).toBe('')
    expect(s.env.Y).toBe('')
  })

  it('reads from AsyncIterable stdin', async () => {
    const s = new Session({ sessionId: 'test' })
    // eslint-disable-next-line @typescript-eslint/require-await
    async function* gen(): AsyncIterable<Uint8Array> {
      yield new TextEncoder().encode('streamed line\nignored\n')
    }
    await handleRead(['L'], s, gen())
    expect(s.env.L).toBe('streamed line')
  })
})

describe('handleSource', () => {
  it('dispatches read on the path then runs script', async () => {
    const s = new Session({ sessionId: 'test', cwd: '/' })
    const dispatch = vi.fn(() => {
      const data = new TextEncoder().encode('export FOO=bar\n')
      return Promise.resolve([data, new IOResult()] as [Uint8Array, IOResult])
    }) as unknown as DispatchFn
    let executed = ''
    const executeFn = vi.fn((script: string, _opts: { sessionId: string }) => {
      executed = script
      return Promise.resolve(new IOResult())
    })
    const [, io] = await handleSource(dispatch, executeFn, '/script.sh', s)
    expect(io.exitCode).toBe(0)
    expect(executed).toBe('export FOO=bar\n')
    expect(dispatch).toHaveBeenCalled()
  })

  it('returns exit 1 with stderr on read failure', async () => {
    const s = new Session({ sessionId: 'test', cwd: '/' })
    const dispatch = vi.fn(() => Promise.reject(new Error('not found'))) as unknown as DispatchFn
    const executeFn = vi.fn(() => Promise.resolve(new IOResult()))
    const [, io] = await handleSource(dispatch, executeFn, '/missing.sh', s)
    expect(io.exitCode).toBe(1)
    expect(decode(io.stderr instanceof Uint8Array ? io.stderr : null)).toMatch(/missing.sh/)
    expect(executeFn).not.toHaveBeenCalled()
  })
})

describe('handleMan', () => {
  it('renders header, description, and RESOURCES list for a known command', async () => {
    const reg = new MountRegistry({ '/ram/': new RAMResource() }, MountMode.WRITE)
    wireRegistry(reg)
    const s = new Session({ sessionId: 'test', cwd: '/' })
    const [out, io] = handleMan(['date'], s, reg)
    expect(io.exitCode).toBe(0)
    const body = await readBody(out)
    expect(body).toContain('# date')
    expect(body).toContain('## RESOURCES')
    expect(body).toMatch(/^- general$/m)
  })

  it('renders OPTIONS table when the spec has options', async () => {
    const reg = new MountRegistry({ '/ram/': new RAMResource() }, MountMode.WRITE)
    wireRegistry(reg)
    const s = new Session({ sessionId: 'test', cwd: '/' })
    const [out, io] = handleMan(['date'], s, reg)
    expect(io.exitCode).toBe(0)
    const body = await readBody(out)
    expect(body).toContain('## OPTIONS')
  })

  it('dedupes by resource kind across multiple mounts of the same resource', async () => {
    const reg = new MountRegistry(
      { '/ram-a/': new RAMResource(), '/ram-b/': new RAMResource() },
      MountMode.WRITE,
    )
    wireRegistry(reg)
    const s = new Session({ sessionId: 'test', cwd: '/' })
    const [out, io] = handleMan(['cat'], s, reg)
    expect(io.exitCode).toBe(0)
    const body = await readBody(out)
    const ramLines = body.split('\n').filter((l) => /^- ram\b/.test(l))
    expect(ramLines.length).toBe(1)
  })

  it('exits 1 with a clear error for unknown commands', () => {
    const reg = new MountRegistry({ '/ram/': new RAMResource() }, MountMode.WRITE)
    wireRegistry(reg)
    const s = new Session({ sessionId: 'test', cwd: '/' })
    const [, io] = handleMan(['definitely-not-a-real-command-xyz'], s, reg)
    expect(io.exitCode).toBe(1)
    const errBytes = io.stderr instanceof Uint8Array ? io.stderr : null
    expect(decode(errBytes)).toContain('no entry for definitely-not-a-real-command-xyz')
  })

  it('groups commands by resource kind, cwd resource first, general last', async () => {
    const reg = new MountRegistry({ '/ram/': new RAMResource() }, MountMode.WRITE)
    wireRegistry(reg)
    const s = new Session({ sessionId: 'test', cwd: '/ram/' })
    const [body, io] = handleMan([], s, reg)
    const out = await readBody(body)
    expect(io.exitCode).toBe(0)
    const ramIdx = out.indexOf('# ram')
    const generalIdx = out.indexOf('# general')
    expect(ramIdx).toBeGreaterThanOrEqual(0)
    expect(generalIdx).toBeGreaterThan(ramIdx)
  })

  it('dedupes when the same resource kind is mounted at multiple prefixes', async () => {
    const reg = new MountRegistry(
      { '/ram-a/': new RAMResource(), '/ram-b/': new RAMResource() },
      MountMode.WRITE,
    )
    wireRegistry(reg)
    const s = new Session({ sessionId: 'test', cwd: '/' })
    const [body] = handleMan([], s, reg)
    const out = await readBody(body)
    const matches = (out.match(/^# ram\b/gm) ?? []).length
    expect(matches).toBe(1)
  })
})

function fakeShell(exitCodes: number[] = []): {
  lines: string[]
  fn: (script: string, opts: { sessionId: string }) => Promise<IOResult>
} {
  const lines: string[] = []
  return {
    lines,
    fn: (script: string) => {
      lines.push(script)
      const code = exitCodes[lines.length - 1] ?? 0
      return Promise.resolve(
        new IOResult({ stdout: new TextEncoder().encode(`ran:${script}\n`), exitCode: code }),
      )
    },
  }
}

describe('handleEcho GNU option rules', () => {
  it('trailing -n prints literally', () => {
    const [out] = handleEcho(['hi', '-n'])
    expect(decode(out as Uint8Array)).toBe('hi -n\n')
  })

  it('unknown char makes the word literal', () => {
    const [out] = handleEcho(['-nq', 'hi'])
    expect(decode(out as Uint8Array)).toBe('-nq hi\n')
  })

  it('cluster -ne applies both', () => {
    const [out] = handleEcho(['-ne', 'a\\tb'])
    expect(decode(out as Uint8Array)).toBe('a\tb')
  })

  it('last of -e/-E wins', () => {
    const [a] = handleEcho(['-eE', 'a\\tb'])
    expect(decode(a as Uint8Array)).toBe('a\\tb\n')
    const [b] = handleEcho(['-Ee', 'a\\tb'])
    expect(decode(b as Uint8Array)).toBe('a\tb\n')
  })
})

describe('handleShift / handleReturn argument checks', () => {
  it('shift with a non-numeric arg errors like bash', async () => {
    const [, io] = handleShift(['x'], null, new Session({ sessionId: 'test' }))
    expect(io.exitCode).toBe(1)
    expect(decode(await materialize(io.stderr))).toBe('shift: x: numeric argument required\n')
  })

  it('shift with two args errors', async () => {
    const [, io] = handleShift(['1', '2'], null, new Session({ sessionId: 'test' }))
    expect(io.exitCode).toBe(1)
    expect(decode(await materialize(io.stderr))).toBe('shift: too many arguments\n')
  })

  it('return with a non-numeric arg raises 2 with a message', () => {
    try {
      handleReturn(['x'])
      expect.unreachable()
    } catch (err) {
      if (!(err instanceof ReturnSignal)) throw err
      expect(err.exitCode).toBe(2)
      expect(decode(err.stderr)).toBe('return: x: numeric argument required\n')
    }
  })
})

describe('handleRead options', () => {
  it('-r is consumed, not a variable', async () => {
    const s = new Session({ sessionId: 'test' })
    const stdin = new TextEncoder().encode('hello world\n')
    const [, io] = await handleRead(['-r', 'v'], s, stdin)
    expect(io.exitCode).toBe(0)
    expect(s.env.v).toBe('hello world')
    expect('-r' in s.env).toBe(false)
  })

  it('unknown option errors like bash', async () => {
    const s = new Session({ sessionId: 'test' })
    const [, io] = await handleRead(['-q', 'v'], s, new TextEncoder().encode('x\n'))
    expect(io.exitCode).toBe(2)
    expect(decode(await materialize(io.stderr))).toBe('read: -q: invalid option\n')
  })

  it('defaults to REPLY', async () => {
    const s = new Session({ sessionId: 'test' })
    await handleRead([], s, new TextEncoder().encode('hi\n'))
    expect(s.env.REPLY).toBe('hi')
  })
})

describe('handleXargs', () => {
  const session = new Session({ sessionId: 'test' })

  it('-n1 batches one arg per run', async () => {
    const shell = fakeShell()
    const [, io] = await handleXargs(shell.fn, ['-n1', 'echo'], session, aBC())
    expect(shell.lines).toEqual(['echo a', 'echo b', 'echo c'])
    expect(io.exitCode).toBe(0)
  })

  it('failing invocation exits 123 but continues', async () => {
    const shell = fakeShell([1, 0])
    const [, io] = await handleXargs(shell.fn, ['-n1', 'wc'], session, ab())
    expect(shell.lines).toEqual(['wc a', 'wc b'])
    expect(io.exitCode).toBe(123)
  })

  it('command-not-found stops with 127', async () => {
    const shell = fakeShell([127, 0])
    const [, io] = await handleXargs(shell.fn, ['-n1', 'nope'], session, ab())
    expect(shell.lines).toEqual(['nope a'])
    expect(io.exitCode).toBe(127)
  })

  it('-r skips the run on empty input', async () => {
    const shell = fakeShell()
    const [, io] = await handleXargs(shell.fn, ['-r', 'echo', 'hi'], session, new Uint8Array())
    expect(shell.lines).toEqual([])
    expect(io.exitCode).toBe(0)
  })

  it('-0 splits on NUL', async () => {
    const shell = fakeShell()
    await handleXargs(shell.fn, ['-0', 'echo'], session, new TextEncoder().encode('a b\0c\0'))
    expect(shell.lines).toEqual(["echo 'a b' c"])
  })

  it('-d splits on the delimiter', async () => {
    const shell = fakeShell()
    await handleXargs(shell.fn, ['-d,', 'echo'], session, new TextEncoder().encode('a,b,c'))
    expect(shell.lines).toEqual(['echo a b c'])
  })

  it('invalid option exits 1 without running', async () => {
    const shell = fakeShell()
    const [, io] = await handleXargs(shell.fn, ['-q', 'echo'], session, ab())
    expect(io.exitCode).toBe(1)
    expect(decode(await materialize(io.stderr))).toBe("xargs: invalid option -- 'q'\n")
    expect(shell.lines).toEqual([])
  })

  it('-n0 is rejected', async () => {
    const shell = fakeShell()
    const [, io] = await handleXargs(shell.fn, ['-n0', 'echo'], session, ab())
    expect(io.exitCode).toBe(1)
    expect(decode(await materialize(io.stderr))).toBe(
      'xargs: value 0 for -n option should be >= 1\n',
    )
  })
})

describe('handleTimeout', () => {
  const session = new Session({ sessionId: 'test' })

  it('parses duration units', () => {
    expect(parseDuration('1')).toBe(1)
    expect(parseDuration('0.5')).toBe(0.5)
    expect(parseDuration('2s')).toBe(2)
    expect(parseDuration('2m')).toBe(120)
    expect(parseDuration('1h')).toBe(3600)
    expect(parseDuration('1d')).toBe(86400)
    expect(parseDuration('.5')).toBe(0.5)
  })

  it('rejects garbage durations', () => {
    expect(parseDuration('xx')).toBeNull()
    expect(parseDuration('-1')).toBeNull()
    expect(parseDuration('1x')).toBeNull()
    expect(parseDuration('')).toBeNull()
  })

  it('passes through when the command finishes in time', async () => {
    const shell = fakeShell([3])
    const [stdout, io] = await handleTimeout(shell.fn, ['5', 'wc', '-l'], session)
    expect(shell.lines).toEqual(['wc -l'])
    expect(io.exitCode).toBe(3)
    expect(decode(stdout as Uint8Array)).toBe('ran:wc -l\n')
  })

  it('exits 124 on overrun', async () => {
    const slow = (): Promise<IOResult> =>
      new Promise((resolve) =>
        setTimeout(() => {
          resolve(new IOResult())
        }, 1000),
      )
    const [, io] = await handleTimeout(slow, ['0.05', 'sleep', '1'], session)
    expect(io.exitCode).toBe(124)
  })

  it('invalid duration exits 125', async () => {
    const shell = fakeShell()
    const [, io] = await handleTimeout(shell.fn, ['xx', 'sleep', '1'], session)
    expect(io.exitCode).toBe(125)
    expect(decode(await materialize(io.stderr))).toBe("timeout: invalid time interval 'xx'\n")
    expect(shell.lines).toEqual([])
  })

  it('missing operand exits 125', async () => {
    const shell = fakeShell()
    const [, io] = await handleTimeout(shell.fn, ['5'], session)
    expect(io.exitCode).toBe(125)
    expect(decode(await materialize(io.stderr))).toBe('timeout: missing operand\n')
  })

  it('signal option is rejected', async () => {
    const shell = fakeShell()
    const [, io] = await handleTimeout(shell.fn, ['-s', 'KILL', '1', 'sleep', '3'], session)
    expect(io.exitCode).toBe(125)
    expect(decode(await materialize(io.stderr))).toBe("timeout: unsupported option -- '-s'\n")
  })
})

function aBC(): Uint8Array {
  return new TextEncoder().encode('a b c')
}

function ab(): Uint8Array {
  return new TextEncoder().encode('a b')
}
