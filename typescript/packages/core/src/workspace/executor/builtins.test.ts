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

import { EvaluationContext } from '../evaluation.ts'
import { helpPage, versionLine } from '../../commands/spec/standard.ts'
import { HELP as PRINTF_HELP } from './builtins/printf/printf.ts'
import type { ExecuteStringFn } from './builtins/types.ts'
import { specOf } from '../../commands/spec/index.ts'
import { renderHelp } from '../../commands/spec/help.ts'
import { makeVar } from '../../shell/variable.ts'
import { envSnapshot, seedVar, sessionView, setAttr } from '../../workspace/session/state.ts'
import { VarAttr } from '../../shell/variable.ts'
import { varsFromEnv } from '../../workspace/session/session.ts'
import { describe, expect, it, vi } from 'vitest'
import { CLISpec } from '../../commands/cli/types.ts'
import { GENERAL_COMMANDS } from '../../commands/builtin/general/index.ts'
import { share } from '../../io/async_line_iterator.ts'
import { IOResult, materialize } from '../../io/types.ts'
import type { ByteSource } from '../../io/types.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { enoent } from '../../errors/fs.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { byteChar } from '../../shell/bytes.ts'
import { CallStack } from '../../shell/call_stack.ts'
import { ContentType, FileStat, FileType, MountMode } from '../../types.ts'
import { MountRegistry } from '../mount/registry.ts'
import type { MountEntry } from '../mount/mount.ts'
import { Namespace } from '../mount/namespace/namespace.ts'
import { SessionState } from '../session/session.ts'
import { ParseScope } from '../../shell/parse/scope.ts'
import { getTestParser } from '../fixtures/workspace_fixture.ts'
import type { ResolveFn } from '../dispatcher/index.ts'
import type { DispatchFn } from '../../runtime/types.ts'
import {
  handleCd,
  handleEcho,
  handleEval,
  handleExport,
  handleLocal,
  handleReadonly,
  handleMan,
  handlePrintenv,
  handlePrintf,
  handleGetopts,
  handleRead,
  handleReturn,
  handleSet,
  handleShift,
  handleSleep,
  handleSource,
  handleTest,
  handleTimeout,
  handleUnset,
  handleWhoami,
  handleXargs,
} from './builtins/index.ts'
import { parseDuration, parseSignal, signalName } from './builtins/timeout/timeout.ts'
import { ExitSignal, ReturnSignal } from '../../shell/errors.ts'

