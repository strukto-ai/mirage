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

import { makeVar } from '../../shell/variable.ts'
import { seedVar, sessionView, setAttr } from '../../workspace/session/state.ts'
import { VarAttr } from '../../shell/variable.ts'
import { varsFromEnv } from '../../workspace/session/session.ts'
import { describe, expect, it, vi } from 'vitest'
import { CLISpec } from '../../commands/cli/types.ts'
import { GENERAL_COMMANDS } from '../../commands/builtin/general/index.ts'
import { IOResult, materialize } from '../../io/types.ts'
import type { ByteSource } from '../../io/types.ts'
import { RAMResource } from '../../resource/ram/ram.ts'
import { enoent } from '../../utils/errors.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { byteChar } from '../../shell/bytes.ts'
import { CallStack } from '../../shell/call_stack.ts'
import { ContentType, FileStat, FileType, MountMode } from '../../types.ts'
import { MountRegistry } from '../mount/registry.ts'
import type { MountEntry } from '../mount/mount.ts'
import { Namespace } from '../mount/namespace/namespace.ts'
import { Session } from '../session/session.ts'
import type { ResolveFn } from '../dispatcher/index.ts'
import type { DispatchFn } from './cross_mount.ts'
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
  handleTrap,
  handleUnset,
  handleWhoami,
  handleXargs,
} from './builtins/index.ts'
import { parseDuration } from './builtins/timeout/timeout.ts'
import { ReturnSignal } from './control.ts'

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

const MAN_SESSION = new Session({ sessionId: 'man' })

