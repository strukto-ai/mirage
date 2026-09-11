import { afterEach, describe, expect, it } from 'vitest'
import { PrefixResolver } from '../runtime/resolver.ts'
import { ScriptSource } from '../runtime/routing/types.ts'
import type { BridgeDispatchFn } from '../runtime/types.ts'
import { ContentType, FileStat, FileType, PathSpec } from '../types.ts'
import type { Policy } from './base.ts'
import { DEFAULT_ASK_REASON, DEFAULT_DENY_REASON } from './constants.ts'
import { Policies } from './policies.ts'
import {
  ScriptPolicy,
  definedHooks,
  hookCall,
  hookProbe,
  opsScriptContext,
  scriptAction,
  scriptContext,
  sessionScriptContext,
} from './script.ts'
import type { CommandContext, OpsContext, ProfileScript, SessionContext } from './types.ts'

// A policy is a program defining the hook it answers at, the way a
// coded Policy does, and it answers with return.
const JUDGE = `\
function preCommand(ctx) {
  const c = ctx.command
  if (c.name === 'cat' && c.paths.some((p) => p.startsWith('/repo/sealed/'))) {
    return { deny: 'sealed by ' + ctx.profile }
  }
  return c.name === 'shred' ? { ask: 'sign-off' } : null
}
`

function path(virtual: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual,
    resourcePath: '',
    rawPath: virtual,
    resolved: true,
  })
}

function ctx(command = 'cat', sessionId = 's'): CommandContext {
  return {
    command,
    paths: [path('/repo/sealed/k')],
    operands: [path('/repo/sealed/k')],
    argv: ['/repo/sealed/k'],
    cwd: '/repo',
    registry: { isMountRoot: () => false },
    sessionId,
    agentId: 'agent-1',
    tokens: [command, '/repo/sealed/k'],
    program: [command],
  }
}

// A python judge that reads what the operand holds, not what it is
// called: the shape a content policy takes when it is a program.
const READER_PY = `\
def pre_command(ctx):
    for p in ctx['command']['paths']:
        try:
            body = open(p).read()
        except OSError:
            continue
        if 'payload' in body:
            return {'ask': 'sign-off on payload'}
    return None
`

function entry(
  source = JUDGE,
  runtime = 'quickjs',
  language: 'js' | 'python' = 'js',
): ProfileScript {
  return { profile: 'release', script: new ScriptSource(source, language), runtime }
}

/**
 * A read-only door over a few files, answering ENOENT for the rest. An
 * open lists the directory and stats the file before it reads, so the
 * door answers all three.
 */
function doorsOver(files: Record<string, string>): BridgeDispatchFn {
  return (op, path) => {
    if (op === 'readdir') {
      const names = Object.keys(files).filter(
        (p) => p.startsWith(path) && !p.slice(path.length).includes('/'),
      )
      if (names.length === 0) {
        return Promise.reject(Object.assign(new Error(path), { code: 'ENOENT' }))
      }
      return Promise.resolve(names)
    }
    const body = files[path]
    if (body === undefined) {
      return Promise.reject(Object.assign(new Error(path), { code: 'ENOENT' }))
    }
    const bytes = new TextEncoder().encode(body)
    if (op === 'read') return Promise.resolve(bytes)
    if (op === 'stat') {
      return Promise.resolve(
        new FileStat({
          name: path,
          size: bytes.length,
          type: FileType.FILE,
          content: ContentType.TEXT,
        }),
      )
    }
    return Promise.reject(Object.assign(new Error(`${op} ${path}`), { code: 'EROFS' }))
  }
}

function policyOf(script: ProfileScript | null): ScriptPolicy {
  return new ScriptPolicy({ scriptOf: () => script }, () => ['/repo/', '/scratch/'])
}

const open: ScriptPolicy[] = []

function track(policy: ScriptPolicy): ScriptPolicy {
  open.push(policy)
  return policy
}

afterEach(async () => {
  for (const policy of open.splice(0)) await policy.close()
})