function wireMount(mount: MountEntry): void {
  for (const cmd of mount.vfs.commands()) {
    if (cmd.filetype !== null) mount.register(cmd)
    else if (cmd.vfs === null) mount.registerGeneral(cmd)
    else mount.register(cmd)
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

const MAN_SESSION = new SessionState({ sessionId: 'man' })

describe('handleExport / handleUnset / handlePrintenv', () => {
  it('export KEY=VAL sets session env', async () => {
    const s = new SessionState({ sessionId: 'test' })
    await handleExport(['FOO=bar', 'BAZ=qux'], s, sessionView(s))
    expect(s.env.FOO).toBe('bar')
    expect(s.env.BAZ).toBe('qux')
  })

  it('export KEY (no =) marks it without giving it a value', async () => {
    // bash's third state: declared and exported but *unset*. GNU prints
    // `declare -x Y` with no `=`, and `env` does not carry it at all, so
    // the empty string this used to write was a divergence.
    const s = new SessionState({ sessionId: 'test', vars: varsFromEnv({ X: 'existing' }) })
    await handleExport(['X', 'Y'], s, sessionView(s))
    expect(s.env.X).toBe('existing')
    expect(s.env.Y).toBeUndefined()
    expect(s.vars.Y?.attrs.has(VarAttr.Export)).toBe(true)
    expect(s.vars.Y?.value).toBeNull()
  })

  it('export -p prints declare -x lines', async () => {
    const s = new SessionState({ sessionId: 'test', vars: varsFromEnv({ ZZZ: '1', AAA: 'a"b' }) })
    const [out, io] = await handleExport(['-p'], s)
    expect(io.exitCode).toBe(0)
    const text = decode(out as Uint8Array)
    expect(text).toContain('declare -x AAA="a\\"b"\n')
    expect(text).toContain('declare -x ZZZ="1"\n')
    expect(text.indexOf('AAA')).toBeLessThan(text.indexOf('ZZZ'))
  })

  it('export -f marks, lists and refuses functions', async () => {
    const s = new SessionState({
      sessionId: 'test',
      functions: { f: 'f() { :; }', g: 'g() { :; }' },
    })
    let [, io] = await handleExport(['-f', 'f', 'nosuch', 'x=1'], s)
    expect(io.exitCode).toBe(1)
    expect(decode(io.stderr as Uint8Array)).toBe(
      'bash: export: nosuch: not a function\nbash: export: x=1: not a function\n',
    )
    expect(s.exportedFunctions).toEqual(new Set(['f']))
    expect('f' in s.vars || 'x' in s.vars).toBe(false)
    const [out] = await handleExport(['-f'], s, null, null, new ParseScope(await getTestParser()))
    expect(decode(out as Uint8Array)).toBe('f () \n{ \n    :\n}\ndeclare -fx f\n')
    ;[, io] = await handleExport(['-nf', 'f'], s)
    expect(io.exitCode).toBe(0)
    expect(s.exportedFunctions).toEqual(new Set())
  })

  it('bare export prints like -p', async () => {
    const s = new SessionState({ sessionId: 'test', vars: varsFromEnv({ FOO: 'bar' }) })
    const [out, io] = await handleExport([], s)
    expect(io.exitCode).toBe(0)
    // $PWD is exported like any other variable, so bash lists it here too.
    expect(decode(out as Uint8Array)).toBe('declare -x FOO="bar"\ndeclare -x PWD="/"\n')
  })

  it('export -z is invalid option exit 2', async () => {
    const s = new SessionState({ sessionId: 'test' })
    const [, io] = await handleExport(['-z'], s)
    expect(io.exitCode).toBe(2)
    expect(decode(io.stderr as Uint8Array)).toContain('invalid option')
    expect(decode(io.stderr as Uint8Array)).toContain('usage: export')
  })

  it('export write without a threaded view is a wiring bug', async () => {
    // The old fallback built an ungated view here, so `export
    // AWS_SECRET_ACCESS_KEY=x` cleared every preSession rule.
    const s = new SessionState({ sessionId: 'test' })
    await expect(handleExport(['SECRET=x'], s)).rejects.toThrow(/gated session view/)
  })

  it('export -p with a name does not print', async () => {
    const s = new SessionState({ sessionId: 'test', vars: varsFromEnv({ KEEP: '1' }) })
    const [out, io] = await handleExport(['-p', 'FOO=bar'], s, sessionView(s))
    expect(io.exitCode).toBe(0)
    expect(out).toBeNull()
    expect(s.env.FOO).toBe('bar')
  })

  it('readonly -p prints scalars and arrays', async () => {
    const s = new SessionState({ sessionId: 'test', vars: varsFromEnv({ VAL: 'x' }) })
    setAttr(s, 'VAL', VarAttr.Readonly)
    setAttr(s, 'ONLY', VarAttr.Readonly)
    seedVar(s, 'AR', ['a', 'b c'])
    setAttr(s, 'AR', VarAttr.Readonly)
    const [out, io] = await handleReadonly(['-p'], s)
    expect(io.exitCode).toBe(0)
    const text = decode(out as Uint8Array)
    expect(text).toContain('declare -ar AR=([0]="a" [1]="b c")\n')
    expect(text).toContain('declare -r ONLY\n')
    expect(text).toContain('declare -r VAL="x"\n')
  })

  it('readonly -z is invalid option exit 2', async () => {
    const s = new SessionState({ sessionId: 'test' })
    const [, io] = await handleReadonly(['-z'], s)
    expect(io.exitCode).toBe(2)
    expect(decode(io.stderr as Uint8Array)).toContain('invalid option')
  })

  it('export -p quotes control characters like bash', async () => {
    const s = new SessionState({
      sessionId: 'test',
      vars: varsFromEnv({
        TAB: 'a\tb',
        ESC: 'a\x1bb',
        BEL: 'a\x07b',
        SOH: 'a\x01b',
        DEL: 'a\x7fb',
        UTF: 'café',
      }),
    })
    const [out, io] = await handleExport(['-p'], s)
    expect(io.exitCode).toBe(0)
    const text = decode(out as Uint8Array)
    // GNU bash uses $'...' for any control character, named escapes where it
    // has one and three-digit octal otherwise.
    expect(text).toContain("declare -x TAB=$'a\\tb'\n")
    expect(text).toContain("declare -x ESC=$'a\\Eb'\n")
    expect(text).toContain("declare -x BEL=$'a\\ab'\n")
    expect(text).toContain("declare -x SOH=$'a\\001b'\n")
    expect(text).toContain("declare -x DEL=$'a\\177b'\n")
    // Printable non-ASCII stays literal, as bash does in a UTF-8 locale.
    expect(text).toContain('declare -x UTF="café"\n')
  })

  it('export -p -- still prints', async () => {
    const s = new SessionState({ sessionId: 'test', vars: varsFromEnv({ FOO: 'bar' }) })
    const [out, io] = await handleExport(['-p', '--'], s)
    expect(io.exitCode).toBe(0)
    expect(decode(out as Uint8Array)).toBe('declare -x FOO="bar"\ndeclare -x PWD="/"\n')
  })

  it('export -f lists no variables', async () => {
    const s = new SessionState({ sessionId: 'test', vars: varsFromEnv({ FOO: 'bar' }) })
    const [out, io] = await handleExport(['-f'], s)
    expect(io.exitCode).toBe(0)
    expect(decode(out as Uint8Array)).toBe('')
  })

  it('export reports the first invalid option letter', async () => {
    const s = new SessionState({ sessionId: 'test' })
    const [, io] = await handleExport(['-zq'], s)
    expect(decode(io.stderr as Uint8Array)).toContain('export: -z: invalid option')
    expect(decode(io.stderr as Uint8Array)).not.toContain('-q: invalid option')
  })

  it('readonly -a lists arrays only', async () => {
    const s = new SessionState({ sessionId: 'test', vars: varsFromEnv({ VAL: 'x' }) })
    setAttr(s, 'VAL', VarAttr.Readonly)
    seedVar(s, 'AR', ['a'])
    setAttr(s, 'AR', VarAttr.Readonly)
    const [out, io] = await handleReadonly(['-a'], s)
    expect(io.exitCode).toBe(0)
    expect(decode(out as Uint8Array)).toBe('declare -ar AR=([0]="a")\n')
  })

  it('readonly -f and -A list nothing', async () => {
    const s = new SessionState({ sessionId: 'test', vars: varsFromEnv({ VAL: 'x' }) })
    setAttr(s, 'VAL', VarAttr.Readonly)
    for (const flag of ['-f', '-A']) {
      const [out, io] = await handleReadonly([flag], s)
      expect(io.exitCode).toBe(0)
      expect(decode(out as Uint8Array)).toBe('')
    }
  })

  it('unset removes keys', async () => {
    const s = new SessionState({ sessionId: 'test', vars: varsFromEnv({ A: '1', B: '2' }) })
    await handleUnset(['A'], s, sessionView(s))
    expect('A' in s.env).toBe(false)
    expect(s.env.B).toBe('2')
  })

  it('unset -f removes a function but not a same-named variable', async () => {
    const s = new SessionState({ sessionId: 'test', vars: varsFromEnv({ fn: 'v' }) })
    s.functions.fn = 'fn() { :; }'
    s.functionSites.set('fn', { source: 'fn() { :; }', mark: [1, 0], origin: null })
    s.exportedFunctions.add('fn')
    await handleUnset(['-f', 'fn'], s, sessionView(s))
    expect('fn' in s.functions).toBe(false)
    expect(s.functionSites.has('fn')).toBe(false)
    expect(s.exportedFunctions.has('fn')).toBe(false)
    expect(s.env.fn).toBe('v')
  })

  it('unset -v removes a variable but not a same-named function', async () => {
    const s = new SessionState({ sessionId: 'test', vars: varsFromEnv({ fn: 'v' }) })
    s.functions.fn = 'fn() { :; }'
    await handleUnset(['-v', 'fn'], s, sessionView(s))
    expect('fn' in s.functions).toBe(true)
    expect('fn' in s.env).toBe(false)
  })

  it('unset bare prefers a variable, else the function', async () => {
    const s = new SessionState({ sessionId: 'test', vars: varsFromEnv({ a: 'v' }) })
    s.functions.a = 'a() { :; }'
    await handleUnset(['a'], s, sessionView(s))
    expect('a' in s.env).toBe(false)
    expect('a' in s.functions).toBe(true)
    s.functions.b = 'b() { :; }'
    s.functionSites.set('b', { source: 'b() { :; }', mark: [1, 0], origin: null })
    s.exportedFunctions.add('b')
    await handleUnset(['b'], s, sessionView(s))
    expect('b' in s.functions).toBe(false)
    expect(s.functionSites.has('b')).toBe(false)
    expect(s.exportedFunctions.has('b')).toBe(false)
  })

  it('unset removes a whole array and a single element', async () => {
    const s = new SessionState({ sessionId: 'test' })
    seedVar(s, 'arr', ['x', 'y', 'z'])
    // An interior element leaves a hole so later indices keep their
    // positions; a trailing one drops off, as bash does.
    await handleUnset(['arr[1]'], s, sessionView(s))
    expect(s.arrays.arr).toEqual(['x', null, 'z'])
    await handleUnset(['arr[2]'], s, sessionView(s))
    expect(s.arrays.arr).toEqual(['x'])
    await handleUnset(['arr'], s, sessionView(s))
    expect('arr' in s.arrays).toBe(false)
  })

  it('unset rejects an element of a readonly array', async () => {
    const s = new SessionState({ sessionId: 'test' })
    seedVar(s, 'arr', ['x', 'y'])
    setAttr(s, 'arr', VarAttr.Readonly)
    const [, io] = await handleUnset(['arr[1]'], s, sessionView(s))
    expect(io.exitCode).toBe(1)
    expect(decode(io.stderr as Uint8Array)).toBe(
      'bash: unset: arr: cannot unset: readonly variable\n',
    )
    expect(s.arrays.arr).toEqual(['x', 'y'])
  })

  it('unset NAME[0] removes a scalar, a non-zero subscript errors', async () => {
    const s = new SessionState({ sessionId: 'test', vars: varsFromEnv({ Y: 'sc', Z: 'sc' }) })
    const [, io] = await handleUnset(['Y[0]'], s, sessionView(s))
    expect(io.exitCode).toBe(0)
    expect('Y' in s.env).toBe(false)
    const [, io2] = await handleUnset(['Z[1]'], s, sessionView(s))
    expect(io2.exitCode).toBe(1)
    expect(decode(io2.stderr as Uint8Array)).toBe('bash: unset: Z: not an array variable\n')
    expect(s.env.Z).toBe('sc')
  })

  it('unset of a negative element outside the extent errors', async () => {
    const s = new SessionState({ sessionId: 'test' })
    seedVar(s, 'arr', ['x'])
    const [, io] = await handleUnset(['arr[-2]'], s, sessionView(s))
    expect(io.exitCode).toBe(1)
    // bash prints only the bracketed part here, not the base name.
    expect(decode(io.stderr as Uint8Array)).toBe('bash: unset: [-2]: bad array subscript\n')
    expect(s.arrays.arr).toEqual(['x'])
    seedVar(s, 'two', ['x', 'y'])
    const [, io2] = await handleUnset(['two[-2]'], s, sessionView(s))
    expect(io2.exitCode).toBe(0)
    expect(s.arrays.two).toEqual([null, 'y'])
  })

  it('unset of an element of an unset name is a no-op', async () => {
    const s = new SessionState({ sessionId: 'test' })
    const [, io] = await handleUnset(['GONE[3]'], s, sessionView(s))
    expect(io.exitCode).toBe(0)
  })

  it('unset -z is an invalid option (exit 2)', async () => {
    const s = new SessionState({ sessionId: 'test' })
    const [, io] = await handleUnset(['-z', 'x'], s, sessionView(s))
    expect(io.exitCode).toBe(2)
  })

  it('printenv VAR emits value + newline; exit 1 if missing', () => {
    const s = new SessionState({ sessionId: 'test', vars: varsFromEnv({ X: 'yes' }) })
    const [out, io] = handlePrintenv('X', s)
    expect(decode(out as Uint8Array)).toBe('yes\n')
    expect(io.exitCode).toBe(0)
    const [, io2] = handlePrintenv('MISSING', s)
    expect(io2.exitCode).toBe(1)
  })

  it('printenv with no name lists sorted KEY=VAL', () => {
    const s = new SessionState({ sessionId: 'test', vars: varsFromEnv({ B: '2', A: '1' }) })
    const [out] = handlePrintenv(null, s)
    expect(decode(out as Uint8Array)).toBe('A=1\nB=2\nPWD=/\n')
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

  it('-e \\c stops output at that point, newline included', () => {
    const [out] = handleEcho(['-e', 'hi\\cgone'])
    expect(decode(out as Uint8Array)).toBe('hi')
  })

  it('-e \\c ends the later operands too', () => {
    expect(decode(handleEcho(['-e', 'a', 'b\\cc', 'd'])[0] as Uint8Array)).toBe('a b')
    expect(decode(handleEcho(['-e', 'a\\E', '\\cb'])[0] as Uint8Array)).toBe('a\x1b ')
  })

  it('-e reads \\e and \\E as ESC; -E and plain echo keep them', () => {
    expect(decode(handleEcho(['-e', 'a\\eb\\Ec'])[0] as Uint8Array)).toBe('a\x1bb\x1bc\n')
    expect(decode(handleEcho(['-E', 'a\\eb\\Ec'])[0] as Uint8Array)).toBe('a\\eb\\Ec\n')
    expect(decode(handleEcho(['a\\eb\\Ec'])[0] as Uint8Array)).toBe('a\\eb\\Ec\n')
  })

  it('-e reads \\xHH and \\0NNN as bytes', () => {
    const bytes = (args: string[]): number[] => [...(handleEcho(args)[0] as Uint8Array)]
    expect(bytes(['-ne', '\\xff'])).toEqual([0xff])
    expect(bytes(['-ne', '\\0377'])).toEqual([0xff])
    expect(bytes(['-ne', '\\xc3\\xa9'])).toEqual([0xc3, 0xa9])
  })

  it('-e reads \\u and \\U as code points written in UTF-8', () => {
    const bytes = (args: string[]): number[] => [...(handleEcho(args)[0] as Uint8Array)]
    expect(bytes(['-ne', '\\u00e9\\U0001F600'])).toEqual([0xc3, 0xa9, 0xf0, 0x9f, 0x98, 0x80])
    expect(bytes(['-ne', '\\uD800'])).toEqual([0xed, 0xa0, 0x80])
  })
})

describe('handlePrintf', () => {
  const run = async (args: string[]): Promise<[string, number]> => {
    const [out, io] = await handlePrintf(args, new SessionState({ sessionId: 'test' }))
    return [decode(out as Uint8Array), io.exitCode]
  }
  const stdout = async (args: string[]): Promise<string> => {
    const [text, code] = await run(args)
    expect(code).toBe(0)
    return text
  }

  // Expectations verified byte-for-byte against GNU bash's builtin printf.
  const CASES: [string[], string, number][] = [
    [['%s\n', 'c', 'a', 'b'], 'c\na\nb\n', 0],
    [['%d\n', '1', '2', '3'], '1\n2\n3\n', 0],
    [['(%s,%s)', 'a', 'b', 'c'], '(a,b)(c,)', 0],
    [['hello\n', 'a', 'b', 'c'], 'hello\n', 0],
    [['%s=%d;', 'foo', '1', 'bar'], 'foo=1;bar=0;', 0],
    [['a%%b\n'], 'a%b\n', 0],
    [['[%s][%s]\n', 'x'], '[x][]\n', 0],
    [['[%d][%d]\n', '5'], '[5][0]\n', 0],
    [['[%-5s]', 'hi'], '[hi   ]', 0],
    [['[%5s]', 'hi'], '[   hi]', 0],
    [['[%.3s]', 'abcdef'], '[abc]', 0],
    [['[%05d]', '42'], '[00042]', 0],
    [['[%-05d]', '42'], '[42   ]', 0],
    [['[%.0d]', '0'], '[]', 0],
    [['[%+d]', '5'], '[+5]', 0],
    [['[% d]', '-5'], '[-5]', 0],
    [['[%o][%u][%x][%X]\n', '64', '64', '255', '255'], '[100][64][ff][FF]\n', 0],
    [['%x\n', '-1'], 'ffffffffffffffff\n', 0],
    [['%X\n', '-1'], 'FFFFFFFFFFFFFFFF\n', 0],
    [['%o\n', '-1'], '1777777777777777777777\n', 0],
    [['%u\n', '-1'], '18446744073709551615\n', 0],
    [['%#x\n', '255'], '0xff\n', 0],
    [['%#X\n', '255'], '0XFF\n', 0],
    [['%#o\n', '64'], '0100\n', 0],
    [['%#x\n', '0'], '0\n', 0],
    [['%#o\n', '0'], '0\n', 0],
    [['%08x\n', '255'], '000000ff\n', 0],
    [['%d\n', '0x1f'], '31\n', 0],
    [['%d\n', '010'], '8\n', 0],
    [['%d\n', '"A'], '65\n', 0],
    [['%d\n', "'Z"], '90\n', 0],
    [['[%c]\n', 'abc'], '[a]\n', 0],
    [['[%c%c]\n', 'xy', 'z'], '[xz]\n', 0],
    [['[%b]\n', 'a\\tb'], '[a\tb]\n', 0],
    [['[%b]\n', 'x\\101y'], '[xAy]\n', 0],
    [['[%b]', 'ab\\ccd'], '[ab', 0],
    [['[%*d]\n', '5', '42'], '[   42]\n', 0],
    [['[%.*f]\n', '2', '3.14159'], '[3.14]\n', 0],
    [['[%*.*f]\n', '10', '2', '3.14159'], '[      3.14]\n', 0],
    [['[%*d]\n', '-5', '42'], '[42   ]\n', 0],
    [['%.2f\n', '3.14159'], '3.14\n', 0],
    [['%.0f\n', '0.5'], '0\n', 0],
    [['%.0f\n', '1.5'], '2\n', 0],
    [['%.0f\n', '2.5'], '2\n', 0],
    [['%010.2f\n', '3.14'], '0000003.14\n', 0],
    [['%#.0f\n', '3'], '3.\n', 0],
    [['%g|%g|%g|%g\n', '1.', '.5', '1e2', '+1.25e-2'], '1|0.5|100|0.0125\n', 0],
    [['%g', `${'0'.repeat(20_000)}x`], '0', 1],
    [['%e\n', '0'], '0.000000e+00\n', 0],
    [['%.2e\n', '12345.678'], '1.23e+04\n', 0],
    [['%g\n', '100000'], '100000\n', 0],
    [['%g\n', '1000000'], '1e+06\n', 0],
    [['%g\n', '0.0001'], '0.0001\n', 0],
    [['%g\n', '0.00001'], '1e-05\n', 0],
    [['%#g\n', '1.5'], '1.50000\n', 0],
    [['x\\ty\\n'], 'x\ty\n', 0],
    [['\\101\\n'], 'A\n', 0],
    [['%d\n', 'abc'], '0\n', 1],
    [['%d\n', '3.9'], '3\n', 1],
  ]

  it.each(CASES)('printf %j → %j', async (args, expected, code) => {
    expect(await run(args)).toEqual([expected, code])
  })

  it('reads \\xHH and \\NNN as bytes, \\u as a code point', async () => {
    // bash writes \xff as the byte 0xFF, which is not valid UTF-8 at all,
    // rather than as the code point U+00FF.
    const bytes = async (args: string[]): Promise<number[]> => [
      ...(((await handlePrintf(args, new SessionState({ sessionId: 'test' })))[0] ??
        []) as Uint8Array),
    ]
    expect(await bytes(['\\xff'])).toEqual([0xff])
    expect(await bytes(['\\377'])).toEqual([0xff])
    expect(await bytes(['\\xc3\\xa9'])).toEqual([0xc3, 0xa9])
    expect(await bytes(['\\x41\\x42'])).toEqual([0x41, 0x42])
    expect(await bytes(['%b', '\\xff'])).toEqual([0xff])
    expect(await bytes(['\\u00e9'])).toEqual([0xc3, 0xa9])
  })

  it('quotes a raw byte as octal', async () => {
    expect(await stdout(['%q\n', byteChar(0xff)])).toBe("$'\\377'\n")
  })

  it('empty args is a usage error', async () => {
    const [out, io] = await handlePrintf([], new SessionState({ sessionId: 'test' }))
    expect([out, io.exitCode]).toEqual([null, 2])
    expect(decode(io.stderr as Uint8Array)).toBe(
      'printf: usage: printf [-v var] format [arguments]\n',
    )
  })

  // bash's `internal_getopt` takes single letters, so it reports the first
  // character it does not know spelled with ONE dash: a long spelling answers
  // for its second dash and its own text never reaches the message. Measured
  // on bash 5.2.21, where the coreutils binary of the same name is lenient
  // and prints the word; mirage ships the builtin. Mirrors test_printf.py.
  it.each([
    [['--zzz'], '--'],
    [['--zzz=x'], '--'],
    [['--hel'], '--'],
    [['--help=x'], '--'],
    [['--version'], '--'],
    [['-Q'], '-Q'],
  ])('refuses %j as an invalid option', async (args, bad) => {
    const [, io, node] = await handlePrintf(args, new SessionState({ sessionId: 'test' }))
    expect(io.exitCode).toBe(2)
    expect(decode(io.stderr as Uint8Array)).toBe(
      `bash: printf: ${bad}: invalid option\nprintf: usage: printf [-v var] format [arguments]\n`,
    )
    expect(node.exitCode).toBe(2)
  })

  // bash answers the EXACT word `--help` for every builtin ahead of
  // `internal_getopt`, writing the page to STDOUT and exiting 2, where `--hel`
  // and `--version` take the invalid-option path above (measured on bash
  // 5.2.37). Mirrors test_printf.py.
  it('prints the help page to stdout and exits 2', async () => {
    const [out, io, node] = await handlePrintf(['--help'], new SessionState({ sessionId: 'test' }))
    expect(io.exitCode).toBe(2)
    expect(io.stderr).toBeNull()
    expect(await readBody(out)).toBe(PRINTF_HELP)
    expect(node.exitCode).toBe(2)
  })

  // The page is the BUILTIN's, so it is bash's own text and not the
  // spec-rendered one every other command answers --help with: the
  // spec-rendered page cannot mention `-v`, which is the builtin's option
  // alone and so is absent from CommandSpec by design. The first line is
  // bash's synopsis, not GNU's `Usage:` line. Mirrors test_printf.py.
  it('answers with the bash builtin page, not the spec page', () => {
    expect(PRINTF_HELP.startsWith('printf: printf [-v var] format [arguments]\n')).toBe(true)
    expect(PRINTF_HELP).toContain('  -v var\tassign the output to shell variable VAR')
    expect(PRINTF_HELP).not.toBe(renderHelp('printf', specOf('printf')))
    expect(PRINTF_HELP.startsWith('printf\n\nUsage:')).toBe(false)
  })

  // Byte for byte bash 5.2.37's page, minus the two conversions mirage does
  // not implement. Keeping the check explicit means adding `%Q` or `%(fmt)T`
  // to the engine without adding it to the page fails here. Mirrors
  // test_printf.py.
  it('drops only the conversions mirage lacks', () => {
    expect(PRINTF_HELP).toContain('      %b\texpand backslash escape sequences')
    expect(PRINTF_HELP).toContain('      %q\tquote the argument in a way')
    expect(PRINTF_HELP).not.toContain('%Q')
    expect(PRINTF_HELP).not.toContain('%(fmt)T')
    expect(
      PRINTF_HELP.endsWith(
        '    Exit Status:\n' +
          '    Returns success unless an invalid option is given or a write or assignment\n' +
          '    error occurs.\n',
      ),
    ).toBe(true)
  })

  it('takes -- as the end of the options', async () => {
    expect(await stdout(['--', '--zzz'])).toBe('--zzz')
  })

  // `--` ends the options and the FORMAT is still required, so the line is
  // the usage error rather than an empty one.
  it('refuses a bare -- with the usage error', async () => {
    const [, io] = await handlePrintf(['--'], new SessionState({ sessionId: 'test' }))
    expect(io.exitCode).toBe(2)
    expect(decode(io.stderr as Uint8Array)).toBe(
      'printf: usage: printf [-v var] format [arguments]\n',
    )
  })

  // An option-shaped word in OPERAND position is a plain argument: bash stops
  // scanning at the first non-option word.
  it('keeps an option-shaped operand as an argument', async () => {
    expect(await stdout(['%s', '--zzz'])).toBe('--zzz')
  })

  it('reuses the format for excess args, drops excess when no conversion', async () => {
    expect(await stdout(['%s\n', 'c', 'a', 'b'])).toBe('c\na\nb\n')
    expect(await stdout(['hello\n', 'a', 'b', 'c'])).toBe('hello\n')
  })

  it('inf and nan', async () => {
    expect(await stdout(['%f|%e|%g\n', 'inf', 'inf', 'inf'])).toBe('inf|inf|inf\n')
    expect(await stdout(['%f\n', '-inf'])).toBe('-inf\n')
    expect(await stdout(['%F|%G\n', 'nan', 'nan'])).toBe('NAN|NAN\n')
  })

  it('%c of empty string is a NUL byte', async () => {
    expect(await stdout(['[%c]', ''])).toBe('[\x00]')
  })

  it('\\u / \\U unicode escapes', async () => {
    expect(await stdout(['\\u00e9\n'])).toBe('é\n')
    expect(await stdout(['\\U0001F600'])).toBe('😀')
  })

  it('%q shell-quoting', async () => {
    expect(await stdout(['%q\n', 'a b'])).toBe('a\\ b\n')
    expect(await stdout(['%q\n', ''])).toBe("''\n")
    expect(await stdout(['%q\n', "it's"])).toBe("it\\'s\n")
    expect(await stdout(['%q\n', 'ümlaut'])).toBe("$'\\303\\274mlaut'\n")
    expect(await stdout(['%q\n', 'tab\ttab'])).toBe("$'tab\\ttab'\n")
  })

  it('%a at IEEE double precision (differs from bash long double)', async () => {
    expect(await stdout(['%a\n', '1.0'])).toBe('0x1p+0\n')
    expect(await stdout(['%a\n', '0.5'])).toBe('0x1p-1\n')
    expect(await stdout(['%a\n', '3.14'])).toBe('0x1.91eb851eb851fp+1\n')
    expect(await stdout(['%A\n', '255.5'])).toBe('0X1.FFP+7\n')
  })

  it('-v assigns to a variable and prints nothing', async () => {
    const s = new SessionState({ sessionId: 'test' })
    const [out, io] = await handlePrintf(['-v', 'V', 'x=%d', '42'], s)
    expect(out).toBeNull()
    expect(io.exitCode).toBe(0)
    expect(s.env.V).toBe('x=42')
  })

  it('-v targets an array element', async () => {
    const s = new SessionState({ sessionId: 'test' })
    const [, io] = await handlePrintf(['-v', 'arr[2]', 'hi'], s)
    expect(io.exitCode).toBe(0)
    // Indices 0 and 1 are holes, not empty elements.
    expect(s.arrays.arr).toEqual([null, null, 'hi'])
  })

  it('-v with an invalid name errors before the format runs', async () => {
    const s = new SessionState({ sessionId: 'test' })
    const [, io] = await handlePrintf(['-v', '1bad', 'x'], s)
    expect(io.exitCode).toBe(2)
    expect(decode(io.stderr as Uint8Array)).toBe("bash: printf: `1bad': not a valid identifier\n")
    const [, io2] = await handlePrintf(['-v', '1bad', '%d', 'nope'], s)
    expect(io2.exitCode).toBe(2)
    expect(decode(io2.stderr as Uint8Array)).toBe("bash: printf: `1bad': not a valid identifier\n")
  })

  it('-v rejects an empty subscript but allows a blank one', async () => {
    const s = new SessionState({ sessionId: 'test' })
    const [, io] = await handlePrintf(['-v', 'a[]', 'x'], s)
    expect(io.exitCode).toBe(2)
    expect(decode(io.stderr as Uint8Array)).toBe("bash: printf: `a[]': not a valid identifier\n")
    expect('a' in s.arrays).toBe(false)
    // `a[ ]` is a valid arithmetic 0, not an empty subscript.
    const [, io2] = await handlePrintf(['-v', 'a[ ]', 'x'], s)
    expect(io2.exitCode).toBe(0)
    expect(s.arrays.a).toEqual(['x'])
  })

  it('-v refuses a readonly scalar and a readonly array element', async () => {
    const s = new SessionState({ sessionId: 'test', vars: varsFromEnv({ R: 'orig' }) })
    setAttr(s, 'R', VarAttr.Readonly)
    const [, io] = await handlePrintf(['-v', 'R', 'new'], s)
    expect(io.exitCode).toBe(1)
    expect(decode(io.stderr as Uint8Array)).toBe('bash: R: readonly variable\n')
    expect(s.env.R).toBe('orig')
    seedVar(s, 'A', ['x', 'y'])
    setAttr(s, 'A', VarAttr.Readonly)
    const [, io2] = await handlePrintf(['-v', 'A[0]', '%d', 'nope'], s)
    expect(io2.exitCode).toBe(1)
    expect(decode(io2.stderr as Uint8Array)).toBe(
      'bash: printf: nope: invalid number\nbash: A: readonly variable\n',
    )
    expect(s.arrays.A).toEqual(['x', 'y'])
  })

  it('-v on a bare name keeps the other elements of an existing array', async () => {
    const s = new SessionState({ sessionId: 'test' })
    seedVar(s, 'B', ['p', 'q', 'r'])
    const [, io] = await handlePrintf(['-v', 'B', 'Q'], s)
    expect(io.exitCode).toBe(0)
    expect(s.arrays.B).toEqual(['Q', 'q', 'r'])
    expect('B' in s.env).toBe(false)
  })

  it('-v with an out-of-range subscript keeps the scalar', async () => {
    const s = new SessionState({ sessionId: 'test', vars: varsFromEnv({ V: 'orig' }) })
    const [, io] = await handlePrintf(['-v', 'V[-2]', 'hi'], s)
    expect(io.exitCode).toBe(1)
    expect(decode(io.stderr as Uint8Array)).toBe('bash: V[-2]: bad array subscript\n')
    expect(s.env.V).toBe('orig')
    expect('V' in s.arrays).toBe(false)
  })

  it('-v with a negative subscript wraps over the scalar', async () => {
    const s = new SessionState({ sessionId: 'test', vars: varsFromEnv({ W: 'orig' }) })
    const [, io] = await handlePrintf(['-v', 'W[-1]', 'hi'], s)
    expect(io.exitCode).toBe(0)
    expect(s.arrays.W).toEqual(['hi'])
    expect('W' in s.env).toBe(false)
  })

  it('-v on __proto__ makes a real variable instead of touching the prototype', async () => {
    const s = new SessionState({ sessionId: 'test' })
    expect((await handlePrintf(['-v', '__proto__[0]', 'hi'], s))[1].exitCode).toBe(0)
    expect(Object.hasOwn(s.arrays, '__proto__')).toBe(true)
    // Session records are null-prototype (ownRecord), so there is no
    // prototype to corrupt in the first place.
    expect(Object.getPrototypeOf(s.arrays)).toBe(null)
    expect(({} as Record<string, unknown>)[0]).toBeUndefined()
  })

  it('-v keeps exit 1 on a bad number but still assigns', async () => {
    const s = new SessionState({ sessionId: 'test' })
    const [, io] = await handlePrintf(['-v', 'V', '%d', 'notanum'], s)
    expect(io.exitCode).toBe(1)
    expect(s.env.V).toBe('0')
  })

  // bash 5.2.37: an escape missing its digits writes builtin_error's
  // warning to stderr and leaves the status alone. Mirrors test_printf.py.
  it('warns for an escape missing its digits and exits 0', async () => {
    const [out, io, node] = await handlePrintf(['\\x|'], new SessionState({ sessionId: 'test' }))
    expect(decode(out as Uint8Array)).toBe('\\x|')
    expect(io.exitCode).toBe(0)
    expect(decode(io.stderr as Uint8Array)).toBe('bash: printf: missing hex digit for \\x\n')
    expect(node.exitCode).toBe(0)
    expect(decode(node.stderr)).toBe('bash: printf: missing hex digit for \\x\n')
  })

  it('-v warns for an escape missing its digits and still assigns', async () => {
    const s = new SessionState({ sessionId: 'test' })
    const [out, io] = await handlePrintf(['-v', 'V', '%b', '\\U'], s)
    expect(out).toBeNull()
    expect(io.exitCode).toBe(0)
    expect(decode(io.stderr as Uint8Array)).toBe('bash: printf: missing unicode digit for \\U\n')
    expect(s.env.V).toBe('\\U')
  })

  it('-v on a readonly name writes the warning before the refusal', async () => {
    const s = new SessionState({ sessionId: 'test', vars: varsFromEnv({ R: 'orig' }) })
    setAttr(s, 'R', VarAttr.Readonly)
    const [, io] = await handlePrintf(['-v', 'R', '\\x'], s)
    expect(io.exitCode).toBe(1)
    expect(decode(io.stderr as Uint8Array)).toBe(
      'bash: printf: missing hex digit for \\x\nbash: R: readonly variable\n',
    )
    expect(s.env.R).toBe('orig')
  })

  // bash 5.2.37: %b's \c returns before an invalid number reaches the
  // status, with or without -v; a readonly -v target still fails.
  // Mirrors test_printf.py.
  it('exits 0 when %b stops after an invalid number', async () => {
    const [out, io, node] = await handlePrintf(
      ['%d%b', 'abc', '\\c'],
      new SessionState({ sessionId: 'test' }),
    )
    expect(decode(out as Uint8Array)).toBe('0')
    expect(io.exitCode).toBe(0)
    expect(decode(io.stderr as Uint8Array)).toBe('bash: printf: abc: invalid number\n')
    expect(node.exitCode).toBe(0)
  })

  it('-v exits 0 when %b stops after an invalid number and still assigns', async () => {
    const s = new SessionState({ sessionId: 'test' })
    const [out, io] = await handlePrintf(['-v', 'V', '%d%b', 'abc', 'x', 'def', '\\c'], s)
    expect(out).toBeNull()
    expect(io.exitCode).toBe(0)
    expect(decode(io.stderr as Uint8Array)).toBe(
      'bash: printf: abc: invalid number\nbash: printf: def: invalid number\n',
    )
    expect(s.env.V).toBe('0x0')
  })

  it('-v on a readonly name still fails after %b stops', async () => {
    const s = new SessionState({ sessionId: 'test', vars: varsFromEnv({ R: 'orig' }) })
    setAttr(s, 'R', VarAttr.Readonly)
    const [, io] = await handlePrintf(['-v', 'R', '%d%b', 'abc', '\\c'], s)
    expect(io.exitCode).toBe(1)
    expect(decode(io.stderr as Uint8Array)).toBe(
      'bash: printf: abc: invalid number\nbash: R: readonly variable\n',
    )
    expect(s.env.R).toBe('orig')
  })
})

describe('handleSleep', () => {
  it('rejects invalid seconds', async () => {
    const [, io] = await handleSleep(['abc'])
    expect(io.exitCode).toBe(1)
    expect(decode(io.stderr as Uint8Array)).toBe(
      "sleep: invalid time interval 'abc'\nTry 'sleep --help' for more information.\n",
    )
  })

  // Measured on coreutils 9.4: the missing operand is the same
  // `usage (EXIT_FAILURE)` refusal the invalid interval is, so it carries the
  // same Try-help line.
  it('rejects missing operand', async () => {
    const [, io] = await handleSleep([])
    expect(io.exitCode).toBe(1)
    expect(decode(io.stderr as Uint8Array)).toBe(
      "sleep: missing operand\nTry 'sleep --help' for more information.\n",
    )
  })

  // sleep declares no options and reads the line through a real getopt_long
  // loop, so a dash word it does not know is the option refusal and never the
  // interval one, wherever it sits (measured on 9.4: `sleep --zzz 0` and
  // `sleep 0 --zzz` both report the option). Mirrors test_sleep.py.
  it.each([[['--zzz']], [['--zzz', '0']], [['0', '--zzz']]])(
    'refuses %j as an unrecognized option',
    async (args) => {
      const [, io, node] = await handleSleep(args)
      expect(io.exitCode).toBe(1)
      expect(decode(io.stderr as Uint8Array)).toBe(
        "sleep: unrecognized option '--zzz'\nTry 'sleep --help' for more information.\n",
      )
      expect(node.exitCode).toBe(1)
    },
  )

  // sleep's only options are gnulib's two standard ones, and they go through a
  // real getopt_long loop: measured on 9.7, `--help`, `--h`, `--version` and
  // `--v` all print to stdout and exit 0, wherever on the line they sit, and
  // the first dash word decides (`sleep --help --zzz` is help,
  // `sleep --zzz --help` is the refusal). Mirrors test_sleep.py.
  it.each([[['--help']], [['--h']], [['--hel']], [['0', '--help']], [['--help', '--zzz']]])(
    'answers %j with the help page on stdout',
    async (args) => {
      const [out, io, node] = await handleSleep(args)
      expect(io.exitCode).toBe(0)
      expect(io.stderr).toBeNull()
      expect(await readBody(out)).toBe(helpPage('sleep', specOf('sleep')))
      expect(node.exitCode).toBe(0)
    },
  )

  // The page has to document the grammar this arm implements, which the
  // declared spec alone cannot: sleep is a shell builtin, so nothing injects
  // the two standard options into specOf('sleep'), and rendering that spec
  // produced a page naming neither of the options it was answering. Asserted
  // on the CONTENT rather than against the renderer, because the version that
  // asserted renderHelp(spec) was true of the page whatever the page said.
  // Mirrors test_sleep.py.
  it("documents both options under GNU's own synopsis", async () => {
    const [out] = await handleSleep(['--help'])
    const page = await readBody(out)
    expect(page).toContain('Usage: sleep NUMBER[SUFFIX]...\n')
    expect(page).not.toContain('[<text>...]')
    for (const option of ['--help', '--version']) expect(page).toContain(`  ${option}`)
  })

  it.each([[['--version']], [['--v']], [['0', '--version']]])(
    'answers %j with the version line on stdout',
    async (args) => {
      const [out, io] = await handleSleep(args)
      expect(io.exitCode).toBe(0)
      expect(await readBody(out)).toBe(versionLine('sleep'))
    },
  )

  // getopt_long recognized the option and refused the VALUE, so the message
  // names the canonical spelling and drops the value.
  it.each([
    ['--help=x', '--help'],
    ['--hel=x', '--help'],
    ['--version=x', '--version'],
  ])('refuses %j for its value', async (arg, canonical) => {
    const [, io] = await handleSleep([arg])
    expect(io.exitCode).toBe(1)
    expect(decode(io.stderr as Uint8Array)).toBe(
      `sleep: option '${canonical}' doesn't allow an argument\n` +
        "Try 'sleep --help' for more information.\n",
    )
  })

  // An empty long name prefixes both standard options, and getopt_long quotes
  // the WHOLE token in that refusal where the value one quotes the canonical
  // spelling (measured on 9.7).
  it('refuses an empty long name as ambiguous', async () => {
    const [, io] = await handleSleep(['--=x'])
    expect(io.exitCode).toBe(1)
    expect(decode(io.stderr as Uint8Array)).toBe(
      "sleep: option '--=x' is ambiguous; possibilities: '--help' '--version'\n" +
        "Try 'sleep --help' for more information.\n",
    )
  })

  // Prefix matching is byte-exact: a longer dash run and a different case both
  // prefix nothing (measured on 9.7).
  it.each(['---help', '--HELP'])('reports %s as unrecognized', async (arg) => {
    const [, io] = await handleSleep([arg])
    expect(io.exitCode).toBe(1)
    expect(decode(io.stderr as Uint8Array)).toBe(
      `sleep: unrecognized option '${arg}'\nTry 'sleep --help' for more information.\n`,
    )
  })

  // `--` ends the scan, so the word after it is an interval, not a help
  // request (measured on 9.7).
  it('reads --help after the end of options as an interval', async () => {
    const [, io] = await handleSleep(['--', '--help'])
    expect(io.exitCode).toBe(1)
    expect(decode(io.stderr as Uint8Array)).toBe(
      "sleep: invalid time interval '--help'\nTry 'sleep --help' for more information.\n",
    )
  })

  // A short one names the offending character, GNU's other wording.
  it('names the character of an unknown short option', async () => {
    const [, io] = await handleSleep(['-Q'])
    expect(decode(io.stderr as Uint8Array)).toBe(
      "sleep: invalid option -- 'Q'\nTry 'sleep --help' for more information.\n",
    )
  })

  it.each(['-1', 'inf', 'Infinity', 'nan', 'NaN', '0x10', '1_0', '1e309', ''])(
    'rejects %j as invalid time interval',
    async (raw) => {
      const [, io] = await handleSleep([raw])
      expect(io.exitCode).toBe(1)
      expect(decode(io.stderr as Uint8Array)).toBe(
        `sleep: invalid time interval '${raw}'\nTry 'sleep --help' for more information.\n`,
      )
    },
  )

  // `NUMBER[SUFFIX]...`: sleep takes any number of intervals and sleeps their
  // sum (measured on 9.7: `sleep 0.3 0.3` takes 0.6s, `sleep 0 1` takes 1s).
  // Reading only the first operand made `sleep -- 0 1` return at once.
  // Mirrors test_sleep.py.
  // The bound is 90 rather than 100 because the bug this guards against
  // sleeps 50ms (only the first operand), so 90 still separates the two by
  // 40ms, while a timer is allowed to land a millisecond early: CI measured
  // 99ms for a 100ms wait, libuv scheduling against a cached loop time.
  it('sums every operand', async () => {
    const started = Date.now()
    const [, io] = await handleSleep(['--', '0.05', '0.05'])
    expect(io.exitCode).toBe(0)
    expect(Date.now() - started).toBeGreaterThanOrEqual(90)
  })

  // The page this arm prints heads with GNU's own
  // `Usage: sleep NUMBER[SUFFIX]...`, and gnulib's `apply_suffix` is what that
  // promises: one trailing character, multiplying by 1, 60, 3600 or 86400.
  // Measured on coreutils 9.7 -- `sleep 0.3s` and `sleep 0.005m` each take
  // 0.3s, `sleep 0.0001h` takes 0.36s -- and asserted on the elapsed time
  // rather than on the parse, because reading the suffix and then dropping the
  // multiplier would satisfy any check of the exit code alone. The 10ms of
  // slack is the sum test's, for a timer that lands early. Mirrors
  // test_sleep.py.
  it.each([
    ['0.3s', 300],
    ['0.005m', 300],
    ['0.0001h', 360],
    ['0.0000035d', 302],
  ])('scales %s by the advertised suffix', async (raw, ms) => {
    const started = Date.now()
    const [, io] = await handleSleep([raw])
    expect(io.exitCode).toBe(0)
    expect(Date.now() - started).toBeGreaterThanOrEqual(ms - 10)
  })

  // A suffixed operand sums with a bare one like any other.
  it('sums suffixed and bare operands', async () => {
    const started = Date.now()
    const [, io] = await handleSleep(['0.05', '0.05s'])
    expect(io.exitCode).toBe(0)
    expect(Date.now() - started).toBeGreaterThanOrEqual(90)
  })

  // gnulib allows exactly ONE character after the number and switches on it in
  // lowercase, so everything here is `invalid time interval` on 9.7: an
  // uppercase suffix, two of them, a suffix with anything after it, a letter
  // that is not one, and a bare suffix with no number. Mirrors test_sleep.py.
  it.each(['0S', '0M', '0H', '0D', '0.5S', '0ss', '0sx', '0n', '0b', 's', '1_0s', '0 s'])(
    'refuses %j, a suffix gnulib does not take',
    async (raw) => {
      const [, io] = await handleSleep(['--', raw])
      expect(io.exitCode).toBe(1)
      expect(decode(io.stderr as Uint8Array)).toBe(
        `sleep: invalid time interval '${raw}'\nTry 'sleep --help' for more information.\n`,
      )
    },
  )

  // Every operand is validated and EVERY bad one is named: coreutils calls
  // `error()` per offending operand and only then `usage (EXIT_FAILURE)`, so
  // the lines come in line order, a repeat repeats, and one Try-help line
  // closes them (measured on 9.7: `sleep 1x 2y` is three lines, `sleep 1x 1x`
  // names 1x twice, `sleep 1x 0 2y` skips the good one). Reading only the
  // first operand made `sleep -- 0 bogus` exit 0. Mirrors test_sleep.py.
  it.each([
    [['--', '0', 'bogus'], ['bogus']],
    [['0', 'bogus'], ['bogus']],
    [['bogus', '0'], ['bogus']],
    [
      ['--', '0.2', 'x', 'y'],
      ['x', 'y'],
    ],
    [
      ['1x', '1x'],
      ['1x', '1x'],
    ],
    [
      ['1x', '0', '2y'],
      ['1x', '2y'],
    ],
  ])('refuses %j naming every bad operand', async (args, named) => {
    const [, io] = await handleSleep(args)
    expect(io.exitCode).toBe(1)
    const lines = named.map((w) => `sleep: invalid time interval '${w}'\n`).join('')
    expect(decode(io.stderr as Uint8Array)).toBe(
      `${lines}Try 'sleep --help' for more information.\n`,
    )
  })

  // The SUM is what gets slept, so an operand that carries it past the
  // representable range is refused like one that is not finite on its own.
  // Each 1e308 passes the per-operand check, and the total overflowed to
  // Infinity, which node's setTimeout clamps to 1ms (returning at once, where
  // python's asyncio.sleep waits forever) -- both halves of the hang that
  // SLEEP_INTERVAL's `inf` divergence exists to prevent. GNU sleeps forever
  // here too (measured on 9.7, as it does on `sleep inf`); refusing is the
  // same deliberate divergence. The operand that overflowed is the one named,
  // so a third one is a second diagnostic. Mirrors test_sleep.py.
  it.each([
    [['1e308', '1e308'], ['1e308']],
    [
      ['1e308', '1e308', '1e308'],
      ['1e308', '1e308'],
    ],
  ])('refuses %j, a sum that overflows', async (args, named) => {
    const [, io] = await handleSleep(args)
    expect(io.exitCode).toBe(1)
    const lines = named.map((w) => `sleep: invalid time interval '${w}'\n`).join('')
    expect(decode(io.stderr as Uint8Array)).toBe(
      `${lines}Try 'sleep --help' for more information.\n`,
    )
  })

  // A total that stays representable is still slept, however large: only the
  // overflow is refused, not a big number. node's setTimeout holds a 32-bit
  // delay and clamps anything longer to 1ms, so `sleep 1e308` returned at once
  // where python waited; `sleep()` (workspace/abort.ts) re-arms instead.
  // Mirrors test_sleep.py.
  //
  // The assertion is that the wait has NOT settled, never on the elapsed time:
  // an `elapsed >= 150` line here would only be asserting that this test's own
  // wait lasted as long as it asked for, which a timer is allowed to undershoot
  // (CI measured 149). The signal it stands in for has a 75x margin instead,
  // since the clamped version settled in 1-2ms.
  it('keeps a large but representable total', async () => {
    const ac = new AbortController()
    let settled = false
    const done = handleSleep(['1e308'], ac.signal).then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await new Promise((r) => setTimeout(r, 150))
    expect(settled).toBe(false)
    // Cancel rather than leaving a re-armed timer behind for the worker.
    ac.abort()
    await done
  })

  // The check runs over every operand before any of them is slept, so a bad
  // one does not cost the wait its predecessors would have taken (measured on
  // 9.7: `sleep 0.2 x 0.2` exits 1 immediately). Mirrors test_sleep.py.
  it('checks every operand before sleeping any', async () => {
    const started = Date.now()
    const [, io] = await handleSleep(['0.3', 'bogus'])
    expect(io.exitCode).toBe(1)
    expect(Date.now() - started).toBeLessThan(200)
  })

  // The operand is named through gnulib's `quote()`, like every other
  // coreutils operand diagnostic: measured on 9.4, `sleep -- é` is
  // `sleep: invalid time interval '\303\251'`. Mirrors test_sleep.py.
  it.each([
    ['xé', 'x\\303\\251'],
    ['x\r', 'x\\r'],
    ['--zzz=é', '--zzz=\\303\\251'],
  ])('quotes %j in the sleep interval clause', async (raw, escaped) => {
    const [, io] = await handleSleep(['--', raw])
    expect(decode(io.stderr as Uint8Array)).toBe(
      `sleep: invalid time interval '${escaped}'\nTry 'sleep --help' for more information.\n`,
    )
  })

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
    const s = new SessionState({ sessionId: 'test', cwd: '/ram' })
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
    const s = new SessionState({ sessionId: 'test', cwd: '/ram' })
    await handleCd(dispatch, () => true, '/ram/data', s)
    expect(s.cwd).toBe('/ram/data')
  })

  it('rejects non-directory targets', async () => {
    const dispatch = vi.fn<DispatchFn>(() =>
      Promise.resolve<[unknown, IOResult]>([
        new FileStat({ name: 'file', type: FileType.FILE, content: ContentType.TEXT }),
        new IOResult(),
      ]),
    )
    const s = new SessionState({ sessionId: 'test', cwd: '/ram' })
    const [, io] = await handleCd(dispatch, () => true, '/ram/file', s)
    expect(io.exitCode).toBe(1)
    expect(decode(io.stderr as Uint8Array)).toMatch(/Not a directory/)
  })

  it('rejects when stat returns null and path is not a mount root', async () => {
    const dispatch = vi.fn<DispatchFn>(() =>
      Promise.resolve<[unknown, IOResult]>([null, new IOResult()]),
    )
    const s = new SessionState({ sessionId: 'test', cwd: '/' })
    const [, io] = await handleCd(dispatch, () => false, '/missing', s)
    expect(io.exitCode).toBe(1)
    expect(decode(io.stderr as Uint8Array)).toMatch(/No such file or directory/)
    expect(s.cwd).toBe('/')
  })

  it('rejects when stat throws not-found and path is not a mount root', async () => {
    const dispatch = vi.fn<DispatchFn>(() => Promise.reject(new Error('not found: /x')))
    const s = new SessionState({ sessionId: 'test', cwd: '/' })
    const [, io] = await handleCd(dispatch, () => false, '/missing', s)
    expect(io.exitCode).toBe(1)
    expect(decode(io.stderr as Uint8Array)).toMatch(/No such file or directory/)
    expect(s.cwd).toBe('/')
  })

  it('allows cd to a mount root even when stat returns null', async () => {
    const dispatch = vi.fn<DispatchFn>(() =>
      Promise.resolve<[unknown, IOResult]>([null, new IOResult()]),
    )
    const s = new SessionState({ sessionId: 'test', cwd: '/' })
    const [, io] = await handleCd(dispatch, (p) => p === '/data', '/data', s)
    expect(io.exitCode).toBe(0)
    expect(s.cwd).toBe('/data')
  })
})

describe('handleEval', () => {
  it('runs the joined words in the frames of its caller', async () => {
    const exec = vi.fn<ExecuteStringFn>(() => Promise.resolve(new IOResult({ exitCode: 7 })))
    const s = new SessionState({ sessionId: 'sess' })
    const cs = new CallStack()
    const [, io] = await handleEval(exec, ['echo', 'hi'], s, null, undefined, cs)
    expect(io.exitCode).toBe(7)
    expect(exec).toHaveBeenCalledWith('echo hi', { sessionId: 'sess', stdin: null, callStack: cs })
  })
})

describe('handleTest', () => {
  const dispatch = vi.fn<DispatchFn>(() =>
    Promise.resolve<[unknown, IOResult]>([
      new FileStat({ name: 'x', type: FileType.FILE }),
      new IOResult(),
    ]),
  )
  const session = new SessionState({ sessionId: 'test' })
  const testResolve: ResolveFn = () => Promise.reject(new Error('unused'))
  const testNamespace = () => new Namespace(new MountRegistry({}, MountMode.READ), testResolve)

  it('-z on empty string → true (exit 0)', async () => {
    const [, io] = await handleTest(dispatch, testNamespace(), ['-z', ''], session)
    expect(io.exitCode).toBe(0)
  })

  it('-z on non-empty → false (exit 1)', async () => {
    const [, io] = await handleTest(dispatch, testNamespace(), ['-z', 'x'], session)
    expect(io.exitCode).toBe(1)
  })

  it('integer comparison -eq', async () => {
    const [, io] = await handleTest(dispatch, testNamespace(), ['3', '-eq', '3'], session)
    expect(io.exitCode).toBe(0)
    const [, io2] = await handleTest(dispatch, testNamespace(), ['3', '-eq', '4'], session)
    expect(io2.exitCode).toBe(1)
  })

  it('string equality =', async () => {
    const [, io] = await handleTest(dispatch, testNamespace(), ['foo', '=', 'foo'], session)
    expect(io.exitCode).toBe(0)
  })

  it('-f relative operand resolves against session.cwd', async () => {
    const spy = vi.fn<DispatchFn>((op, scope) => {
      const ps = scope
      if (ps.virtual === '/data/plain.txt') {
        return Promise.resolve<[unknown, IOResult]>([
          new FileStat({ name: 'plain.txt', type: FileType.FILE }),
          new IOResult(),
        ])
      }
      return Promise.reject(new Error(`not found: ${ps.virtual}`))
    })
    const s = new SessionState({ sessionId: 'test' })
    s.cwd = '/data'
    const [, io] = await handleTest(spy, testNamespace(), ['-f', 'plain.txt'], s)
    expect(io.exitCode).toBe(0)
    const [, io2] = await handleTest(spy, testNamespace(), ['-f', 'missing.txt'], s)
    expect(io2.exitCode).toBe(1)
  })

  it('-f empty operand is false without dispatch', async () => {
    const spy = vi.fn<DispatchFn>(() =>
      Promise.resolve<[unknown, IOResult]>([
        new FileStat({ name: 'x', type: FileType.FILE }),
        new IOResult(),
      ]),
    )
    const s = new SessionState({ sessionId: 'test' })
    const [, io] = await handleTest(spy, testNamespace(), ['-f', ''], s)
    expect(io.exitCode).toBe(1)
    expect(spy).not.toHaveBeenCalled()
  })

  it('-d relative operand resolves against session.cwd', async () => {
    const spy = vi.fn<DispatchFn>((op, scope) => {
      const ps = scope
      if (op === 'readdir' && ps.virtual === '/data/sub') {
        return Promise.resolve<[unknown, IOResult]>([['a.txt'], new IOResult()])
      }
      return Promise.reject(new Error(`not found: ${ps.virtual}`))
    })
    const s = new SessionState({ sessionId: 'test' })
    s.cwd = '/data'
    const [, io] = await handleTest(spy, testNamespace(), ['-d', 'sub'], s)
    expect(io.exitCode).toBe(0)
  })
})

describe('handleShift', () => {
  it('shifts call-stack positional args', () => {
    const cs = new CallStack()
    cs.push(['a', 'b', 'c', 'd'])
    handleShift(['2'], cs, new SessionState({ sessionId: 'test' }))
    expect(cs.getAllPositional()).toEqual(['c', 'd'])
  })

  it('shifts session.positionalArgs when call stack empty', () => {
    const cs = new CallStack()
    const s = new SessionState({ sessionId: 'test', positionalArgs: ['x', 'y', 'z'] })
    handleShift(['1'], cs, s)
    expect(s.positionalArgs).toEqual(['y', 'z'])
  })
})

describe('handleGetopts', () => {
  it('single flag sets var and advances OPTIND', async () => {
    const s = new SessionState({ sessionId: 't' })
    const [, io] = await handleGetopts(['ab', 'o', '-a'], s, null, sessionView(s))
    expect(io.exitCode).toBe(0)
    expect(s.env.o).toBe('a')
    expect(s.env.OPTIND).toBe('2')
  })

  it('iterates two flags then stops', async () => {
    const s = new SessionState({ sessionId: 't' })
    const args = ['ab', 'o', '-a', '-b']
    await handleGetopts(args, s, null, sessionView(s))
    expect([s.env.o, s.env.OPTIND]).toEqual(['a', '2'])
    await handleGetopts(args, s, null, sessionView(s))
    expect([s.env.o, s.env.OPTIND]).toEqual(['b', '3'])
    const [, io3] = await handleGetopts(args, s, null, sessionView(s))
    expect(io3.exitCode).toBe(1)
    expect(s.env.o).toBe('?')
  })

  it('separate optarg', async () => {
    const s = new SessionState({ sessionId: 't' })
    const [, io] = await handleGetopts(['a:b', 'o', '-a', 'foo', '-b'], s, null, sessionView(s))
    expect(io.exitCode).toBe(0)
    expect(s.env.o).toBe('a')
    expect(s.env.OPTARG).toBe('foo')
    expect(s.env.OPTIND).toBe('3')
  })

  it('attached optarg', async () => {
    const s = new SessionState({ sessionId: 't' })
    const [, io] = await handleGetopts(['a:', 'o', '-afoo'], s, null, sessionView(s))
    expect(io.exitCode).toBe(0)
    expect(s.env.o).toBe('a')
    expect(s.env.OPTARG).toBe('foo')
    expect(s.env.OPTIND).toBe('2')
  })

  it('combined flags share OPTIND until the word is done', async () => {
    const s = new SessionState({ sessionId: 't' })
    const args = ['abc', 'o', '-abc']
    await handleGetopts(args, s, null, sessionView(s))
    expect([s.env.o, s.env.OPTIND]).toEqual(['a', '1'])
    await handleGetopts(args, s, null, sessionView(s))
    expect([s.env.o, s.env.OPTIND]).toEqual(['b', '1'])
    await handleGetopts(args, s, null, sessionView(s))
    expect([s.env.o, s.env.OPTIND]).toEqual(['c', '2'])
  })

  it('invalid option, non-silent', async () => {
    const s = new SessionState({ sessionId: 't' })
    const [, io] = await handleGetopts(['ab', 'o', '-x'], s, null, sessionView(s))
    expect(io.exitCode).toBe(0)
    expect(s.env.o).toBe('?')
    expect(decode(io.stderr as Uint8Array)).toBe('bash: illegal option -- x\n')
    expect(s.env.OPTIND).toBe('2')
  })

  it('invalid option, silent → OPTARG set, no stderr', async () => {
    const s = new SessionState({ sessionId: 't' })
    const [, io] = await handleGetopts([':ab', 'o', '-x'], s, null, sessionView(s))
    expect(io.exitCode).toBe(0)
    expect(s.env.o).toBe('?')
    expect(s.env.OPTARG).toBe('x')
    expect(io.stderr).toBeNull()
  })

  it('missing arg, non-silent', async () => {
    const s = new SessionState({ sessionId: 't' })
    const [, io] = await handleGetopts(['a:', 'o', '-a'], s, null, sessionView(s))
    expect(io.exitCode).toBe(0)
    expect(s.env.o).toBe('?')
    expect(decode(io.stderr as Uint8Array)).toBe('bash: option requires an argument -- a\n')
  })

  it('missing arg, silent → name ":" and OPTARG', async () => {
    const s = new SessionState({ sessionId: 't' })
    const [, io] = await handleGetopts([':a:', 'o', '-a'], s, null, sessionView(s))
    expect(io.exitCode).toBe(0)
    expect(s.env.o).toBe(':')
    expect(s.env.OPTARG).toBe('a')
    expect(io.stderr).toBeNull()
  })

  it('non-option word stops without advancing', async () => {
    const s = new SessionState({ sessionId: 't' })
    const [, io] = await handleGetopts(['ab', 'o', 'foo', '-a'], s, null, sessionView(s))
    expect(io.exitCode).toBe(1)
    expect(s.env.OPTIND).toBe('1')
  })

  it('double dash is consumed then stops', async () => {
    const s = new SessionState({ sessionId: 't' })
    const [, io] = await handleGetopts(['ab', 'o', '--', '-a'], s, null, sessionView(s))
    expect(io.exitCode).toBe(1)
    expect(s.env.OPTIND).toBe('2')
  })

  it('no args stops', async () => {
    const s = new SessionState({ sessionId: 't' })
    const [, io] = await handleGetopts(['ab', 'o'], s, null, sessionView(s))
    expect(io.exitCode).toBe(1)
    expect(s.env.OPTIND).toBe('1')
  })

  it('reads positional args when no explicit args', async () => {
    const s = new SessionState({ sessionId: 't', positionalArgs: ['-a', '-b'] })
    const [, io] = await handleGetopts(['ab', 'o'], s, null, sessionView(s))
    expect(io.exitCode).toBe(0)
    expect(s.env.o).toBe('a')
  })

  it('usage error on too few operands', async () => {
    const s = new SessionState({ sessionId: 't' })
    const [, io] = await handleGetopts(['ab'], s, null, sessionView(s))
    expect(io.exitCode).toBe(2)
    expect(decode(io.stderr as Uint8Array)).toBe(
      'getopts: usage: getopts optstring name [arg ...]\n',
    )
  })

  it('OPTIND reset reparses', async () => {
    const s = new SessionState({ sessionId: 't', positionalArgs: ['-a', '-b'] })
    await handleGetopts(['ab', 'o'], s, null, sessionView(s))
    await handleGetopts(['ab', 'o'], s, null, sessionView(s))
    const [, stop] = await handleGetopts(['ab', 'o'], s, null, sessionView(s))
    expect(stop.exitCode).toBe(1)
    seedVar(s, 'OPTIND', '1')
    s.positionalArgs = ['-b', '-a']
    const [, io] = await handleGetopts(['ab', 'o'], s, null, sessionView(s))
    expect(io.exitCode).toBe(0)
    expect(s.env.o).toBe('b')
  })

  it('does not read past the end of a shorter reused word', async () => {
    const s = new SessionState({ sessionId: 't' })
    await handleGetopts(['ab', 'o', '-ab'], s, null, sessionView(s))
    const [, io] = await handleGetopts(['ab', 'o', '-a'], s, null, sessionView(s))
    expect(io.exitCode).toBe(0)
    expect(s.env.o).toBe('a')
    expect(s.env.OPTIND).toBe('2')
  })

  it('treats a nonpositive OPTIND as a restart at argument 1', async () => {
    const s = new SessionState({ sessionId: 't', positionalArgs: ['-a', '-b'] })
    seedVar(s, 'OPTIND', '0')
    const [, io] = await handleGetopts(['ab', 'o'], s, null, sessionView(s))
    expect(io.exitCode).toBe(0)
    expect(s.env.o).toBe('a')
    expect(s.env.OPTIND).toBe('2')
  })

  it('rejects an invalid destination identifier', async () => {
    const s = new SessionState({ sessionId: 't' })
    const [, io] = await handleGetopts(['a', 'bad-name', '-a'], s, null, sessionView(s))
    expect(io.exitCode).toBe(1)
    expect(decode(io.stderr as Uint8Array)).toContain('not a valid identifier')
    expect(s.env['bad-name']).toBeUndefined()
  })

  it('does not overwrite a readonly destination', async () => {
    const s = new SessionState({
      sessionId: 't',
      vars: { o: makeVar('orig', new Set([VarAttr.Readonly])) },
    })
    const [, io] = await handleGetopts(['a', 'o', '-a'], s, null, sessionView(s))
    expect(io.exitCode).toBe(1)
    expect(s.env.o).toBe('orig')
    expect(decode(io.stderr as Uint8Array)).toContain('readonly variable')
  })

  it('suppresses diagnostics when OPTERR=0', async () => {
    const s = new SessionState({ sessionId: 't', vars: varsFromEnv({ OPTERR: '0' }) })
    const [, io] = await handleGetopts(['ab', 'o', '-x'], s, null, sessionView(s))
    expect(s.env.o).toBe('?')
    expect(io.stderr ?? null).toBeNull()
  })

  it('scans the function frame positional parameters', async () => {
    const s = new SessionState({ sessionId: 't' })
    const cs = new CallStack()
    cs.push(['-a', '-b'], 'f')
    await handleGetopts(['ab', 'o'], s, cs, sessionView(s))
    expect(s.env.o).toBe('a')
    await handleGetopts(['ab', 'o'], s, cs, sessionView(s))
    expect(s.env.o).toBe('b')
  })

  it('propagates the cursor across fork()', async () => {
    const s = new SessionState({ sessionId: 't' })
    await handleGetopts(['ab', 'o', '-ab'], s, null, sessionView(s))
    const forked = s.fork()
    expect(forked.getoptsPos).toBe(s.getoptsPos)
    expect(forked.getoptsOptind).toBe(s.getoptsOptind)
  })
})

describe('handleSet', () => {
  it('no args → print env', () => {
    const s = new SessionState({ sessionId: 'test', vars: varsFromEnv({ A: '1' }) })
    const [out] = handleSet([], s)
    expect(decode(out as Uint8Array)).toBe("A=1\nIFS=$' \\t\\n'\nPATH=/usr/bin\nPWD=/\n")
  })

  it.each([
    ['a,b', 'a,b'],
    ['', ''],
    ['a b', "'a b'"],
    ["it's", "'it'\\''s'"],
    ['~x', "'~x'"],
    ['x=~y', "'x=~y'"],
    ['x~', 'x~'],
    ['#c', "'#c'"],
    ['x#', 'x#'],
    [' \t\n', "$' \\t\\n'"],
  ])('no args quotes %j as bash does', (value, listed) => {
    const s = new SessionState({ sessionId: 'test', vars: varsFromEnv({ V: value }) })
    const [out] = handleSet([], s)
    expect(decode(out as Uint8Array).split('\n')).toContain(`V=${listed}`)
  })

  it('no args sorts by name', () => {
    const s = new SessionState({ sessionId: 'test', vars: varsFromEnv({ B2: '1', B: '2' }) })
    const lines = decode(handleSet([], s)[0] as Uint8Array).split('\n')
    expect(lines.indexOf('B=2')).toBeLessThan(lines.indexOf('B2=1'))
  })

  it('"-- a b" sets positional args', () => {
    const s = new SessionState({ sessionId: 'test' })
    handleSet(['--', 'a', 'b'], s)
    expect(s.positionalArgs).toEqual(['a', 'b'])
  })
})

describe('handleReturn / handleLocal', () => {
  it('handleReturn throws ReturnSignal with exit code', () => {
    const s = new SessionState({ sessionId: 'test' })
    const cs = new CallStack()
    cs.push([], 'f')
    expect(() => handleReturn(['42'], s, cs)).toThrow(ReturnSignal)
    try {
      handleReturn(['42'], s, cs)
    } catch (err) {
      if (err instanceof ReturnSignal) expect(err.exitCode).toBe(42)
    }
  })

  it('bare return propagates the last exit code', () => {
    const s = new SessionState({ sessionId: 'test' })
    s.lastExitCode = 1
    const cs = new CallStack()
    cs.push([], 'f')
    try {
      handleReturn([], s, cs)
      expect.unreachable()
    } catch (err) {
      if (!(err instanceof ReturnSignal)) throw err
      expect(err.exitCode).toBe(1)
    }
  })

  it('return outside a function fails without a signal', async () => {
    const s = new SessionState({ sessionId: 'test' })
    const [, io] = handleReturn([], s, new CallStack())
    expect(io.exitCode).toBe(2)
    expect(decode(await materialize(io.stderr))).toContain("can only `return'")
  })

  it('return in a sourced script raises the signal', () => {
    const cs = new CallStack()
    cs.push([], 'source', true)
    expect(() => handleReturn([], new SessionState({ sessionId: 'test' }), cs)).toThrow(
      ReturnSignal,
    )
  })

  it('handleLocal outside a function is refused, as GNU refuses it', async () => {
    // `bash: line 1: local: can only be used in a function`, exit 1 and
    // nothing stored. Storing it globally and exiting 0 is the
    // silent-accept this tier removes.
    const s = new SessionState({ sessionId: 'test' })
    const [, io] = await handleLocal(['X=1'], s, sessionView(s))
    expect(io.exitCode).toBe(1)
    expect(s.env.X).toBeUndefined()
  })

  it('handleLocal assigns to session.env under the declare spelling', async () => {
    const s = new SessionState({ sessionId: 'test' })
    await handleLocal(['X=1'], s, sessionView(s), null, 'declare')
    expect(s.env.X).toBe('1')
  })
})

describe('handleRead', () => {
  it('reads single line into one variable', async () => {
    const s = new SessionState({ sessionId: 'test' })
    const stdin = new TextEncoder().encode('hello world\nrest\n')
    const [, io] = await handleRead(['LINE'], s, stdin, sessionView(s))
    expect(io.exitCode).toBe(0)
    expect(s.env.LINE).toBe('hello world')
  })

  it('splits whitespace across multiple variables', async () => {
    const s = new SessionState({ sessionId: 'test' })
    const stdin = new TextEncoder().encode('alice 30 engineer\n')
    await handleRead(['NAME', 'AGE', 'ROLE'], s, stdin, sessionView(s))
    expect(s.env.NAME).toBe('alice')
    expect(s.env.AGE).toBe('30')
    expect(s.env.ROLE).toBe('engineer')
  })

  it('last variable absorbs remainder', async () => {
    const s = new SessionState({ sessionId: 'test' })
    const stdin = new TextEncoder().encode('one two three four five\n')
    await handleRead(['A', 'B', 'C'], s, stdin, sessionView(s))
    expect(s.env.A).toBe('one')
    expect(s.env.B).toBe('two')
    expect(s.env.C).toBe('three four five')
  })

  it('EOF / null stdin: assign empty + exit 1', async () => {
    const s = new SessionState({ sessionId: 'test' })
    const [, io] = await handleRead(['X', 'Y'], s, null, sessionView(s))
    expect(io.exitCode).toBe(1)
    expect(s.env.X).toBe('')
    expect(s.env.Y).toBe('')
  })

  it('reads from AsyncIterable stdin', async () => {
    const s = new SessionState({ sessionId: 'test' })
    // eslint-disable-next-line @typescript-eslint/require-await
    async function* gen(): AsyncIterable<Uint8Array> {
      yield new TextEncoder().encode('streamed line\nignored\n')
    }
    await handleRead(['L'], s, gen(), sessionView(s))
    expect(s.env.L).toBe('streamed line')
  })

  it('a NEW stdin source replaces a stale exhausted buffer', async () => {
    const s = new SessionState({ sessionId: 'test' })
    const first = share(new TextEncoder().encode('first\n'))
    await handleRead(['X'], s, first, sessionView(s))
    await handleRead(['X2'], s, first, sessionView(s))
    expect(s.env.X2).toBe('')
    const second = new TextEncoder().encode('second\n')
    const [, io] = await handleRead(['Y'], s, second, sessionView(s))
    expect(io.exitCode).toBe(0)
    expect(s.env.Y).toBe('second')
  })

  it('the SAME shared stdin keeps advancing through lines', async () => {
    const s = new SessionState({ sessionId: 'test' })
    const shared = share(new TextEncoder().encode('a\nb\n'))
    await handleRead(['P'], s, shared, sessionView(s))
    await handleRead(['Q'], s, shared, sessionView(s))
    expect(s.env.P).toBe('a')
    expect(s.env.Q).toBe('b')
  })

  it('a scalar read replaces an array of the same name', async () => {
    const s = new SessionState({ sessionId: 'test' })
    seedVar(s, 'A', ['x', 'y'])
    const stdin = new TextEncoder().encode('one\n')
    await handleRead(['A'], s, stdin, sessionView(s))
    expect(s.env.A).toBe('one')
    expect(s.arrays.A).toBeUndefined()
  })
})

describe('handleSource', () => {
  it('dispatches read on the path then runs script', async () => {
    const s = new SessionState({ sessionId: 'test', cwd: '/' })
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
    const s = new SessionState({ sessionId: 'test', cwd: '/' })
    const dispatch = vi.fn(() => Promise.reject(enoent('/missing.sh'))) as unknown as DispatchFn
    const executeFn = vi.fn(() => Promise.resolve(new IOResult()))
    const [, io] = await handleSource(dispatch, executeFn, '/missing.sh', s)
    expect(io.exitCode).toBe(1)
    expect(decode(io.stderr instanceof Uint8Array ? io.stderr : null)).toBe(
      'bash: /missing.sh: No such file or directory\n',
    )
    expect(executeFn).not.toHaveBeenCalled()
  })

  it('propagates a failure that is not a filesystem error', async () => {
    const s = new SessionState({ sessionId: 'test', cwd: '/' })
    const dispatch = vi.fn(() =>
      Promise.reject(new Error('token expired')),
    ) as unknown as DispatchFn
    const executeFn = vi.fn(() => Promise.resolve(new IOResult()))
    await expect(handleSource(dispatch, executeFn, '/script.sh', s)).rejects.toThrow(
      'token expired',
    )
    expect(executeFn).not.toHaveBeenCalled()
  })

  it('sets positional args for the script and restores them after', async () => {
    const s = new SessionState({ sessionId: 'test', cwd: '/', positionalArgs: ['P1', 'P2'] })
    const dispatch = vi.fn(() => {
      const data = new TextEncoder().encode('echo hi\n')
      return Promise.resolve([data, new IOResult()] as [Uint8Array, IOResult])
    }) as unknown as DispatchFn
    let seen: string[] = []
    const executeFn = vi.fn(
      (_script: string, opts: { sessionId: string; callStack?: CallStack }) => {
        seen = [...(opts.callStack?.getAllPositional() ?? [])]
        return Promise.resolve(new IOResult())
      },
    )
    await handleSource(dispatch, executeFn, '/script.sh', s, ['AA', 'BB'])
    expect(seen).toEqual(['AA', 'BB'])
    expect(s.positionalArgs).toEqual(['P1', 'P2'])
  })
})

describe('handleMan', () => {
  it('renders header and description for a known command, no VFS section', async () => {
    const reg = new MountRegistry({ '/ram/': new RAMVFS() }, MountMode.WRITE)
    wireRegistry(reg)
    const [out, io] = handleMan(['date'], reg, MAN_SESSION)
    expect(io.exitCode).toBe(0)
    const body = await readBody(out)
    expect(body.startsWith('# date\n\n')).toBe(true)
    expect(body).not.toContain('RESOURCES')
    expect(body).not.toMatch(/^- general$/m)
  })

  it('renders OPTIONS table when the spec has options', async () => {
    const reg = new MountRegistry({ '/ram/': new RAMVFS() }, MountMode.WRITE)
    wireRegistry(reg)
    const [out, io] = handleMan(['date'], reg, MAN_SESSION)
    expect(io.exitCode).toBe(0)
    const body = await readBody(out)
    expect(body).toContain('## OPTIONS')
    expect(body).toContain('| short | long | value | description |')
  })

  it('renders one page however many mounts register the name', async () => {
    const reg = new MountRegistry(
      { '/ram-a/': new RAMVFS(), '/ram-b/': new RAMVFS() },
      MountMode.WRITE,
    )
    wireRegistry(reg)
    const [out, io] = handleMan(['cat'], reg, MAN_SESSION)
    expect(io.exitCode).toBe(0)
    const body = await readBody(out)
    expect(body.startsWith('# cat\n\n')).toBe(true)
    expect(body).not.toContain('ram')
  })

  it('documents bash and sh from the bash spec', async () => {
    const reg = new MountRegistry({ '/ram/': new RAMVFS() }, MountMode.WRITE)
    wireRegistry(reg)
    const [out, io] = handleMan(['bash'], reg, MAN_SESSION)
    expect(io.exitCode).toBe(0)
    const body = await readBody(out)
    expect(body.startsWith('# bash\n')).toBe(true)
    expect(body).toContain('-c')
    expect(body).not.toContain('RESOURCES')
    const [sh] = handleMan(['sh'], reg, MAN_SESSION)
    expect((await readBody(sh)).startsWith('# sh\n')).toBe(true)
  })

  it('exits 1 with a clear error for unknown commands', () => {
    const reg = new MountRegistry({ '/ram/': new RAMVFS() }, MountMode.WRITE)
    wireRegistry(reg)
    const [, io] = handleMan(['definitely-not-a-real-command-xyz'], reg, MAN_SESSION)
    expect(io.exitCode).toBe(1)
    const errBytes = io.stderr instanceof Uint8Array ? io.stderr : null
    expect(decode(errBytes)).toContain('no entry for definitely-not-a-real-command-xyz')
  })

  it('lists every command once under # commands, sorted, with no VFS sections', async () => {
    const reg = new MountRegistry(
      { '/ram-a/': new RAMVFS(), '/ram-b/': new RAMVFS() },
      MountMode.WRITE,
    )
    wireRegistry(reg)
    const [body, io] = handleMan([], reg, MAN_SESSION)
    const out = await readBody(body)
    expect(io.exitCode).toBe(0)
    expect(out.startsWith('# commands\n\n')).toBe(true)
    expect(out).not.toContain('# ram')
    expect(out).not.toContain('# general')
    const rows = out.split('\n').filter((l) => l.startsWith('- '))
    const names = rows.map((l) => l.slice(2, l.indexOf(' — ')))
    expect(names.filter((n) => n === 'cat').length).toBe(1)
    expect(names).toEqual([...names].sort(compareCodePoints))
  })
})

function slowShell(
  delays: Record<string, number> = {},
  exitCodes: Record<string, number> = {},
): {
  lines: string[]
  peak: () => number
  fn: (script: string, opts: { sessionId: string }) => Promise<IOResult>
} {
  const lines: string[] = []
  let active = 0
  let peak = 0
  return {
    lines,
    peak: () => peak,
    fn: async (script: string) => {
      lines.push(script)
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, delays[script] ?? 10))
      active -= 1
      return new IOResult({
        stdout: new TextEncoder().encode(`ran:${script}\n`),
        exitCode: exitCodes[script] ?? 0,
      })
    },
  }
}