describe('handleExport / handleUnset / handlePrintenv', () => {
  it('export KEY=VAL sets session env', async () => {
    const s = new Session({ sessionId: 'test' })
    await handleExport(['FOO=bar', 'BAZ=qux'], s, sessionView(s))
    expect(s.env.FOO).toBe('bar')
    expect(s.env.BAZ).toBe('qux')
  })

  it('export KEY (no =) marks it without giving it a value', async () => {
    // bash's third state: declared and exported but *unset*. GNU prints
    // `declare -x Y` with no `=`, and `env` does not carry it at all, so
    // the empty string this used to write was a divergence.
    const s = new Session({ sessionId: 'test', vars: varsFromEnv({ X: 'existing' }) })
    await handleExport(['X', 'Y'], s, sessionView(s))
    expect(s.env.X).toBe('existing')
    expect(s.env.Y).toBeUndefined()
    expect(s.vars.Y?.attrs.has(VarAttr.Export)).toBe(true)
    expect(s.vars.Y?.value).toBeNull()
  })

  it('export -p prints declare -x lines', async () => {
    const s = new Session({ sessionId: 'test', vars: varsFromEnv({ ZZZ: '1', AAA: 'a"b' }) })
    const [out, io] = await handleExport(['-p'], s)
    expect(io.exitCode).toBe(0)
    const text = decode(out as Uint8Array)
    expect(text).toContain('declare -x AAA="a\\"b"\n')
    expect(text).toContain('declare -x ZZZ="1"\n')
    expect(text.indexOf('AAA')).toBeLessThan(text.indexOf('ZZZ'))
  })

  it('bare export prints like -p', async () => {
    const s = new Session({ sessionId: 'test', vars: varsFromEnv({ FOO: 'bar' }) })
    const [out, io] = await handleExport([], s)
    expect(io.exitCode).toBe(0)
    // $PWD is exported like any other variable, so bash lists it here too.
    expect(decode(out as Uint8Array)).toBe('declare -x FOO="bar"\ndeclare -x PWD="/"\n')
  })

  it('export -z is invalid option exit 2', async () => {
    const s = new Session({ sessionId: 'test' })
    const [, io] = await handleExport(['-z'], s)
    expect(io.exitCode).toBe(2)
    expect(decode(io.stderr as Uint8Array)).toContain('invalid option')
    expect(decode(io.stderr as Uint8Array)).toContain('usage: export')
  })

  it('export write without a threaded view is a wiring bug', async () => {
    // The old fallback built an ungated view here, so `export
    // AWS_SECRET_ACCESS_KEY=x` cleared every preSession rule.
    const s = new Session({ sessionId: 'test' })
    await expect(handleExport(['SECRET=x'], s)).rejects.toThrow(/gated session view/)
  })

  it('export -p with a name does not print', async () => {
    const s = new Session({ sessionId: 'test', vars: varsFromEnv({ KEEP: '1' }) })
    const [out, io] = await handleExport(['-p', 'FOO=bar'], s, sessionView(s))
    expect(io.exitCode).toBe(0)
    expect(out).toBeNull()
    expect(s.env.FOO).toBe('bar')
  })

  it('readonly -p prints scalars and arrays', async () => {
    const s = new Session({ sessionId: 'test', vars: varsFromEnv({ VAL: 'x' }) })
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
    const s = new Session({ sessionId: 'test' })
    const [, io] = await handleReadonly(['-z'], s)
    expect(io.exitCode).toBe(2)
    expect(decode(io.stderr as Uint8Array)).toContain('invalid option')
  })

  it('export -p quotes control characters like bash', async () => {
    const s = new Session({
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
    const s = new Session({ sessionId: 'test', vars: varsFromEnv({ FOO: 'bar' }) })
    const [out, io] = await handleExport(['-p', '--'], s)
    expect(io.exitCode).toBe(0)
    expect(decode(out as Uint8Array)).toBe('declare -x FOO="bar"\ndeclare -x PWD="/"\n')
  })

  it('export -f lists no variables', async () => {
    const s = new Session({ sessionId: 'test', vars: varsFromEnv({ FOO: 'bar' }) })
    const [out, io] = await handleExport(['-f'], s)
    expect(io.exitCode).toBe(0)
    expect(decode(out as Uint8Array)).toBe('')
  })

  it('export reports the first invalid option letter', async () => {
    const s = new Session({ sessionId: 'test' })
    const [, io] = await handleExport(['-zq'], s)
    expect(decode(io.stderr as Uint8Array)).toContain('export: -z: invalid option')
    expect(decode(io.stderr as Uint8Array)).not.toContain('-q: invalid option')
  })

  it('readonly -a lists arrays only', async () => {
    const s = new Session({ sessionId: 'test', vars: varsFromEnv({ VAL: 'x' }) })
    setAttr(s, 'VAL', VarAttr.Readonly)
    seedVar(s, 'AR', ['a'])
    setAttr(s, 'AR', VarAttr.Readonly)
    const [out, io] = await handleReadonly(['-a'], s)
    expect(io.exitCode).toBe(0)
    expect(decode(out as Uint8Array)).toBe('declare -ar AR=([0]="a")\n')
  })

  it('readonly -f and -A list nothing', async () => {
    const s = new Session({ sessionId: 'test', vars: varsFromEnv({ VAL: 'x' }) })
    setAttr(s, 'VAL', VarAttr.Readonly)
    for (const flag of ['-f', '-A']) {
      const [out, io] = await handleReadonly([flag], s)
      expect(io.exitCode).toBe(0)
      expect(decode(out as Uint8Array)).toBe('')
    }
  })

  it('unset removes keys', async () => {
    const s = new Session({ sessionId: 'test', vars: varsFromEnv({ A: '1', B: '2' }) })
    await handleUnset(['A'], s, sessionView(s))
    expect('A' in s.env).toBe(false)
    expect(s.env.B).toBe('2')
  })

  it('unset -f removes a function but not a same-named variable', async () => {
    const s = new Session({ sessionId: 'test', vars: varsFromEnv({ fn: 'v' }) })
    s.functions.fn = []
    await handleUnset(['-f', 'fn'], s, sessionView(s))
    expect('fn' in s.functions).toBe(false)
    expect(s.env.fn).toBe('v')
  })

  it('unset -v removes a variable but not a same-named function', async () => {
    const s = new Session({ sessionId: 'test', vars: varsFromEnv({ fn: 'v' }) })
    s.functions.fn = []
    await handleUnset(['-v', 'fn'], s, sessionView(s))
    expect('fn' in s.functions).toBe(true)
    expect('fn' in s.env).toBe(false)
  })

  it('unset bare prefers a variable, else the function', async () => {
    const s = new Session({ sessionId: 'test', vars: varsFromEnv({ a: 'v' }) })
    s.functions.a = []
    await handleUnset(['a'], s, sessionView(s))
    expect('a' in s.env).toBe(false)
    expect('a' in s.functions).toBe(true)
    s.functions.b = []
    await handleUnset(['b'], s, sessionView(s))
    expect('b' in s.functions).toBe(false)
  })

  it('unset removes a whole array and a single element', async () => {
    const s = new Session({ sessionId: 'test' })
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
    const s = new Session({ sessionId: 'test' })
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
    const s = new Session({ sessionId: 'test', vars: varsFromEnv({ Y: 'sc', Z: 'sc' }) })
    const [, io] = await handleUnset(['Y[0]'], s, sessionView(s))
    expect(io.exitCode).toBe(0)
    expect('Y' in s.env).toBe(false)
    const [, io2] = await handleUnset(['Z[1]'], s, sessionView(s))
    expect(io2.exitCode).toBe(1)
    expect(decode(io2.stderr as Uint8Array)).toBe('bash: unset: Z: not an array variable\n')
    expect(s.env.Z).toBe('sc')
  })

  it('unset of a negative element outside the extent errors', async () => {
    const s = new Session({ sessionId: 'test' })
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
    const s = new Session({ sessionId: 'test' })
    const [, io] = await handleUnset(['GONE[3]'], s, sessionView(s))
    expect(io.exitCode).toBe(0)
  })

  it('unset -z is an invalid option (exit 2)', async () => {
    const s = new Session({ sessionId: 'test' })
    const [, io] = await handleUnset(['-z', 'x'], s, sessionView(s))
    expect(io.exitCode).toBe(2)
  })

  it('printenv VAR emits value + newline; exit 1 if missing', () => {
    const s = new Session({ sessionId: 'test', vars: varsFromEnv({ X: 'yes' }) })
    const [out, io] = handlePrintenv('X', s)
    expect(decode(out as Uint8Array)).toBe('yes\n')
    expect(io.exitCode).toBe(0)
    const [, io2] = handlePrintenv('MISSING', s)
    expect(io2.exitCode).toBe(1)
  })

  it('printenv with no name lists sorted KEY=VAL', () => {
    const s = new Session({ sessionId: 'test', vars: varsFromEnv({ B: '2', A: '1' }) })
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

  it('-e \\c stops output at that point', () => {
    const [out] = handleEcho(['-e', 'hi\\cgone'])
    expect(decode(out as Uint8Array)).toBe('hi\n')
  })

  it('-e reads \\xHH and \\0NNN as bytes', () => {
    const bytes = (args: string[]): number[] => [...(handleEcho(args)[0] as Uint8Array)]
    expect(bytes(['-ne', '\\xff'])).toEqual([0xff])
    expect(bytes(['-ne', '\\0377'])).toEqual([0xff])
    expect(bytes(['-ne', '\\xc3\\xa9'])).toEqual([0xc3, 0xa9])
  })
})

describe('handlePrintf', () => {
  const run = async (args: string[]): Promise<[string, number]> => {
    const [out, io] = await handlePrintf(args, new Session({ sessionId: 'test' }))
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
      ...(((await handlePrintf(args, new Session({ sessionId: 'test' })))[0] ?? []) as Uint8Array),
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

  it('empty args → empty output', async () => {
    const [out] = await handlePrintf([], new Session({ sessionId: 'test' }))
    expect((out as Uint8Array).byteLength).toBe(0)
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
    const s = new Session({ sessionId: 'test' })
    const [out, io] = await handlePrintf(['-v', 'V', 'x=%d', '42'], s)
    expect(out).toBeNull()
    expect(io.exitCode).toBe(0)
    expect(s.env.V).toBe('x=42')
  })

  it('-v targets an array element', async () => {
    const s = new Session({ sessionId: 'test' })
    const [, io] = await handlePrintf(['-v', 'arr[2]', 'hi'], s)
    expect(io.exitCode).toBe(0)
    // Indices 0 and 1 are holes, not empty elements.
    expect(s.arrays.arr).toEqual([null, null, 'hi'])
  })

  it('-v with an invalid name errors before the format runs', async () => {
    const s = new Session({ sessionId: 'test' })
    const [, io] = await handlePrintf(['-v', '1bad', 'x'], s)
    expect(io.exitCode).toBe(2)
    expect(decode(io.stderr as Uint8Array)).toBe("printf: `1bad': not a valid identifier\n")
    const [, io2] = await handlePrintf(['-v', '1bad', '%d', 'nope'], s)
    expect(io2.exitCode).toBe(2)
    expect(decode(io2.stderr as Uint8Array)).toBe("printf: `1bad': not a valid identifier\n")
  })

  it('-v rejects an empty subscript but allows a blank one', async () => {
    const s = new Session({ sessionId: 'test' })
    const [, io] = await handlePrintf(['-v', 'a[]', 'x'], s)
    expect(io.exitCode).toBe(2)
    expect(decode(io.stderr as Uint8Array)).toBe("printf: `a[]': not a valid identifier\n")
    expect('a' in s.arrays).toBe(false)
    // `a[ ]` is a valid arithmetic 0, not an empty subscript.
    const [, io2] = await handlePrintf(['-v', 'a[ ]', 'x'], s)
    expect(io2.exitCode).toBe(0)
    expect(s.arrays.a).toEqual(['x'])
  })

  it('-v refuses a readonly scalar and a readonly array element', async () => {
    const s = new Session({ sessionId: 'test', vars: varsFromEnv({ R: 'orig' }) })
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
      'printf: nope: invalid number\nbash: A: readonly variable\n',
    )
    expect(s.arrays.A).toEqual(['x', 'y'])
  })

  it('-v on a bare name keeps the other elements of an existing array', async () => {
    const s = new Session({ sessionId: 'test' })
    seedVar(s, 'B', ['p', 'q', 'r'])
    const [, io] = await handlePrintf(['-v', 'B', 'Q'], s)
    expect(io.exitCode).toBe(0)
    expect(s.arrays.B).toEqual(['Q', 'q', 'r'])
    expect('B' in s.env).toBe(false)
  })

  it('-v with an out-of-range subscript keeps the scalar', async () => {
    const s = new Session({ sessionId: 'test', vars: varsFromEnv({ V: 'orig' }) })
    const [, io] = await handlePrintf(['-v', 'V[-2]', 'hi'], s)
    expect(io.exitCode).toBe(1)
    expect(decode(io.stderr as Uint8Array)).toBe('bash: V[-2]: bad array subscript\n')
    expect(s.env.V).toBe('orig')
    expect('V' in s.arrays).toBe(false)
  })

  it('-v with a negative subscript wraps over the scalar', async () => {
    const s = new Session({ sessionId: 'test', vars: varsFromEnv({ W: 'orig' }) })
    const [, io] = await handlePrintf(['-v', 'W[-1]', 'hi'], s)
    expect(io.exitCode).toBe(0)
    expect(s.arrays.W).toEqual(['hi'])
    expect('W' in s.env).toBe(false)
  })

  it('-v on __proto__ makes a real variable instead of touching the prototype', async () => {
    const s = new Session({ sessionId: 'test' })
    expect((await handlePrintf(['-v', '__proto__[0]', 'hi'], s))[1].exitCode).toBe(0)
    expect(Object.hasOwn(s.arrays, '__proto__')).toBe(true)
    // Session records are null-prototype (ownRecord), so there is no
    // prototype to corrupt in the first place.
    expect(Object.getPrototypeOf(s.arrays)).toBe(null)
    expect(({} as Record<string, unknown>)[0]).toBeUndefined()
  })

  it('-v keeps exit 1 on a bad number but still assigns', async () => {
    const s = new Session({ sessionId: 'test' })
    const [, io] = await handlePrintf(['-v', 'V', '%d', 'notanum'], s)
    expect(io.exitCode).toBe(1)
    expect(s.env.V).toBe('0')
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
        new FileStat({ name: 'file', type: FileType.FILE, content: ContentType.TEXT }),
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
    Promise.resolve<[unknown, IOResult]>([
      new FileStat({ name: 'x', type: FileType.FILE }),
      new IOResult(),
    ]),
  )
  const session = new Session({ sessionId: 'test' })
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
    const s = new Session({ sessionId: 'test' })
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
    const s = new Session({ sessionId: 'test' })
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
    const s = new Session({ sessionId: 'test' })
    s.cwd = '/data'
    const [, io] = await handleTest(spy, testNamespace(), ['-d', 'sub'], s)
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

describe('handleGetopts', () => {
  it('single flag sets var and advances OPTIND', async () => {
    const s = new Session({ sessionId: 't' })
    const [, io] = await handleGetopts(['ab', 'o', '-a'], s, null, sessionView(s))
    expect(io.exitCode).toBe(0)
    expect(s.env.o).toBe('a')
    expect(s.env.OPTIND).toBe('2')
  })

  it('iterates two flags then stops', async () => {
    const s = new Session({ sessionId: 't' })
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
    const s = new Session({ sessionId: 't' })
    const [, io] = await handleGetopts(['a:b', 'o', '-a', 'foo', '-b'], s, null, sessionView(s))
    expect(io.exitCode).toBe(0)
    expect(s.env.o).toBe('a')
    expect(s.env.OPTARG).toBe('foo')
    expect(s.env.OPTIND).toBe('3')
  })

  it('attached optarg', async () => {
    const s = new Session({ sessionId: 't' })
    const [, io] = await handleGetopts(['a:', 'o', '-afoo'], s, null, sessionView(s))
    expect(io.exitCode).toBe(0)
    expect(s.env.o).toBe('a')
    expect(s.env.OPTARG).toBe('foo')
    expect(s.env.OPTIND).toBe('2')
  })

  it('combined flags share OPTIND until the word is done', async () => {
    const s = new Session({ sessionId: 't' })
    const args = ['abc', 'o', '-abc']
    await handleGetopts(args, s, null, sessionView(s))
    expect([s.env.o, s.env.OPTIND]).toEqual(['a', '1'])
    await handleGetopts(args, s, null, sessionView(s))
    expect([s.env.o, s.env.OPTIND]).toEqual(['b', '1'])
    await handleGetopts(args, s, null, sessionView(s))
    expect([s.env.o, s.env.OPTIND]).toEqual(['c', '2'])
  })

  it('invalid option, non-silent', async () => {
    const s = new Session({ sessionId: 't' })
    const [, io] = await handleGetopts(['ab', 'o', '-x'], s, null, sessionView(s))
    expect(io.exitCode).toBe(0)
    expect(s.env.o).toBe('?')
    expect(decode(io.stderr as Uint8Array)).toBe('bash: illegal option -- x\n')
    expect(s.env.OPTIND).toBe('2')
  })

  it('invalid option, silent → OPTARG set, no stderr', async () => {
    const s = new Session({ sessionId: 't' })
    const [, io] = await handleGetopts([':ab', 'o', '-x'], s, null, sessionView(s))
    expect(io.exitCode).toBe(0)
    expect(s.env.o).toBe('?')
    expect(s.env.OPTARG).toBe('x')
    expect(io.stderr).toBeNull()
  })

  it('missing arg, non-silent', async () => {
    const s = new Session({ sessionId: 't' })
    const [, io] = await handleGetopts(['a:', 'o', '-a'], s, null, sessionView(s))
    expect(io.exitCode).toBe(0)
    expect(s.env.o).toBe('?')
    expect(decode(io.stderr as Uint8Array)).toBe('bash: option requires an argument -- a\n')
  })

  it('missing arg, silent → name ":" and OPTARG', async () => {
    const s = new Session({ sessionId: 't' })
    const [, io] = await handleGetopts([':a:', 'o', '-a'], s, null, sessionView(s))
    expect(io.exitCode).toBe(0)
    expect(s.env.o).toBe(':')
    expect(s.env.OPTARG).toBe('a')
    expect(io.stderr).toBeNull()
  })

  it('non-option word stops without advancing', async () => {
    const s = new Session({ sessionId: 't' })
    const [, io] = await handleGetopts(['ab', 'o', 'foo', '-a'], s, null, sessionView(s))
    expect(io.exitCode).toBe(1)
    expect(s.env.OPTIND).toBe('1')
  })

  it('double dash is consumed then stops', async () => {
    const s = new Session({ sessionId: 't' })
    const [, io] = await handleGetopts(['ab', 'o', '--', '-a'], s, null, sessionView(s))
    expect(io.exitCode).toBe(1)
    expect(s.env.OPTIND).toBe('2')
  })

  it('no args stops', async () => {
    const s = new Session({ sessionId: 't' })
    const [, io] = await handleGetopts(['ab', 'o'], s, null, sessionView(s))
    expect(io.exitCode).toBe(1)
    expect(s.env.OPTIND).toBe('1')
  })

  it('reads positional args when no explicit args', async () => {
    const s = new Session({ sessionId: 't', positionalArgs: ['-a', '-b'] })
    const [, io] = await handleGetopts(['ab', 'o'], s, null, sessionView(s))
    expect(io.exitCode).toBe(0)
    expect(s.env.o).toBe('a')
  })

  it('usage error on too few operands', async () => {
    const s = new Session({ sessionId: 't' })
    const [, io] = await handleGetopts(['ab'], s, null, sessionView(s))
    expect(io.exitCode).toBe(2)
    expect(decode(io.stderr as Uint8Array)).toBe('getopts: usage: getopts optstring name [arg]\n')
  })

  it('OPTIND reset reparses', async () => {
    const s = new Session({ sessionId: 't', positionalArgs: ['-a', '-b'] })
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
    const s = new Session({ sessionId: 't' })
    await handleGetopts(['ab', 'o', '-ab'], s, null, sessionView(s))
    const [, io] = await handleGetopts(['ab', 'o', '-a'], s, null, sessionView(s))
    expect(io.exitCode).toBe(0)
    expect(s.env.o).toBe('a')
    expect(s.env.OPTIND).toBe('2')
  })

  it('treats a nonpositive OPTIND as a restart at argument 1', async () => {
    const s = new Session({ sessionId: 't', positionalArgs: ['-a', '-b'] })
    seedVar(s, 'OPTIND', '0')
    const [, io] = await handleGetopts(['ab', 'o'], s, null, sessionView(s))
    expect(io.exitCode).toBe(0)
    expect(s.env.o).toBe('a')
    expect(s.env.OPTIND).toBe('2')
  })

  it('rejects an invalid destination identifier', async () => {
    const s = new Session({ sessionId: 't' })
    const [, io] = await handleGetopts(['a', 'bad-name', '-a'], s, null, sessionView(s))
    expect(io.exitCode).toBe(1)
    expect(decode(io.stderr as Uint8Array)).toContain('not a valid identifier')
    expect(s.env['bad-name']).toBeUndefined()
  })

  it('does not overwrite a readonly destination', async () => {
    const s = new Session({
      sessionId: 't',
      vars: { o: makeVar('orig', new Set([VarAttr.Readonly])) },
    })
    const [, io] = await handleGetopts(['a', 'o', '-a'], s, null, sessionView(s))
    expect(io.exitCode).toBe(1)
    expect(s.env.o).toBe('orig')
    expect(decode(io.stderr as Uint8Array)).toContain('readonly variable')
  })

  it('suppresses diagnostics when OPTERR=0', async () => {
    const s = new Session({ sessionId: 't', vars: varsFromEnv({ OPTERR: '0' }) })
    const [, io] = await handleGetopts(['ab', 'o', '-x'], s, null, sessionView(s))
    expect(s.env.o).toBe('?')
    expect(io.stderr ?? null).toBeNull()
  })

  it('scans the function frame positional parameters', async () => {
    const s = new Session({ sessionId: 't' })
    const cs = new CallStack()
    cs.push(['-a', '-b'], 'f')
    await handleGetopts(['ab', 'o'], s, cs, sessionView(s))
    expect(s.env.o).toBe('a')
    await handleGetopts(['ab', 'o'], s, cs, sessionView(s))
    expect(s.env.o).toBe('b')
  })

  it('propagates the cursor across fork()', async () => {
    const s = new Session({ sessionId: 't' })
    await handleGetopts(['ab', 'o', '-ab'], s, null, sessionView(s))
    const forked = s.fork()
    expect(forked.getoptsPos).toBe(s.getoptsPos)
    expect(forked.getoptsOptind).toBe(s.getoptsOptind)
  })
})

describe('handleSet', () => {
  it('no args → print env', () => {
    const s = new Session({ sessionId: 'test', vars: varsFromEnv({ A: '1' }) })
    const [out] = handleSet([], s)
    expect(decode(out as Uint8Array)).toBe('A=1\nPWD=/\n')
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
    const s = new Session({ sessionId: 'test' })
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
    const s = new Session({ sessionId: 'test' })
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
    const s = new Session({ sessionId: 'test' })
    const [, io] = handleReturn([], s, new CallStack())
    expect(io.exitCode).toBe(2)
    expect(decode(await materialize(io.stderr))).toContain("can only `return'")
  })

  it('return in a sourced script raises the signal', () => {
    const s = new Session({ sessionId: 'test' })
    s.sourceDepth = 1
    expect(() => handleReturn([], s, null)).toThrow(ReturnSignal)
  })

  it('handleLocal outside a function is refused, as GNU refuses it', async () => {
    // `bash: line 1: local: can only be used in a function`, exit 1 and
    // nothing stored. Storing it globally and exiting 0 is the
    // silent-accept this tier removes.
    const s = new Session({ sessionId: 'test' })
    const [, io] = await handleLocal(['X=1'], s, sessionView(s))
    expect(io.exitCode).toBe(1)
    expect(s.env.X).toBeUndefined()
  })

  it('handleLocal assigns to session.env under the declare spelling', async () => {
    const s = new Session({ sessionId: 'test' })
    await handleLocal(['X=1'], s, sessionView(s), null, 'declare')
    expect(s.env.X).toBe('1')
  })
})

describe('handleRead', () => {
  it('reads single line into one variable', async () => {
    const s = new Session({ sessionId: 'test' })
    const stdin = new TextEncoder().encode('hello world\nrest\n')
    const [, io] = await handleRead(['LINE'], s, stdin, sessionView(s))
    expect(io.exitCode).toBe(0)
    expect(s.env.LINE).toBe('hello world')
  })

  it('splits whitespace across multiple variables', async () => {
    const s = new Session({ sessionId: 'test' })
    const stdin = new TextEncoder().encode('alice 30 engineer\n')
    await handleRead(['NAME', 'AGE', 'ROLE'], s, stdin, sessionView(s))
    expect(s.env.NAME).toBe('alice')
    expect(s.env.AGE).toBe('30')
    expect(s.env.ROLE).toBe('engineer')
  })

  it('last variable absorbs remainder', async () => {
    const s = new Session({ sessionId: 'test' })
    const stdin = new TextEncoder().encode('one two three four five\n')
    await handleRead(['A', 'B', 'C'], s, stdin, sessionView(s))
    expect(s.env.A).toBe('one')
    expect(s.env.B).toBe('two')
    expect(s.env.C).toBe('three four five')
  })

  it('EOF / null stdin: assign empty + exit 1', async () => {
    const s = new Session({ sessionId: 'test' })
    const [, io] = await handleRead(['X', 'Y'], s, null, sessionView(s))
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
    await handleRead(['L'], s, gen(), sessionView(s))
    expect(s.env.L).toBe('streamed line')
  })

  it('a NEW stdin source replaces a stale exhausted buffer', async () => {
    const s = new Session({ sessionId: 'test' })
    const first = new TextEncoder().encode('first\n')
    await handleRead(['X'], s, first, sessionView(s))
    await handleRead(['X2'], s, first, sessionView(s))
    expect(s.env.X2).toBe('')
    const second = new TextEncoder().encode('second\n')
    const [, io] = await handleRead(['Y'], s, second, sessionView(s))
    expect(io.exitCode).toBe(0)
    expect(s.env.Y).toBe('second')
  })

  it('the SAME stdin source keeps advancing through lines', async () => {
    const s = new Session({ sessionId: 'test' })
    const shared = new TextEncoder().encode('a\nb\n')
    await handleRead(['P'], s, shared, sessionView(s))
    await handleRead(['Q'], s, shared, sessionView(s))
    expect(s.env.P).toBe('a')
    expect(s.env.Q).toBe('b')
  })

  it('a scalar read replaces an array of the same name', async () => {
    const s = new Session({ sessionId: 'test' })
    seedVar(s, 'A', ['x', 'y'])
    const stdin = new TextEncoder().encode('one\n')
    await handleRead(['A'], s, stdin, sessionView(s))
    expect(s.env.A).toBe('one')
    expect(s.arrays.A).toBeUndefined()
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
    const dispatch = vi.fn(() => Promise.reject(enoent('/missing.sh'))) as unknown as DispatchFn
    const executeFn = vi.fn(() => Promise.resolve(new IOResult()))
    const [, io] = await handleSource(dispatch, executeFn, '/missing.sh', s)
    expect(io.exitCode).toBe(1)
    expect(decode(io.stderr instanceof Uint8Array ? io.stderr : null)).toBe(
      'source: /missing.sh: No such file or directory\n',
    )
    expect(executeFn).not.toHaveBeenCalled()
  })

  it('propagates a failure that is not a filesystem error', async () => {
    const s = new Session({ sessionId: 'test', cwd: '/' })
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
    const s = new Session({ sessionId: 'test', cwd: '/', positionalArgs: ['P1', 'P2'] })
    const dispatch = vi.fn(() => {
      const data = new TextEncoder().encode('echo hi\n')
      return Promise.resolve([data, new IOResult()] as [Uint8Array, IOResult])
    }) as unknown as DispatchFn
    let seen: string[] = []
    const executeFn = vi.fn((_script: string, _opts: { sessionId: string }) => {
      seen = [...s.positionalArgs]
      return Promise.resolve(new IOResult())
    })
    await handleSource(dispatch, executeFn, '/script.sh', s, ['AA', 'BB'])
    expect(seen).toEqual(['AA', 'BB'])
    expect(s.positionalArgs).toEqual(['P1', 'P2'])
  })
})

describe('handleMan', () => {
  it('renders header and description for a known command, no resource section', async () => {
    const reg = new MountRegistry({ '/ram/': new RAMResource() }, MountMode.WRITE)
    wireRegistry(reg)
    const [out, io] = handleMan(['date'], reg, MAN_SESSION)
    expect(io.exitCode).toBe(0)
    const body = await readBody(out)
    expect(body.startsWith('# date\n\n')).toBe(true)
    expect(body).not.toContain('RESOURCES')
    expect(body).not.toMatch(/^- general$/m)
  })

  it('renders OPTIONS table when the spec has options', async () => {
    const reg = new MountRegistry({ '/ram/': new RAMResource() }, MountMode.WRITE)
    wireRegistry(reg)
    const [out, io] = handleMan(['date'], reg, MAN_SESSION)
    expect(io.exitCode).toBe(0)
    const body = await readBody(out)
    expect(body).toContain('## OPTIONS')
    expect(body).toContain('| short | long | value | description |')
  })

  it('renders one page however many mounts register the name', async () => {
    const reg = new MountRegistry(
      { '/ram-a/': new RAMResource(), '/ram-b/': new RAMResource() },
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
    const reg = new MountRegistry({ '/ram/': new RAMResource() }, MountMode.WRITE)
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
    const reg = new MountRegistry({ '/ram/': new RAMResource() }, MountMode.WRITE)
    wireRegistry(reg)
    const [, io] = handleMan(['definitely-not-a-real-command-xyz'], reg, MAN_SESSION)
    expect(io.exitCode).toBe(1)
    const errBytes = io.stderr instanceof Uint8Array ? io.stderr : null
    expect(decode(errBytes)).toContain('no entry for definitely-not-a-real-command-xyz')
  })

  it('lists every command once under # commands, sorted, with no resource sections', async () => {
    const reg = new MountRegistry(
      { '/ram-a/': new RAMResource(), '/ram-b/': new RAMResource() },
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
    const reg = new MountRegistry({ '/ram/': new RAMResource() }, MountMode.WRITE)
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
    expect(text).toContain('Usage: linear')
    expect(text).toContain('issue')
  })

  it('descends a verb path and resolves aliases', async () => {
    const reg = cliRegistry()
    const text = await readBody(handleMan(['linear', 'issue', 'create'], reg, MAN_SESSION)[0])
    expect(text).toContain('Usage: linear issue create')
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
    const s = new Session({ sessionId: 'test' })
    const cs = new CallStack()
    cs.push([], 'f')
    try {
      handleReturn(['x'], s, cs)
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
    const [, io] = await handleRead(['-r', 'v'], s, stdin, sessionView(s))
    expect(io.exitCode).toBe(0)
    expect(s.env.v).toBe('hello world')
    expect('-r' in s.env).toBe(false)
  })

  it('unknown option errors like bash', async () => {
    const s = new Session({ sessionId: 'test' })
    const [, io] = await handleRead(['-q', 'v'], s, new TextEncoder().encode('x\n'), sessionView(s))
    expect(io.exitCode).toBe(2)
    expect(decode(await materialize(io.stderr))).toBe('read: -q: invalid option\n')
  })

  it('defaults to REPLY', async () => {
    const s = new Session({ sessionId: 'test' })
    await handleRead([], s, new TextEncoder().encode('hi\n'), sessionView(s))
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