describe('scriptContext', () => {
  it('is the command context as data', () => {
    expect(scriptContext('release', ctx(), ['/repo/', '/scratch/'])).toEqual({
      profile: 'release',
      command: {
        name: 'cat',
        argv: ['/repo/sealed/k'],
        tokens: ['cat', '/repo/sealed/k'],
        program: ['cat'],
        paths: ['/repo/sealed/k'],
        operands: ['/repo/sealed/k'],
        tool: true,
        walks: false,
      },
      session: { id: 's', agent: 'agent-1', cwd: '/repo' },
      mounts: ['/repo/', '/scratch/'],
    })
  })
})

describe('scriptAction', () => {
  it.each([[null], ['allow']])('reads %j as no opinion', (value) => {
    expect(scriptAction(value)).toBeNull()
  })

  it('turns a deny answer into a whole-command deny', () => {
    expect(scriptAction({ deny: 'sealed' })).toEqual({ kind: 'deny', reason: 'sealed' })
  })

  it('takes an ask answer to the approval door', () => {
    const action = scriptAction({ ask: 'sign-off' })
    expect(action).toEqual({ kind: 'ask', reason: 'sign-off' })
  })

  it("gives the bare verbs the document's default reasons", () => {
    expect(scriptAction('deny')).toEqual({ kind: 'deny', reason: DEFAULT_DENY_REASON })
    expect(scriptAction('ask')).toEqual({ kind: 'ask', reason: DEFAULT_ASK_REASON })
  })

  it.each([
    [[1, 2]],
    [7],
    ['nope'],
    [{}],
    [{ deny: '' }],
    [{ deny: 3 }],
    [{ allow: true }],
    [{ deny: 'a', ask: 'b' }],
  ])('refuses %j', (value) => {
    expect(() => scriptAction(value)).toThrow(/must answer allow, deny or ask/)
  })
})

describe('ScriptPolicy', () => {
  it('does not judge a session without a script', async () => {
    const policy = track(policyOf(null))
    expect(await policy.preCommand(ctx())).toBeNull()
  })

  it('refuses a command with a deny it computed', async () => {
    const policy = track(policyOf(entry()))
    expect(await policy.preCommand(ctx('cat'))).toEqual({
      kind: 'deny',
      reason: 'sealed by release',
    })
  })

  it('stays silent on a command the script allows', async () => {
    const policy = track(policyOf(entry()))
    expect(await policy.preCommand(ctx('ls'))).toBeNull()
  })

  it('takes an ask it computed to the door', async () => {
    const policy = track(policyOf(entry()))
    expect(await policy.preCommand(ctx('shred'))).toEqual({ kind: 'ask', reason: 'sign-off' })
  })

  it('fails closed when the script throws', async () => {
    // Silence on failure would run exactly the commands the script
    // existed to judge, so every failure arm refuses instead.
    const policy = track(policyOf(entry("function preCommand() { throw new Error('boom') }")))
    const action = await policy.preCommand(ctx())
    expect(action).toMatchObject({ kind: 'deny' })
    expect((action as { reason: string }).reason).toMatch(/profile 'release' policy failed/)
  })

  it('fails closed on a wrong answer shape', async () => {
    const policy = track(policyOf(entry('function preCommand() { return [1, 2] }')))
    const action = await policy.preCommand(ctx())
    expect((action as { reason: string }).reason).toMatch(/profile 'release' policy must answer/)
  })

  it('fails closed on a program that defines no hook', async () => {
    // A verdict as a bare last expression was the old contract; a policy
    // defines the hooks it answers at, and a program defining none is
    // refused at every door rather than read for a value it never meant.
    const policy = track(policyOf(entry('null')))
    expect(await policy.preCommand(ctx())).toEqual({
      kind: 'deny',
      reason: "profile 'release' policy defines no hook: preCommand, preOps or preSession",
    })
  })

  it('fails closed on an engine it cannot build', async () => {
    const policy = track(policyOf(entry(JUDGE, 'ghost')))
    const action = await policy.preCommand(ctx())
    expect((action as { reason: string }).reason).toMatch(
      /profile 'release' policy names runtime 'ghost'/,
    )
  })

  it('fails closed on an engine that cannot evaluate', async () => {
    const policy = track(policyOf(entry(JUDGE, 'vfs')))
    const action = await policy.preCommand(ctx())
    expect((action as { reason: string }).reason).toMatch(/cannot evaluate one/)
  })

  it('reuses one engine across commands and closes it', async () => {
    const policy = policyOf(entry())
    expect(await policy.preCommand(ctx('cat'))).not.toBeNull()
    expect(await policy.preCommand(ctx('ls'))).toBeNull()
    await policy.close()
  })
})