const TRY = "Try 'xargs --help' for more information.\n"

function warned(option: string, offending: string): string {
  return `xargs: warning: options ${offending} and ${option} are mutually exclusive, ignoring previous ${offending} value\n`
}

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

describe('handleMan for installed CLIs', () => {
  function cliRegistry(): MountRegistry {
    const reg = new MountRegistry({ '/ram/': new RAMVFS() }, MountMode.WRITE)
    wireRegistry(reg)
    reg.clis.install(
      'linear',
      new CLISpec({
        name: 'linear',
        description: 'Linear API client',
        subcommands: [
          new CLISpec({
            name: 'issue',
            description: 'Manage issues',
            aliases: ['i'],
            subcommands: [
              new CLISpec({
                name: 'create',
                description: 'Create one',
                fn: () => [null, new IOResult()],
              }),
            ],
          }),
        ],
      }),
    )
    return reg
  }

  it('renders an installed CLI', async () => {
    const [out, io] = handleMan(['linear'], cliRegistry(), MAN_SESSION)
    expect(io.exitCode).toBe(0)
    const text = await readBody(out)
    expect(text).toContain('usage: linear')
    expect(text).toContain('issue')
  })

  it('descends a verb path and resolves aliases', async () => {
    const reg = cliRegistry()
    const text = await readBody(handleMan(['linear', 'issue', 'create'], reg, MAN_SESSION)[0])
    expect(text).toContain('usage: linear issue create')
    expect(await readBody(handleMan(['linear', 'i', 'create'], reg, MAN_SESSION)[0])).toBe(text)
  })

  it('names the whole line for an unknown verb', () => {
    const [out, io] = handleMan(['linear', 'bogus'], cliRegistry(), MAN_SESSION)
    expect(out).toBeNull()
    expect(io.exitCode).toBe(1)
    const errBytes = io.stderr instanceof Uint8Array ? io.stderr : null
    expect(decode(errBytes)).toBe('man: no entry for linear bogus\n')
  })

  it('lists installed CLIs in the bare index, after the commands', async () => {
    const reg = cliRegistry()
    const text = await readBody(handleMan([], reg, MAN_SESSION)[0])
    expect(text).toContain('# clis')
    expect(text).toContain('- linear — Linear API client')
    expect(text.indexOf('# commands')).toBeLessThan(text.indexOf('# clis'))
    expect(text).not.toContain('# general')
  })
})

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
    const [, io] = handleShift(['x'], null, new SessionState({ sessionId: 'test' }))
    expect(io.exitCode).toBe(1)
    expect(decode(await materialize(io.stderr))).toBe('bash: shift: x: numeric argument required\n')
  })

  it('shift with two args abandons the line', () => {
    expect(() => handleShift(['1', '2'], null, new SessionState({ sessionId: 'test' }))).toThrow(
      ExitSignal,
    )
  })

  it('return with a non-numeric arg raises 2 with a message', () => {
    const s = new SessionState({ sessionId: 'test' })
    const cs = new CallStack()
    cs.push([], 'f')
    try {
      handleReturn(['x'], s, cs)
      expect.unreachable()
    } catch (err) {
      if (!(err instanceof ReturnSignal)) throw err
      expect(err.exitCode).toBe(2)
      expect(decode(err.stderr)).toBe('bash: return: x: numeric argument required\n')
    }
  })
})

