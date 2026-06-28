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
import { Session } from '../session/session.ts'
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
  handleTrap,
  handleUnset,
  handleWhoami,
} from './builtins/index.ts'
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
  it('echoes USER + newline, exit 0, no stderr', () => {
    const s = new Session({ sessionId: 'test', env: { USER: 'alice' } })
    const [out, io] = handleWhoami(s)
    expect(decode(out as Uint8Array)).toBe('alice\n')
    expect(io.exitCode).toBe(0)
    expect(io.stderr).toBeNull()
  })

  it('exits 1 with stderr when USER unset', () => {
    const s = new Session({ sessionId: 'test' })
    const [out, io] = handleWhoami(s)
    expect(out).toBeNull()
    expect(io.exitCode).toBe(1)
    expect(decode(io.stderr instanceof Uint8Array ? io.stderr : null)).toBe(
      'whoami: USER not set\n',
    )
  })

  it('echoes empty string when USER explicitly empty', () => {
    const s = new Session({ sessionId: 'test', env: { USER: '' } })
    const [out, io] = handleWhoami(s)
    expect(decode(out as Uint8Array)).toBe('\n')
    expect(io.exitCode).toBe(0)
  })
})

describe('handleEcho', () => {
  it('joins args with space and appends newline', () => {
    const [out] = handleEcho(['hi', 'there'])
    expect(decode(out as Uint8Array)).toBe('hi there\n')
  })

  it('-n suppresses trailing newline', () => {
    const [out] = handleEcho(['hi'], true, false)
    expect(decode(out as Uint8Array)).toBe('hi')
  })

  it('-e interprets backslash escapes', () => {
    const [out] = handleEcho(['hello\\nworld'], false, true)
    expect(decode(out as Uint8Array)).toBe('hello\nworld\n')
  })

  it('-e \\t becomes tab', () => {
    const [out] = handleEcho(['a\\tb'], false, true)
    expect(decode(out as Uint8Array)).toBe('a\tb\n')
  })

  it('-e unknown escape passes through literally', () => {
    const [out] = handleEcho(['\\z'], false, true)
    expect(decode(out as Uint8Array)).toBe('\\z\n')
  })

  it('-e \\c stops output at that point', () => {
    const [out] = handleEcho(['hi\\cgone'], false, true)
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
})

describe('handleShift', () => {
  it('shifts call-stack positional args', () => {
    const cs = new CallStack()
    cs.push(['a', 'b', 'c', 'd'])
    handleShift(2, cs, null)
    expect(cs.getAllPositional()).toEqual(['c', 'd'])
  })

  it('shifts session.positionalArgs when call stack empty', () => {
    const cs = new CallStack()
    const s = new Session({ sessionId: 'test', positionalArgs: ['x', 'y', 'z'] })
    handleShift(1, cs, s)
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
    expect(() => handleReturn(42)).toThrow(ReturnSignal)
    try {
      handleReturn(42)
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