describe('ScriptPolicy wiring', () => {
  it('reads the workspace through the doors it is wired to', async () => {
    // The facts name the path; the engine opens it. The read arrives
    // on the bridge the workspace handed over, the way an agent's own
    // program reaches a mount.
    const policy = track(
      new ScriptPolicy({ scriptOf: () => entry(READER_PY, 'monty', 'python') }, () => ['/repo/'], {
        bridge: () => doorsOver({ '/repo/sealed/k': 'subject: invoice\n\na payload\n' }),
        resolver: new PrefixResolver(() => ['/repo/']),
      }),
    )
    expect(await policy.preCommand(ctx('cat'))).toEqual({
      kind: 'ask',
      reason: 'sign-off on payload',
    })
  }, 60_000)

  it('a bare policy has no door, and its program reads no file', async () => {
    // Unwired, the engine sees no mount: the open misses, the policy's
    // own except arm runs, and nothing is judged on content it never
    // saw. The workspace is what supplies the doors.
    const policy = track(policyOf(entry(READER_PY, 'monty', 'python')))
    expect(await policy.preCommand(ctx('cat'))).toBeNull()
  }, 60_000)
})

// A program at the op and session doors and nowhere else.
const GATES = `\
function preOps(ctx) {
  const op = ctx.op
  return op.write && op.path.startsWith('/scratch/frozen/') ? { deny: 'frozen by ' + ctx.profile } : null
}
function preSession(ctx) {
  return ctx.write.key.startsWith('AWS_') ? 'deny' : null
}
`

function opsCtx(op = 'write', virtual = '/scratch/frozen/f', write = true): OpsContext {
  return { op, path: path(virtual), write, prefix: '/scratch', sessionId: 's' }
}

function sessionCtx(key = 'AWS_KEY'): SessionContext {
  return { plane: 'env', verb: 'set', key, value: 'v', sessionId: 's' }
}

describe('the hooks a program defines', () => {
  it("spells the call and the probe in the program's language", () => {
    const py = new ScriptSource('x', 'python')
    const js = new ScriptSource('x', 'js')
    expect(hookCall(py, 'preOps')).toBe('pre_ops(ctx)')
    expect(hookCall(js, 'preOps')).toBe('preOps(ctx)')
    expect(hookProbe(py)).toContain('try:\n    pre_session\n')
    expect(hookProbe(py).endsWith('_mirage_hooks')).toBe(true)
    expect(hookProbe(js)).toContain('typeof preCommand')
  })

  it("reads the probe's answer as the Policy interface spells it", () => {
    expect(definedHooks(new ScriptSource('x', 'python'), ['pre_ops'])).toEqual(new Set(['preOps']))
    expect(definedHooks(new ScriptSource('x', 'js'), ['preCommand', 'preSession'])).toEqual(
      new Set(['preCommand', 'preSession']),
    )
    expect(definedHooks(new ScriptSource('x', 'js'), [])).toEqual(new Set())
  })

  it.each([[null], ['pre_ops'], [['nope']], [[1]]])('refuses %j as a probe answer', (value) => {
    expect(() => definedHooks(new ScriptSource('x', 'python'), value)).toThrow(
      /hook probe answered/,
    )
  })
})

describe('opsScriptContext and sessionScriptContext', () => {
  it('are the op and session contexts as data', () => {
    expect(opsScriptContext('release', opsCtx(), ['/scratch/'])).toEqual({
      profile: 'release',
      op: { name: 'write', path: '/scratch/frozen/f', write: true, prefix: '/scratch' },
      session: { id: 's' },
      mounts: ['/scratch/'],
    })
    expect(sessionScriptContext('release', sessionCtx(), ['/scratch/'])).toEqual({
      profile: 'release',
      write: { plane: 'env', verb: 'set', key: 'AWS_KEY', value: 'v' },
      session: { id: 's' },
      mounts: ['/scratch/'],
    })
  })
})