describe('handleRead options', () => {
  it('-r is consumed, not a variable', async () => {
    const s = new SessionState({ sessionId: 'test' })
    const stdin = new TextEncoder().encode('hello world\n')
    const [, io] = await handleRead(['-r', 'v'], s, stdin, sessionView(s))
    expect(io.exitCode).toBe(0)
    expect(s.env.v).toBe('hello world')
    expect('-r' in s.env).toBe(false)
  })

  it('unknown option errors like bash', async () => {
    const s = new SessionState({ sessionId: 'test' })
    const [, io] = await handleRead(['-q', 'v'], s, new TextEncoder().encode('x\n'), sessionView(s))
    expect(io.exitCode).toBe(2)
    expect(decode(await materialize(io.stderr))).toMatch(
      /^bash: read: -q: invalid option\nread: usage: read \[-ers\]/,
    )
  })

  it('defaults to REPLY', async () => {
    const s = new SessionState({ sessionId: 'test' })
    await handleRead([], s, new TextEncoder().encode('hi\n'), sessionView(s))
    expect(s.env.REPLY).toBe('hi')
  })
})

describe('handleXargs', () => {
  const session = new SessionState({ sessionId: 'test' })

  it.each([
    ['-L0', '-L2'],
    ['-n0', '--max-args=2'],
    ['-d', '', '-0'],
  ])('rejects invalid occurrences before reading input (%j)', async (...args) => {
    const shell = fakeShell()
    const reads: boolean[] = []
    async function* source() {
      reads.push(true)
      yield await Promise.resolve(enc('a\n'))
    }
    const [, io] = await handleXargs(
      shell.fn,
      [...args, 'echo'],
      new EvaluationContext(session),
      source(),
    )
    expect(io.exitCode).toBe(1)
    expect(reads).toEqual([])
    expect(shell.lines).toEqual([])
  })

  it('-n1 batches one arg per run', async () => {
    const shell = fakeShell()
    const [, io] = await handleXargs(
      shell.fn,
      ['-n1', 'echo'],
      new EvaluationContext(session),
      aBC(),
    )
    expect(shell.lines).toEqual(['echo a', 'echo b', 'echo c'])
    expect(io.exitCode).toBe(0)
  })

  it('failing invocation exits 123 but continues', async () => {
    const shell = fakeShell([1, 0])
    const [, io] = await handleXargs(shell.fn, ['-n1', 'wc'], new EvaluationContext(session), ab())
    expect(shell.lines).toEqual(['wc a', 'wc b'])
    expect(io.exitCode).toBe(123)
  })

  it('exit 255 stops with 124', async () => {
    const shell = fakeShell([255, 0])
    const [, io] = await handleXargs(shell.fn, ['-n1', 'sh'], new EvaluationContext(session), ab())
    expect(shell.lines).toEqual(['sh a'])
    expect(io.exitCode).toBe(124)
    expect(decode(await materialize(io.stderr))).toBe(
      'xargs: sh: exited with status 255; aborting\n',
    )
  })

  it('a command exiting 127 is an ordinary failure', async () => {
    const shell = fakeShell([127, 0])
    const [, io] = await handleXargs(shell.fn, ['-n1', 'sh'], new EvaluationContext(session), ab())
    expect(shell.lines).toEqual(['sh a', 'sh b'])
    expect(io.exitCode).toBe(123)
  })

  it('-r skips the run on empty input', async () => {
    const shell = fakeShell()
    const [, io] = await handleXargs(
      shell.fn,
      ['-r', 'echo', 'hi'],
      new EvaluationContext(session),
      new Uint8Array(),
    )
    expect(shell.lines).toEqual([])
    expect(io.exitCode).toBe(0)
  })

  it('-0 splits on NUL', async () => {
    const shell = fakeShell()
    await handleXargs(
      shell.fn,
      ['-0', 'echo'],
      new EvaluationContext(session),
      new TextEncoder().encode('a b\0c\0'),
    )
    expect(shell.lines).toEqual(["echo 'a b' c"])
  })

  it('hands a raw byte to the command as itself', async () => {
    const shell = fakeShell()
    await handleXargs(
      shell.fn,
      ['printf', '%s'],
      new EvaluationContext(session),
      new Uint8Array([0x61, 0xff, 0x62, 0x0a]),
    )
    expect(shell.lines).toEqual(["printf %s 'a'$'\\xff''b'"])
  })

  it('-d splits on the delimiter', async () => {
    const shell = fakeShell()
    await handleXargs(
      shell.fn,
      ['-d,', 'echo'],
      new EvaluationContext(session),
      new TextEncoder().encode('a,b,c'),
    )
    expect(shell.lines).toEqual(['echo a b c'])
  })

  it('invalid option exits 1 without running', async () => {
    const shell = fakeShell()
    const [, io] = await handleXargs(shell.fn, ['-q', 'echo'], new EvaluationContext(session), ab())
    expect(io.exitCode).toBe(1)
    expect(decode(await materialize(io.stderr))).toBe(`xargs: invalid option -- 'q'\n${TRY}`)
    expect(shell.lines).toEqual([])
  })

  it('-n0 is rejected', async () => {
    const shell = fakeShell()
    const [, io] = await handleXargs(
      shell.fn,
      ['-n0', 'echo'],
      new EvaluationContext(session),
      ab(),
    )
    expect(io.exitCode).toBe(1)
    expect(decode(await materialize(io.stderr))).toBe(
      `xargs: value 0 for -n option should be >= 1\n${TRY}`,
    )
  })

  const enc = (text: string): Uint8Array => new TextEncoder().encode(text)

  it.each([
    [['--bogus', 'echo'], "xargs: unrecognized option '--bogus'\n"],
    [['-n'], "xargs: option requires an argument -- 'n'\n"],
    [['--max-args'], "xargs: option '--max-args' requires an argument\n"],
    [['-I'], "xargs: option requires an argument -- 'I'\n"],
  ])('option refusals carry the help hint (%j)', async (args, message) => {
    const shell = fakeShell()
    const [, io] = await handleXargs(shell.fn, args, new EvaluationContext(session), enc('x'))
    expect(io.exitCode).toBe(1)
    expect(decode(await materialize(io.stderr))).toBe(message + TRY)
    expect(shell.lines).toEqual([])
  })

  it.each([
    [
      ['--max', '1', 'echo'],
      "xargs: option '--max' is ambiguous; possibilities: '--max-lines' '--max-args' '--max-chars' '--max-procs'\n",
    ],
    [['--ver'], "xargs: option '--ver' is ambiguous; possibilities: '--verbose' '--version'\n"],
    [['--nu=x', 'echo'], "xargs: option '--null' doesn't allow an argument\n"],
    [['--help=x'], "xargs: option '--help' doesn't allow an argument\n"],
    [['--max-p'], "xargs: option '--max-procs' requires an argument\n"],
  ])('long option refusals as getopt_long words them (%j)', async (args, message) => {
    const shell = fakeShell()
    const [, io] = await handleXargs(shell.fn, args, new EvaluationContext(session), enc('x'))
    expect(io.exitCode).toBe(1)
    expect(decode(await materialize(io.stderr))).toBe(message + TRY)
    expect(shell.lines).toEqual([])
  })

  it.each<[string[], string[]]>([
    [
      ['--max-a=1', 'echo'],
      ['echo a', 'echo b'],
    ],
    [
      ['--max-a', '1', 'echo'],
      ['echo a', 'echo b'],
    ],
    [['--rep', 'echo', '[{}]'], ["echo '[a b]'"]],
    [['--rep=Z', 'echo', '[Z]'], ["echo '[a b]'"]],
    [['--max-l', 'echo'], ['echo a b']],
    [
      ['--max-p=2', '-n1', 'echo'],
      ['echo a', 'echo b'],
    ],
  ])('abbreviated long options resolve (%j)', async (args, lines) => {
    const shell = fakeShell()
    const [, io] = await handleXargs(shell.fn, args, new EvaluationContext(session), enc('a b\n'))
    expect(shell.lines).toEqual(lines)
    expect(io.exitCode).toBe(0)
  })

  it.each<[string[], string, string[], string]>([
    [['-t', 'echo', 'x'], 'a b\n', ['echo x a b'], 'echo x a b\n'],
    [['--verb', '-I{}', 'echo', '[{}]'], 'a b\n', ["echo '[a b]'"], "echo '[a b]'\n"],
    [['-0', '-t', 'echo'], "it's\n", ["echo 'it'\\''s\n'"], "echo 'it'\\''s'$'\\n'\n"],
    [['-E', 'STOP', 'echo'], 'a b STOP c\nd\n', ['echo a b'], ''],
    [['-eSTOP', 'echo'], 'STOP a\n', ['echo'], ''],
    [['-e', 'echo'], 'a _ b\n', ['echo a _ b'], ''],
    [['-s', '12', 'echo'], 'a b c d e f\n', ['echo a b c', 'echo d e f'], ''],
    [
      ['-s', '0', 'echo'],
      'a\n',
      [],
      'xargs: value 0 for -s option should be >= 1\nxargs: cannot fit single argument within argument list size limit\n',
    ],
    [['-s', '9', '-x', '-n', '3', 'echo'], 'a b c\n', [], 'xargs: argument list too long\n'],
    [['-s', '7', '-L', '1', 'echo'], 'a b\n', [], 'xargs: argument list too long\n'],
    [['-s', '10', 'echo'], 'abcdefgh\n', [], 'xargs: argument line too long\n'],
    [['-s', '12', '-I{}', 'echo', 'x{}'], 'abcdef\n', [], 'xargs: argument list too long\n'],
    [
      ['-0', '-E', 'S', 'echo'],
      'a\0S\0',
      ['echo a S'],
      'xargs: warning: the -E option has no effect if -0 or -d is used.\n\n',
    ],
    [
      ['echo'],
      'ab\0cd ef\n',
      ['echo ab ef'],
      'xargs: WARNING: a NUL character occurred in the input.  It cannot be passed through in the argument list.  Did you mean to use the --null option?\n',
    ],
    [
      ['-p', 'echo'],
      'a\n',
      [],
      'echo axargs: failed to open /dev/tty for reading: No such device or address\n',
    ],
    [['-d', '\\x2c', 'echo'], 'a,b', ['echo a b'], ''],
    [
      ['-d', 'ab', 'echo'],
      'a',
      [],
      'xargs: Invalid input delimiter specification ab: the delimiter must be either a single character or an escape sequence starting with \\.\n',
    ],
    [
      ['--process-slot-var=A=B', 'echo'],
      'a\n',
      [],
      "xargs: option --process-slot-var may not be set to a value which includes `='\n",
    ],
  ])('GNU options (%j)', async (args, data, lines, stderr) => {
    const shell = fakeShell()
    const [, io] = await handleXargs(shell.fn, args, new EvaluationContext(session), enc(data))
    expect(shell.lines).toEqual(lines)
    expect(decode(await materialize(io.stderr))).toBe(stderr)
  })

  it('-o fails without a terminal', async () => {
    const shell = fakeShell()
    const [, io] = await handleXargs(
      shell.fn,
      ['-o', 'echo'],
      new EvaluationContext(session),
      enc('a\n'),
    )
    expect(shell.lines).toEqual([])
    expect(io.exitCode).toBe(125)
    expect(decode(await materialize(io.stderr))).toMatch(/xargs: echo: terminated by signal 6\n$/)
  })

  it('--show-limits counts the environment', async () => {
    const counted = new SessionState({ sessionId: 'limits' })
    counted.vars = { ...counted.vars, ...varsFromEnv({ A: 'bb' }) }
    let size = 0
    for (const [name, value] of Object.entries(envSnapshot(counted))) {
      size += new TextEncoder().encode(`${name}=${value}`).length + 1
    }
    const upper = 2097152 - 2048 - size
    const shell = fakeShell()
    const [, io] = await handleXargs(
      shell.fn,
      ['--show-limits', '-s', '100', 'echo'],
      new EvaluationContext(counted),
      enc('a\n'),
    )
    expect(decode(await materialize(io.stderr))).toBe(
      `Your environment variables take up ${String(size)} bytes\n` +
        `POSIX upper limit on argument length (this system): ${String(upper)}\n` +
        'POSIX smallest allowable upper limit on argument length (all systems): 4096\n' +
        `Maximum length of command we could actually use: ${String(upper - size)}\n` +
        'Size of command buffer we are actually using: 100\n' +
        'Maximum parallelism (--max-procs must be no greater): 2147483647\n',
    )
    expect(shell.lines).toEqual(['echo a'])
  })

  it('--process-slot-var numbers each command in its own fork', async () => {
    const parent = new SessionState({ sessionId: 'slots' })
    const seen: string[] = []
    const execute = (line: string, opts: { session?: SessionState }): Promise<IOResult> => {
      seen.push(`${line}:${opts.session?.env.SLOT ?? ''}`)
      return Promise.resolve(new IOResult())
    }
    await handleXargs(
      execute,
      ['--process-slot-var=SLOT', '-n1', 'sh'],
      new EvaluationContext(parent),
      enc('a b\n'),
    )
    expect(seen).toEqual(['sh a:0', 'sh b:0'])
    expect(parent.env.SLOT).toBeUndefined()
  })

  it.each([[['--help']], [['--help', '-q']], [['-r', '--help', 'echo']], [['--hel']], [['--h']]])(
    '--help prints the page where it stands (%j)',
    async (args) => {
      const shell = fakeShell()
      const [out, io] = await handleXargs(shell.fn, args, new EvaluationContext(session), enc('x'))
      const page = decode(await materialize(out))
      expect(
        page.startsWith(
          'xargs: Build and run command lines from standard input.\n\n' +
            'Usage: xargs [OPTION]... COMMAND [INITIAL-ARGS]...\n',
        ),
      ).toBe(true)
      expect(page).toContain('  -P, --max-procs <text>')
      expect(io.exitCode).toBe(0)
      expect(shell.lines).toEqual([])
    },
  )

  it('--version, and a refusal read before --help', async () => {
    const shell = fakeShell()
    let [out, io] = await handleXargs(
      shell.fn,
      ['--version'],
      new EvaluationContext(session),
      enc('x'),
    )
    expect(decode(await materialize(out)).startsWith('xargs (Mirage) ')).toBe(true)
    expect(io.exitCode).toBe(0)
    ;[out, io] = await handleXargs(
      shell.fn,
      ['-n0', '--help'],
      new EvaluationContext(session),
      enc('x'),
    )
    expect(io.exitCode).toBe(1)
    expect(decode(await materialize(io.stderr))).toBe(
      `xargs: value 0 for -n option should be >= 1\n${TRY}`,
    )
    expect(shell.lines).toEqual([])
  })

  it('input words stay single tokens', async () => {
    const shell = fakeShell()
    await handleXargs(shell.fn, ['echo'], new EvaluationContext(session), enc("don\\'t $(reboot)"))
    expect(shell.lines).toEqual(["echo 'don'\\''t' '$(reboot)'"])
  })

  it('removes quotes and backslashes', async () => {
    const shell = fakeShell()
    await handleXargs(
      shell.fn,
      ['-n1', 'echo'],
      new EvaluationContext(session),
      enc('"a b" \'c  d\' e\\ f ""\n'),
    )
    expect(shell.lines).toEqual(["echo 'a b'", "echo 'c  d'", "echo 'e f'", "echo ''"])
  })

  it('an unmatched quote runs the words read, then exits 1', async () => {
    const shell = fakeShell()
    const [, io] = await handleXargs(
      shell.fn,
      ['echo'],
      new EvaluationContext(session),
      enc("a b\nc 'd\n"),
    )
    expect(shell.lines).toEqual(['echo a b c'])
    expect(io.exitCode).toBe(1)
    expect(decode(await materialize(io.stderr))).toBe(
      'xargs: unmatched single quote; by default quotes are special to xargs unless you use the -0 option\n',
    )
  })

  it('-0 keeps empty items', async () => {
    const shell = fakeShell()
    await handleXargs(shell.fn, ['-0', 'echo'], new EvaluationContext(session), enc('a\0\0b\0'))
    expect(shell.lines).toEqual(["echo a '' b"])
  })

  it.each([[['-I{}', 'echo', 'x{}y']], [['-I', '{}', 'echo', 'x{}y']]])(
    '-I runs once per line (%j)',
    async (args) => {
      const shell = fakeShell()
      const [, io] = await handleXargs(
        shell.fn,
        args,
        new EvaluationContext(session),
        enc('a\nb\n'),
      )
      expect(shell.lines).toEqual(['echo xay', 'echo xby'])
      expect(io.exitCode).toBe(0)
    },
  )

  it('-I takes the whole line', async () => {
    const shell = fakeShell()
    await handleXargs(
      shell.fn,
      ['-I{}', 'echo', '[{}]'],
      new EvaluationContext(session),
      enc('one two\n  three  \n\n   \n"a b" c\n'),
    )
    expect(shell.lines).toEqual(["echo '[one two]'", "echo '[three  ]'", "echo '[a b c]'"])
  })

  it('-I substitutes every occurrence but not the name', async () => {
    const shell = fakeShell()
    await handleXargs(
      shell.fn,
      ['-I%', '%', '%', '%-%', 'x%%y'],
      new EvaluationContext(session),
      enc('a\n'),
    )
    expect(shell.lines).toEqual(['% a a-a xaay'])
  })

  it('-I inserts the line verbatim', async () => {
    const shell = fakeShell()
    await handleXargs(
      shell.fn,
      ['-I{}', 'echo', '<{}>'],
      new EvaluationContext(session),
      enc("$&\\'x\n"),
    )
    expect(shell.lines).toEqual(["echo '<$&'\\''x>'"])
  })

  it('-I on empty input runs nothing', async () => {
    const shell = fakeShell()
    const [, io] = await handleXargs(
      shell.fn,
      ['-I{}', 'echo', '{}'],
      new EvaluationContext(session),
      new Uint8Array(),
    )
    expect(shell.lines).toEqual([])
    expect(io.exitCode).toBe(0)
  })

  it('-I with -0 and -d items', async () => {
    const shell = fakeShell()
    await handleXargs(
      shell.fn,
      ['-0', '-I{}', 'echo', '[{}]'],
      new EvaluationContext(session),
      enc('a b\0\0c\0'),
    )
    await handleXargs(
      shell.fn,
      ['-d,', '-I{}', 'echo', '[{}]'],
      new EvaluationContext(session),
      enc('a,b'),
    )
    expect(shell.lines).toEqual([
      "echo '[a b]'",
      "echo '[]'",
      "echo '[c]'",
      "echo '[a]'",
      "echo '[b]'",
    ])
  })

  it('-I failure exits 123 and exit 255 stops', async () => {
    let shell = fakeShell([1, 0])
    let [, io] = await handleXargs(
      shell.fn,
      ['-I{}', 'test', '{}'],
      new EvaluationContext(session),
      enc('a\nb\n'),
    )
    expect(shell.lines).toEqual(['test a', 'test b'])
    expect(io.exitCode).toBe(123)
    shell = fakeShell([255, 0])
    ;[, io] = await handleXargs(
      shell.fn,
      ['-I{}', 'sh', '{}'],
      new EvaluationContext(session),
      enc('a\nb\n'),
    )
    expect(shell.lines).toEqual(['sh a'])
    expect(io.exitCode).toBe(124)
  })

  it('-I stops on an unmatched quote after earlier lines', async () => {
    const shell = fakeShell()
    const [, io] = await handleXargs(
      shell.fn,
      ['-I{}', 'echo', '{}'],
      new EvaluationContext(session),
      enc("a\nb 'c\n"),
    )
    expect(shell.lines).toEqual(['echo a'])
    expect(io.exitCode).toBe(1)
  })

  it('an empty -I string is command too long', async () => {
    const shell = fakeShell()
    const [, io] = await handleXargs(
      shell.fn,
      ['-I', '', 'echo', 'x'],
      new EvaluationContext(session),
      enc('a\n'),
    )
    expect(shell.lines).toEqual([])
    expect(io.exitCode).toBe(1)
    expect(decode(await materialize(io.stderr))).toBe('xargs: command too long\n')
  })

  it.each<[string[], string, string[]]>([
    [['-L', '2', 'echo'], 'a\nb\nc\n', ['echo a b', 'echo c']],
    [['-L2', 'echo'], 'a b\nc d\ne\n', ['echo a b c d', 'echo e']],
    [['-L1', 'echo'], 'a b \nc d\ne\n', ['echo a b c d', 'echo e']],
    [['-L1', 'echo'], 'a\\ \nb\n', ["echo 'a ' b"]],
    [['-L1', 'echo'], 'a\n\n\nb\n', ['echo a', 'echo b']],
    [['-L1', 'echo', 'x'], '\n\n', ['echo x']],
    [['-L1', '-r', 'echo', 'x'], '\n\n', []],
    [['-0', '-L1', 'echo'], 'a b\0c\0', ["echo 'a b'", 'echo c']],
  ])('-L batches input lines (%j)', async (args, data, lines) => {
    const shell = fakeShell()
    const [, io] = await handleXargs(shell.fn, args, new EvaluationContext(session), enc(data))
    expect(shell.lines).toEqual(lines)
    expect(io.exitCode).toBe(0)
  })

  it('-L drops the partial line on an unmatched quote', async () => {
    const shell = fakeShell()
    const [, io] = await handleXargs(
      shell.fn,
      ['-L1', 'echo'],
      new EvaluationContext(session),
      enc("a b\nc 'd\n"),
    )
    expect(shell.lines).toEqual(['echo a b'])
    expect(io.exitCode).toBe(1)
  })

  it.each<[string[], string]>([
    [['-L', '0'], 'xargs: value 0 for -L option should be >= 1\n'],
    [['-L', '-1'], 'xargs: value -1 for -L option should be >= 1\n'],
    [['-L', 'x'], 'xargs: invalid number "x" for -L option\n'],
    [['-L', '2 '], 'xargs: invalid number "2 " for -L option\n'],
    [['-l0'], 'xargs: value 0 for -l option should be >= 1\n'],
    [['--max-lines=x'], 'xargs: invalid number "x" for -l option\n'],
    [['-l1r'], 'xargs: invalid number "1r" for -l option\n'],
    [['-P', 'x'], 'xargs: invalid number "x" for -P option\n'],
    [['-P', '-1'], 'xargs: value -1 for -P option should be >= 0\n'],
    [['-P', '99999999999'], 'xargs: value 99999999999 for -P option should be <= 2147483647\n'],
  ])('counts are refused with the help hint (%j)', async (args, message) => {
    const shell = fakeShell()
    const [, io] = await handleXargs(
      shell.fn,
      [...args, 'echo'],
      new EvaluationContext(session),
      enc('a\n'),
    )
    expect(io.exitCode).toBe(1)
    expect(decode(await materialize(io.stderr))).toBe(message + TRY)
    expect(shell.lines).toEqual([])
  })

  it.each<[string[], string[]]>([
    [
      ['-i', 'echo', 'x{}y'],
      ['echo xay', 'echo xby'],
    ],
    [
      ['-iZ', 'echo', 'xZy'],
      ['echo xay', 'echo xby'],
    ],
    [
      ['--replace', 'echo', 'x{}y'],
      ['echo xay', 'echo xby'],
    ],
    [
      ['--replace=Z', 'echo', 'xZy'],
      ['echo xay', 'echo xby'],
    ],
    [
      ['-i', 'Z', 'x{}'],
      ['Z xa', 'Z xb'],
    ],
    [
      ['-ri', 'echo', '{}'],
      ['echo a', 'echo b'],
    ],
    [
      ['-il', 'echo', '{}'],
      ["echo '{}'", "echo '{}'"],
    ],
    [
      ['-l', 'echo'],
      ['echo a', 'echo b'],
    ],
    [['-l2', 'echo'], ['echo a b']],
    [
      ['--max-lines', 'echo'],
      ['echo a', 'echo b'],
    ],
    [['--max-lines=2', 'echo'], ['echo a b']],
    [
      ['-l', '2'],
      ['2 a', '2 b'],
    ],
  ])('optional-value -i and -l (%j)', async (args, lines) => {
    const shell = fakeShell()
    const [, io] = await handleXargs(shell.fn, args, new EvaluationContext(session), enc('a\nb\n'))
    expect(shell.lines).toEqual(lines)
    expect(io.exitCode).toBe(0)
  })

  it('-P runs side by side and keeps input order', async () => {
    let shell = slowShell({ 'echo a': 50 })
    const [out, io] = await handleXargs(
      shell.fn,
      ['-P2', '-n1', 'echo'],
      new EvaluationContext(session),
      enc('a b c d'),
    )
    expect(shell.lines).toEqual(['echo a', 'echo b', 'echo c', 'echo d'])
    expect(shell.peak()).toBe(2)
    expect(decode(await materialize(out))).toBe('ran:echo a\nran:echo b\nran:echo c\nran:echo d\n')
    expect(io.exitCode).toBe(0)
    shell = slowShell()
    await handleXargs(
      shell.fn,
      ['-P0', '-n1', 'echo'],
      new EvaluationContext(session),
      enc('a b c d'),
    )
    expect(shell.peak()).toBe(4)
    shell = slowShell()
    await handleXargs(shell.fn, ['-n1', 'echo'], new EvaluationContext(session), enc('a b c d'))
    expect(shell.peak()).toBe(1)
  })

  it('-P starts nothing after a command aborts', async () => {
    let shell = slowShell({ 'nope b': 50 }, { 'nope a': 255 })
    let [, io] = await handleXargs(
      shell.fn,
      ['-P2', '-n1', 'nope'],
      new EvaluationContext(session),
      enc('a b c d'),
    )
    expect(shell.lines).toEqual(['nope a', 'nope b'])
    expect(io.exitCode).toBe(124)
    shell = slowShell({}, { 'nope c': 1 })
    ;[, io] = await handleXargs(
      shell.fn,
      ['-P3', '-n1', 'nope'],
      new EvaluationContext(session),
      enc('a b c d'),
    )
    expect(io.exitCode).toBe(123)
  })

  it.each<[string[], string[], [string, string][]]>([
    [['-I{}', '-n1', 'echo', '[{}]'], ["echo '[a b]'", "echo '[c]'"], []],
    [
      ['-n1', '-I{}', 'echo', '[{}]'],
      ["echo '[a b]'", "echo '[c]'"],
      [['--replace/-I/-i', '--max-args']],
    ],
    [
      ['-L2', '-I{}', 'echo', '[{}]'],
      ["echo '[a b]'", "echo '[c]'"],
      [['--replace/-I/-i', '--max-lines']],
    ],
    [['-I{}', '-L2', 'echo', '[{}]'], ["echo '[{}]' a b c"], [['-L', '--replace']]],
    [
      ['-I{}', '-n2', 'echo', '[{}]'],
      ["echo '[{}]' a b", "echo '[{}]' c"],
      [['--max-args/-n', '--replace']],
    ],
    [['-L1', '-n2', 'echo'], ['echo a b', 'echo c'], [['--max-args/-n', '--max-lines']]],
    [['-n2', '-L1', 'echo'], ['echo a b', 'echo c'], [['-L', '--max-args']]],
    [['-n2', '-l', 'echo'], ['echo a b', 'echo c'], [['--max-lines/-l', '--max-args']]],
    [
      ['-i', '-l', 'echo', '{}'],
      ["echo '{}' a b", "echo '{}' c"],
      [['--max-lines/-l', '--replace']],
    ],
    [
      ['-L1', '-n2', '-L1', 'echo'],
      ['echo a b', 'echo c'],
      [
        ['--max-args/-n', '--max-lines'],
        ['-L', '--max-args'],
      ],
    ],
    [
      ['-n1', '-I{}', '-n1', 'echo', '[{}]'],
      ["echo '[a b]'", "echo '[c]'"],
      [['--replace/-I/-i', '--max-args']],
    ],
  ])('-I, -L and -n cancel in order (%j)', async (args, lines, warnings) => {
    const shell = fakeShell()
    const [, io] = await handleXargs(
      shell.fn,
      args,
      new EvaluationContext(session),
      enc('a b\nc\n'),
    )
    expect(shell.lines).toEqual(lines)
    expect(decode(await materialize(io.stderr))).toBe(
      warnings.map(([option, offending]) => warned(option, offending)).join(''),
    )
  })
})

