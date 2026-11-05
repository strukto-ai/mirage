import { describe, expect, it } from 'vitest'
import { materialize } from '../../io/types.ts'
import { MountMode } from '../../types.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { Workspace } from '../workspace/workspace.ts'
import { argsBytes, entryBytes } from './budget.ts'
import { MAX_ENV } from './constants.ts'

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
    expect(argsBytes(['ab', 'c'])).toBe(3)
    expect(entryBytes('a', ['xy', null, 'z'])).toBe(4)
    expect(entryBytes('m', { k: 'vv' })).toBe(4)
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