describe('scriptAction at the op and session doors', () => {
  it('answers allow or deny, never ask', () => {
    // The op and session doors cannot wait on a host, so the vocabulary
    // there is allow or deny, and an ask is a wrong answer.
    for (const hook of ['preOps', 'preSession'] as const) {
      expect(scriptAction({ deny: 'frozen' }, hook)).toEqual({ kind: 'deny', reason: 'frozen' })
      expect(scriptAction('deny', hook)).toEqual({ kind: 'deny', reason: DEFAULT_DENY_REASON })
      expect(scriptAction(null, hook)).toBeNull()
      expect(() => scriptAction('ask', hook)).toThrow(/must answer allow or deny/)
      expect(() => scriptAction({ ask: 'nod' }, hook)).toThrow(/must answer allow or deny/)
    }
  })
})

describe('ScriptPolicy at the op and session doors', () => {
  it('a hook the program leaves out is silence', async () => {
    const policy = track(policyOf(entry()))
    expect(await policy.preOps(opsCtx())).toBeNull()
    expect(await policy.preSession(sessionCtx())).toBeNull()
    expect(await policy.preCommand(ctx('cat'))).toMatchObject({ kind: 'deny' })
  })

  it('judges an op with the deny it computed', async () => {
    const policy = track(policyOf(entry(GATES)))
    expect(await policy.preOps(opsCtx())).toEqual({ kind: 'deny', reason: 'frozen by release' })
    expect(await policy.preOps(opsCtx('read', '/scratch/frozen/f', false))).toBeNull()
    expect(await policy.preOps(opsCtx('write', '/scratch/open/f'))).toBeNull()
    // No command hook: a command is silence, not a refusal.
    expect(await policy.preCommand(ctx('cat'))).toBeNull()
  })

  it('judges an env write with the deny it computed', async () => {
    const policy = track(policyOf(entry(GATES)))
    expect(await policy.preSession(sessionCtx())).toEqual({
      kind: 'deny',
      reason: DEFAULT_DENY_REASON,
    })
    expect(await policy.preSession(sessionCtx('HOME'))).toBeNull()
  })

  it('fails closed on an ask from an op hook', async () => {
    const policy = track(policyOf(entry("function preOps() { return 'ask' }")))
    const action = await policy.preOps(opsCtx())
    expect((action as { reason: string }).reason).toMatch(
      /profile 'release' policy must answer allow or deny/,
    )
  })

  it('fails closed at every door on a program that defines no hook', async () => {
    const policy = track(policyOf(entry('null')))
    const refused = {
      kind: 'deny',
      reason: "profile 'release' policy defines no hook: preCommand, preOps or preSession",
    }
    expect(await policy.preOps(opsCtx())).toEqual(refused)
    expect(await policy.preSession(sessionCtx())).toEqual(refused)
  })
})

describe('wantsFor', () => {
  it('says which sessions a hook speaks for', async () => {
    // The per-session refinement the secret fill asks: the door is
    // defined for everyone, but speaks only for a session whose program
    // defines the hook.
    const policy = track(policyOf(entry()))
    expect(await policy.wantsFor('preCommand', 's')).toBe(true)
    expect(await policy.wantsFor('preSession', 's')).toBe(false)
    expect(await policy.wantsFor('preOps', 's')).toBe(false)
    expect(await policy.wantsFor('postOps', 's')).toBe(false)
    expect(await track(policyOf(null)).wantsFor('preSession', 's')).toBe(false)
  })

  it('counts a program the door will refuse', async () => {
    // No hook at all, or a probe that failed: the door refuses every
    // write for this program, which is speaking.
    expect(await track(policyOf(entry('null'))).wantsFor('preSession', 's')).toBe(true)
    expect(
      await track(policyOf(entry("throw new Error('boom')"))).wantsFor('preSession', 's'),
    ).toBe(true)
  })

  it('remembers the hook set per language', async () => {
    // One text, two programs: the probe asks in each language's own
    // spelling, so what it found in one says nothing about the other.
    // `pre_command = 1` binds the python hook's name and no JavaScript
    // hook's, so the js profile fails closed at every door and the
    // python one speaks at the command door alone.
    const text = 'pre_command = 1'
    const scripts: Record<string, ProfileScript> = {
      j: { profile: 'j', script: new ScriptSource(text, 'js'), runtime: 'quickjs' },
      p: { profile: 'p', script: new ScriptSource(text, 'python'), runtime: 'monty' },
    }
    const policy = track(
      new ScriptPolicy({ scriptOf: (id) => scripts[id] ?? null }, () => ['/repo/']),
    )
    expect(await policy.wantsFor('preSession', 'j')).toBe(true)
    expect(await policy.wantsFor('preSession', 'p')).toBe(false)
  }, 60_000)

  it('refines Policies.wants per session', async () => {
    const policies = new Policies([track(policyOf(entry()))])
    expect(policies.wants('preSession')).toBe(true)
    expect(await policies.wantsFor('preSession', 's')).toBe(false)
    expect(await policies.wantsFor('preCommand', 's')).toBe(true)
    // A coded policy speaks for every session and settles it.
    const coded: Policy = { preSession: () => null }
    expect(await new Policies([track(policyOf(entry())), coded]).wantsFor('preSession', 's')).toBe(
      true,
    )
  })
})

