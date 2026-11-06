import { describe, expect, it } from 'vitest'
import { materialize } from '../../io/types.ts'
import { MountMode } from '../../types.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { Workspace } from '../workspace/workspace.ts'
import { argsBytes, entryBytes } from './budget.ts'
import { MAX_ENV } from './constants.ts'
import { ShellArray } from '../../shell/array.ts'

const DEC = new TextDecoder()

async function run(
  line: string,
  maxEnv: number | string | null = 200,
): Promise<[string, string, number]> {
  const ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE, maxEnv })
  try {
    const io = await ws.shell(line)
    return [DEC.decode(io.stdout), DEC.decode(await materialize(io.stderr)), io.exitCode]
  } finally {
    await ws.close()
  }
}

describe('max_env', () => {
  it('counts each entry in UTF-8 bytes', () => {
    expect(entryBytes('a', 'é')).toBe(3)
    expect(argsBytes(['ab', 'c'])).toBe(5)
    expect(argsBytes([''])).toBe(1)
    expect(
      entryBytes(
        'a',
        new ShellArray([
          [0, 'xy'],
          [2, 'z'],
        ]),
      ),
    ).toBe(6)
    expect(entryBytes('m', { k: 'vv' })).toBe(5)
  })

  it('stops the line at a variable that doubles past it', async () => {
    const [out, err, code] = await run('x=a; while :; do x=$x$x; done; echo after')
    expect([out, code]).toEqual(['', 2])
    expect(err).toBe(
      'bash: xmalloc: cannot allocate 257 bytes (past max_env of 200 bytes, a mirage workspace setting)\n',
    )
  })

  it('counts functions, aliases and positional parameters too', async () => {
    const body = 'x'.repeat(300)
    for (const line of [`f() { echo ${body}; }`, `alias a='${body}'`, `set -- ${body}`]) {
      const [, err, code] = await run(`${line}; echo after`)
      expect(code).toBe(2)
      expect(err).toContain('past max_env of 200 bytes')
    }
  })

  it('ends a subshell alone, and the variable keeps its value', async () => {
    const [out, , code] = await run('x=ab; (x=$(printf %0300d 0); echo no); echo sub=$? ${#x}')
    expect([out, code]).toEqual(['sub=2 2\n', 0])
  })

  it('lets the state grow when lifted', async () => {
    const [out, , code] = await run(
      'x=a; for i in 1 2 3 4 5 6 7 8 9 10; do x=$x$x; done; echo ${#x}',
      null,
    )
    expect([out, code]).toEqual(['1024\n', 0])
    expect(MAX_ENV).toBe(1 << 21)
  })

  it('counts fresh names that hold no value', async () => {
    const names = Array.from({ length: 100 }, (_, i) => `n${String(i)}`)
    for (const line of [
      `alias ${names.map((name) => `${name}=`).join(' ')};`,
      `export ${names.join(' ')};`,
    ]) {
      const [, err, code] = await run(`${line} echo after`)
      expect(code).toBe(2)
      expect(err).toContain('past max_env of 200 bytes')
    }
  })

  it('counts the arguments a call or source passes', async () => {
    for (const line of [
      'FUNCNEST=30; f() { f "$@" "$@"; }; f aaaaaaaa',
      `FUNCNEST=30; f() { f "$@" "$@"; }; f ''`,
      `echo 'source /s "$@" "$@"' > /s; source /s aaaaaaaa`,
      `set -- aaaaaaaa; echo 'source /s' > /s; source /s`,
    ]) {
      const [, err, code] = await run(line)
      expect(code).toBe(2)
      expect(err).toContain('past max_env of 200 bytes')
    }
  })

  it("counts a nested shell's arguments, and the nested shell dies alone", async () => {
    const refused = await run(`bash -c 'set -- $(seq 1 100)'; echo rc=$?`)
    expect(refused).toEqual([
      'rc=2\n',
      'bash: xmalloc: cannot allocate 292 bytes (past max_env of 200 bytes, a mirage workspace setting)\n',
      0,
    ])
    expect(await run('bash -c : _ $(seq 1 100); echo rc=$?')).toEqual(refused)
    const [kept, , keptCode] = await run('set -- p q; bash -c : _ $(seq 1 100); echo rc=$? $# $1')
    expect([kept, keptCode]).toEqual(['rc=2 2 p\n', 0])
    const [out, err, code] = await run(
      `echo '[ $# -ge 100 ] && { echo reached; exit; }; bash /x.sh "$@" "$@"' > /x.sh; bash /x.sh aaaaaaaa; echo rc=$?`,
    )
    expect([out, code]).toEqual(['rc=2\n', 0])
    expect(err).toContain('past max_env of 200 bytes')
  })

  it('counts a prefix assignment', async () => {
    for (const [line, bytes] of [
      [
        'f() { [ ${#X} -ge 1000 ] && { echo reached; return; }; X="$X$X" f; }; X=aaaaaaaa f; echo after',
        65,
      ],
      ['X=$(seq 1 100) eval :; echo after', 292],
    ] as const) {
      expect(await run(line)).toEqual([
        '',
        `bash: xmalloc: cannot allocate ${String(bytes)} bytes (past max_env of 200 bytes, a mirage workspace setting)\n`,
        2,
      ])
    }
  })

  it('counts the value a prefix sets aside', async () => {
    for (const [line, bytes] of [
      [`X=$(printf %0100d 0); X= eval 'Y=$(printf %0100d 0)'; echo after`, 101],
      ['X=$(printf %0100d 0); f() { Y=$(printf %0100d 0); }; X= f; echo after', 101],
      ['X=$(printf %0100d 0); X=$(printf %099d 0) eval :; echo after', 100],
    ] as const) {
      expect(await run(line)).toEqual([
        '',
        `bash: xmalloc: cannot allocate ${String(bytes)} bytes (past max_env of 200 bytes, a mirage workspace setting)\n`,
        2,
      ])
    }
  })

  it('stops counting the set-aside value once the prefix is restored', async () => {
    const [out, , code] = await run('X=$(printf %0100d 0); X= eval :; Y=$(printf %050d 0); echo ok')
    expect([out, code]).toEqual(['ok\n', 0])
  })

  it('runs a nested shell and a prefix under it', async () => {
    const [out, , code] = await run(
      `set -- p q; bash -c 'echo $# $1' _ a b c; echo $# $1; f() { bash -c 'echo $#' _ a b; echo $#; }; f x y z; X=ab bash -c 'echo $X'; X=cd eval 'echo $X'; echo \${X-unset}`,
    )
    expect([out, code]).toEqual(['3 a\n2 p\n2\n3\nab\ncd\nunset\n', 0])
  })

  it('leaves no value behind from a refused prefix', async () => {
    const ws = new Workspace({ '/': new RAMVFS() }, { mode: MountMode.WRITE, maxEnv: 200 })
    try {
      await ws.shell('A=1 B=$(seq 1 100) eval :')
      const io = await ws.shell('echo ${A-unset} ${B-unset}')
      expect(DEC.decode(io.stdout)).toBe('unset unset\n')
    } finally {
      await ws.close()
    }
  })

  it("counts a function's own parameters", async () => {
    const [out, , code] = await run(
      '(f() { set -- a; while :; do set -- $1$1; done; }; f); echo rc=$?',
    )
    expect([out, code]).toEqual(['rc=2\n', 0])
  })

  it('refuses a session that would start past it', async () => {
    expect(
      () => new Workspace({ '/': new RAMVFS() }, { env: { X: 'x'.repeat(300) }, maxEnv: 200 }),
    ).toThrow('past max_env of 200 bytes')
    const ws = new Workspace(
      { '/': new RAMVFS() },
      { maxEnv: 200, profiles: { big: { env: { X: 'x'.repeat(300) } } } },
    )
    try {
      expect(() => ws.createSession('agent', { profile: 'big' })).toThrow(
        'past max_env of 200 bytes',
      )
      expect(ws.listSessions().map((s) => s.sessionId)).not.toContain('agent')
    } finally {
      await ws.close()
    }
  })
})