describe('handleTimeout', () => {
  const session = new SessionState({ sessionId: 'test' })

  it('parses duration units', () => {
    expect(parseDuration('1')).toBe(1)
    expect(parseDuration('0.5')).toBe(0.5)
    expect(parseDuration('2s')).toBe(2)
    expect(parseDuration('2m')).toBe(120)
    expect(parseDuration('1h')).toBe(3600)
    expect(parseDuration('1d')).toBe(86400)
    expect(parseDuration('.5')).toBe(0.5)
  })

  it('reads C floats as durations', () => {
    expect(parseDuration('1e-1')).toBe(0.1)
    expect(parseDuration('.1s')).toBe(0.1)
    expect(parseDuration(' 0.1')).toBe(0.1)
    expect(parseDuration('0x1p-3')).toBe(0.125)
    expect(parseDuration('inf')).toBe(Infinity)
    expect(parseDuration('infinitys')).toBe(Infinity)
    expect(parseDuration('-0')).toBe(0)
  })

  it('rejects garbage durations', () => {
    expect(parseDuration('xx')).toBeNull()
    expect(parseDuration('-1')).toBeNull()
    expect(parseDuration('1x')).toBeNull()
    expect(parseDuration('')).toBeNull()
    expect(parseDuration('1ss')).toBeNull()
    expect(parseDuration('1,5')).toBeNull()
    expect(parseDuration('1e')).toBeNull()
    expect(parseDuration('nan')).toBeNull()
  })

  it.each<[string, number | null]>([
    ['TERM', 15],
    ['sigint', 2],
    ['Sigterm', 15],
    ['SIG9', 9],
    ['IOT', 6],
    ['EXIT', 0],
    ['0', 0],
    ['143', 15],
    ['256', 0],
    ['265', 9],
    ['319', 63],
    ['32', 32],
    ['RTMIN', 34],
    ['rtmin+1', 35],
    ['RTMIN 2', 36],
    ['RTMIN+30', 64],
    ['SIGRTMAX', 64],
    ['RTMAX-30', 34],
    ['FOO', null],
    ['', null],
    ['65', null],
    ['193', null],
    ['255', null],
    ['0x9', null],
    ['9x', null],
    ['sig65', null],
    ['RTMIN+31', null],
    ['RTMIN+ 2', null],
    ['RTMAX+1', null],
    ['2147483648', null],
  ])('parses signal %j', (operand, number) => {
    expect(parseSignal(operand)).toBe(number)
  })

  it.each<[number, string]>([
    [15, 'TERM'],
    [6, 'ABRT'],
    [17, 'CHLD'],
    [29, 'POLL'],
    [0, 'EXIT'],
    [32, '32'],
    [34, 'RTMIN'],
    [40, 'RTMIN+6'],
    [49, 'RTMIN+15'],
    [50, 'RTMAX-14'],
    [64, 'RTMAX'],
  ])('names signal %i', (number, name) => {
    expect(signalName(number)).toBe(name)
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

  it('keeps the stderr the command had produced before the deadline', async () => {
    // `tail -F missing` has said it cannot open the file by the time the
    // deadline kills it; that line is the command's output too.
    const complaining = (
      _cmd: string,
      opts: { sessionId: string; signal?: AbortSignal },
    ): Promise<IOResult> =>
      Promise.resolve(
        new IOResult({
          stdout: (async function* () {
            await new Promise<void>((resolve) => {
              opts.signal?.addEventListener(
                'abort',
                () => {
                  resolve()
                },
                { once: true },
              )
            })
            yield new Uint8Array()
          })(),
          stderr: new TextEncoder().encode('tail: nope: No such file or directory\n'),
        }),
      )
    const [stdout, io] = await handleTimeout(complaining, ['0.05', 'tail', '-F', 'nope'], session)
    expect(io.exitCode).toBe(124)
    expect(stdout).toBeNull()
    expect(decode(await materialize(io.stderr))).toBe('tail: nope: No such file or directory\n')
  })

  it('aborts the inner run at the deadline', async () => {
    // A followed tail polls until told to stop; the deadline has to tell
    // it, or 124 comes back while the run keeps reading in the background.
    let seen: AbortSignal | undefined
    const follow = (
      _cmd: string,
      opts: { sessionId: string; signal?: AbortSignal },
    ): Promise<IOResult> =>
      new Promise((resolve) => {
        seen = opts.signal
        opts.signal?.addEventListener(
          'abort',
          () => {
            resolve(new IOResult())
          },
          { once: true },
        )
      })
    const [, io] = await handleTimeout(follow, ['0.05', 'tail', '-f', 'x'], session)
    expect(io.exitCode).toBe(124)
    expect(seen?.aborted).toBe(true)
  })

  it('invalid duration exits 125', async () => {
    const shell = fakeShell()
    const [, io] = await handleTimeout(shell.fn, ['xx', 'sleep', '1'], session)
    expect(io.exitCode).toBe(125)
    expect(decode(await materialize(io.stderr))).toBe(
      `timeout: invalid time interval 'xx'\n${TIMEOUT_TRY}`,
    )
    expect(shell.lines).toEqual([])
  })

  it('missing operand exits 125', async () => {
    const shell = fakeShell()
    const [, io] = await handleTimeout(shell.fn, ['5'], session)
    expect(io.exitCode).toBe(125)
    expect(decode(await materialize(io.stderr))).toBe(TIMEOUT_TRY)
  })

  it.each([
    [['-s'], "timeout: option requires an argument -- 's'\n"],
    [['--signal'], "timeout: option '--signal' requires an argument\n"],
    [['--si'], "timeout: option '--signal' requires an argument\n"],
    [
      ['--=x', '1', 'true'],
      "timeout: option '--=x' is ambiguous; possibilities: '--foreground' '--kill-after' '--preserve-status' '--signal' '--verbose' '--help' '--version'\n",
    ],
    [
      ['--v', '1', 'true'],
      "timeout: option '--v' is ambiguous; possibilities: '--verbose' '--version'\n",
    ],
    [
      ['--preserve-status=x', '1', 'true'],
      "timeout: option '--preserve-status' doesn't allow an argument\n",
    ],
    [['-x', '1', 'true'], "timeout: invalid option -- 'x'\n"],
    [['-s', 'FOO', '1', 'true'], "timeout: 'FOO': invalid signal\n"],
    [['-k', 'x', '1', 'true'], "timeout: invalid time interval 'x'\n"],
  ])('option refusals exit 125 (%j)', async (args, message) => {
    const shell = fakeShell()
    const [, io] = await handleTimeout(shell.fn, args, session)
    expect(io.exitCode).toBe(125)
    expect(decode(await materialize(io.stderr))).toBe(message + TIMEOUT_TRY)
    expect(shell.lines).toEqual([])
  })

  it.each<[string[], number, string]>([
    [['0.05'], 124, ''],
    [['-v', '0.05'], 124, "timeout: sending signal TERM to command 'sleep'\n"],
    [['-p', '0.05'], 143, ''],
    [['-p', '-s', 'INT', '0.05'], 130, ''],
    [['-s', 'KILL', '0.05'], 137, ''],
    [['-p', '-s', 'QUIT', '0.05'], 131, ''],
    [['-s', '32', '0.05'], 160, ''],
    [['-f', '-s', '32', '0.05'], 124, ''],
    [['-f', '-p', '-s', '33', '0.05'], 161, ''],
    [
      ['-v', '-s', 'CONT', '-k', '0.05', '0.05'],
      137,
      "timeout: sending signal CONT to command 'sleep'\ntimeout: sending signal KILL to command 'sleep'\n",
    ],
    [
      ['-v', '-f', '-s', 'STOP', '-k', '0.05', '0.05'],
      137,
      "timeout: sending signal STOP to command 'sleep'\ntimeout: sending signal KILL to command 'sleep'\n",
    ],
    [
      ['-v', '-s', 'CHLD', '-k', '0.05', '0.05'],
      137,
      "timeout: sending signal CHLD to command 'sleep'\ntimeout: sending signal KILL to command 'sleep'\n",
    ],
  ])('signal outcome (%j)', async (args, code, said) => {
    const shell = slowShell({ 'sleep 1': 1000 })
    const [, io, node] = await handleTimeout(shell.fn, [...args, 'sleep', '1'], session)
    expect(io.exitCode).toBe(code)
    expect(node.exitCode).toBe(code)
    expect(decode(await materialize(io.stderr))).toBe(said)
  })

  it.each<[string[], number]>([
    [['-s', 'CONT'], 124],
    [['-s', '0'], 124],
    [['-s', 'TSTP'], 124],
    [['-f', '-s', 'CHLD'], 124],
    [['-p', '-s', 'CONT'], 3],
  ])('ignored signals let the command finish (%j)', async (args, code) => {
    const shell = slowShell({ sh: 200 }, { sh: 3 })
    const [stdout, io] = await handleTimeout(shell.fn, [...args, '0.05', 'sh'], session)
    expect(io.exitCode).toBe(code)
    expect(decode(stdout as Uint8Array)).toBe('ran:sh\n')
  })

  it('a stopped timeout never returns', async () => {
    const shell = slowShell({ sh: 50 })
    const run = handleTimeout(shell.fn, ['-s', 'STOP', '0.01', 'sh'], session)
    const late = new Promise((resolve) =>
      setTimeout(() => {
        resolve('late')
      }, 300),
    )
    expect(await Promise.race([run, late])).toBe('late')
  })

  it('hands the command its stdin', async () => {
    const seen: (ByteSource | null | undefined)[] = []
    const execute = (_line: string, opts: { stdin?: ByteSource | null }): Promise<IOResult> => {
      seen.push(opts.stdin)
      return Promise.resolve(new IOResult())
    }
    const input = new TextEncoder().encode('hi\n')
    await handleTimeout(execute, ['1', 'cat'], session, input)
    expect(seen).toEqual([input])
  })
})

const TIMEOUT_TRY = "Try 'timeout --help' for more information.\n"

function aBC(): Uint8Array {
  return new TextEncoder().encode('a b c')
}

function ab(): Uint8Array {
  return new TextEncoder().encode('a b')
}