// A program that reads at the command door and refuses at the op door,
// so its own read is exactly what its op hook would deadlock on.
const READER_AND_GATE_PY = `\
def pre_command(ctx):
    try:
        open('/repo/a').read()
    except OSError:
        pass
    return None

def pre_ops(ctx):
    return {'deny': 'judged ' + ctx['op']['path']}
`

interface HeldDoor {
  door: BridgeDispatchFn
  /** Settles when the engine's read of `/repo/a` reaches the door. */
  arrived: Promise<void>
  /** Lets that read answer. */
  release: () => void
}

/**
 * A door over one file, `/repo/a`, whose read waits until the test
 * releases it: the window in which the policy's own read is in flight.
 */
function heldDoor(): HeldDoor {
  let arrive!: () => void
  let release!: () => void
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve
  })
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const body = new TextEncoder().encode('hello')
  const door: BridgeDispatchFn = async (op, p) => {
    if (op === 'readdir') return ['/repo/a']
    if (p !== '/repo/a') throw Object.assign(new Error(p), { code: 'ENOENT' })
    if (op === 'stat') {
      return new FileStat({
        name: p,
        size: body.length,
        type: FileType.FILE,
        content: ContentType.TEXT,
      })
    }
    if (op === 'read') {
      arrive()
      await held
      return body
    }
    throw Object.assign(new Error(`${op} ${p}`), { code: 'EROFS' })
  }
  return { door, arrived, release }
}

describe("a policy's own reads at its op door", () => {
  it('lets through an op carrying its token and judges every other', async () => {
    // The token is what the bridge built for this policy stamps on each
    // op, and what the dispatcher hands back on the op's context. Another
    // caller's identical op (same name, same path) inside the read's
    // window is not the policy's and is judged: it waits for the
    // evaluation the read belongs to, then gets the hook's answer. So is
    // an op carrying a token from anywhere else.
    const stamped: symbol[] = []
    const { door, arrived, release } = heldDoor()
    const policy = track(
      new ScriptPolicy(
        { scriptOf: () => entry(READER_AND_GATE_PY, 'monty', 'python') },
        () => ['/repo/'],
        {
          bridge: (issuer) => {
            stamped.push(issuer)
            return door
          },
          resolver: new PrefixResolver(() => ['/repo/']),
        },
      ),
    )
    const judging = policy.preCommand(ctx('cat'))
    await arrived
    const [token] = stamped
    if (token === undefined) throw new Error('the bridge was never built')
    expect(await policy.preOps({ ...opsCtx('read', '/repo/a', false), issuer: token })).toBeNull()
    const other = policy.preOps(opsCtx('read', '/repo/a', false))
    const forged = policy.preOps({
      ...opsCtx('read', '/repo/a', false),
      issuer: Symbol('policy read'),
    })
    release()
    expect(await judging).toBeNull()
    expect(await other).toEqual({ kind: 'deny', reason: 'judged /repo/a' })
    expect(await forged).toEqual({ kind: 'deny', reason: 'judged /repo/a' })
  }, 60_000)
})
