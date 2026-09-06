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

import { varsFromEnv } from '../../workspace/session/session.ts'
import { setAttr } from '../../workspace/session/state.ts'
import { ArithError } from '../../shell/errors.ts'
import { VarAttr, type ShellVar } from '../../shell/variable.ts'
import { describe, expect, it } from 'vitest'
import type { SessionView } from '../../ops/types.ts'
import { PolicyDenied } from '../../policy/errors.ts'
import { Policies } from '../../policy/policies.ts'
import type { Action, SessionContext } from '../../policy/types.ts'
import { ReadonlyVariableError } from './errors.ts'
import { Session } from './session.ts'
import {
  elementIndex,
  envSnapshot,
  nextRandom,
  seedVar,
  sessionElements,
  sessionView,
  stripKeyQuotes,
  subscriptIndex,
  visibleEnv,
} from './state.ts'
import { RANDOM } from '../../shell/constants.ts'
import { makeVar } from '../../shell/variable.ts'

class DenySecrets {
  preSession(ctx: SessionContext): Action | null {
    if (ctx.key.startsWith('SECRET')) {
      return { kind: 'deny', reason: 'SECRET_* refused by policy' }
    }
    return null
  }
}

function makeView(policies: Policies | null = null): [SessionView, Session] {
  const session = new Session({ sessionId: 's', cwd: '/', vars: varsFromEnv({ A: '1' }) })
  return [sessionView(session, policies), session]
}

describe('sessionView', () => {
  it('get and snapshot read the session', () => {
    const [view, session] = makeView()
    expect(view.get('A')).toBe('1')
    expect(view.get('MISSING')).toBeNull()
    const snap = view.snapshot()
    expect(snap.A).toBe('1')
    snap.B = '2'
    expect('B' in session.env).toBe(false)
  })

  it('profile reads the session profile', () => {
    const [view, session] = makeView()
    expect(view.profile()).toBeNull()
    session.profile = 'admin'
    expect(view.profile()).toBe('admin')
  })

  it('set and unset write the session', async () => {
    const [view, session] = makeView()
    await view.set('B', '2')
    expect(session.env.B).toBe('2')
    await view.unset('B')
    expect('B' in session.env).toBe(false)
  })

  it('unset of a missing name is quiet', async () => {
    const [view] = makeView()
    await view.unset('NEVER_SET')
  })

  it('set is general over variable shapes', async () => {
    // One door for every write: a string stores a scalar, a list stores
    // a whole array, and the two storages stay exclusive.
    const [view, session] = makeView()
    await view.set('A', ['x', 'y'])
    expect(session.arrays.A).toEqual(['x', 'y'])
    expect('A' in session.env).toBe(false)
    await view.set('A', 's')
    expect(session.env.A).toBe('s')
    expect('A' in session.arrays).toBe(false)
  })

  it('an array write renders the gate value as words', async () => {
    const seen: (string | null)[] = []
    class Capture {
      preSession(ctx: SessionContext): Action | null {
        seen.push(ctx.value)
        return null
      }
    }
    const policies = new Policies()
    policies.add(new Capture())
    const [view] = makeView(policies)
    await view.set('A', ['x', null, 'y'])
    expect(seen).toEqual(['x y'])
  })

  it('a shaped write gates the value that lands', async () => {
    // `declare -l profile; profile=ADMIN` stores `admin`, so a rule refusing
    // `admin` has to see `admin`, not the raw text: coercion runs
    // before the gate.
    const seen: (string | null)[] = []
    class Capture {
      preSession(ctx: SessionContext): Action | null {
        seen.push(ctx.value)
        if (ctx.value === 'admin') return { kind: 'deny', reason: 'no admin' }
        return null
      }
    }
    const policies = new Policies()
    policies.add(new Capture())
    const [view, session] = makeView(policies)
    seedVar(session, 'profile', '')
    setAttr(session, 'profile', VarAttr.Lower)
    await expect(view.set('profile', 'ADMIN')).rejects.toBeInstanceOf(PolicyDenied)
    expect(session.env.profile).toBe('')
    seedVar(session, 'n', '0')
    setAttr(session, 'n', VarAttr.Integer)
    await view.set('n', '3+4')
    expect(session.env.n).toBe('7')
    expect(seen).toEqual(['admin', '7'])
  })

  it('integer coercion resolves elements', async () => {
    // `n=a[1]+1` under `-i` reads the element, as bash does, through
    // the same resolver every other arithmetic entry point uses.
    const [view, session] = makeView()
    seedVar(session, 'a', ['1', '2'])
    seedVar(session, 'm', { x: '4' })
    seedVar(session, 'n', '0')
    setAttr(session, 'n', VarAttr.Integer)
    await view.set('n', 'a[1]+1')
    expect(session.env.n).toBe('3')
    await view.set('n', 'm[x]+1')
    expect(session.env.n).toBe('5')
    await view.set('n', 'm["x"]+1')
    expect(session.env.n).toBe('5')
    await view.set('n', 'a[5]+1')
    expect(session.env.n).toBe('1')
    await expect(view.set('n', '1+')).rejects.toBeInstanceOf(ArithError)
  })

  it('the gate learns which session asked', async () => {
    const seen: string[] = []
    class CaptureSession {
      preSession(ctx: SessionContext): Action | null {
        seen.push(ctx.sessionId)
        return null
      }
    }
    const policies = new Policies()
    policies.add(new CaptureSession())
    const [view] = makeView(policies)
    await view.set('B', '1')
    expect(seen).toEqual(['s'])
  })

  it('readonly refusal is typed', async () => {
    // The view owns the refusal so every writer states it the same way;
    // builtins catch the typed error and render their own bash wording.
    const [view, session] = makeView()
    setAttr(session, 'A', VarAttr.Readonly)
    expect(view.isReadonly('A')).toBe(true)
    await expect(view.set('A', '2')).rejects.toBeInstanceOf(ReadonlyVariableError)
    await expect(view.unset('A')).rejects.toBeInstanceOf(ReadonlyVariableError)
    expect(session.env.A).toBe('1')
  })

  it('preSession gate vetoes a write', async () => {
    const policies = new Policies()
    policies.add(new DenySecrets())
    const [view, session] = makeView(policies)
    await expect(view.set('SECRET_KEY', 'x')).rejects.toBeInstanceOf(PolicyDenied)
    expect('SECRET_KEY' in session.env).toBe(false)
    await expect(view.unset('SECRET_KEY')).rejects.toBeInstanceOf(PolicyDenied)
    await view.set('PUBLIC', 'y')
    expect(session.env.PUBLIC).toBe('y')
  })

  it('envSnapshot is a copy', () => {
    const session = new Session({ sessionId: 's', cwd: '/', vars: varsFromEnv({ A: '1' }) })
    const snap = envSnapshot(session)
    expect(snap).toEqual({ ...session.env })
    expect(snap).not.toBe(session.env)
  })

  it('the view carries no session handle', () => {
    // The view is the whole capability: five facts, no way back to the
    // raw session object behind them.
    const [view] = makeView()
    expect('session' in view).toBe(false)
  })
})

function makeHiddenView(): [SessionView, Session] {
  const session = new Session({
    sessionId: 's',
    cwd: '/',
    vars: varsFromEnv({ PUBLIC: '1', SLACK_TOKEN: 'xoxb', AWS_SECRET_KEY: 'k' }),
    hiddenVars: { names: ['SLACK_TOKEN'], patterns: ['AWS_*'] },
  })
  return [sessionView(session), session]
}

describe('hidden vars in the session door', () => {
  it('a hidden var reads as unset', () => {
    const [view] = makeHiddenView()
    expect(view.get('SLACK_TOKEN')).toBeNull()
    expect(view.get('AWS_SECRET_KEY')).toBeNull()
    expect(view.get('PUBLIC')).toBe('1')
  })

  it('snapshot omits hidden vars', () => {
    // Every copy-out routes through envSnapshot, so one omission here
    // is invisibility in inv.env, RunArgs.env and the env builtin at
    // once.
    const [view] = makeHiddenView()
    const snap = view.snapshot()
    expect('SLACK_TOKEN' in snap).toBe(false)
    expect('AWS_SECRET_KEY' in snap).toBe(false)
    expect(snap.PUBLIC).toBe('1')
  })

  it('setting a hidden var is refused and leaves it intact', async () => {
    // A write that landed would clobber the real value the host's
    // wiring still reads, and a write that silently vanished would be
    // a swallow; the door refuses loudly instead, the vars twin of
    // EACCES on a create into hidden path space.
    const [view, session] = makeHiddenView()
    await expect(view.set('SLACK_TOKEN', 'fake')).rejects.toBeInstanceOf(PolicyDenied)
    expect(session.env.SLACK_TOKEN).toBe('xoxb')
  })

  it('unsetting a hidden var is quiet and writes nothing', async () => {
    // Hidden reads as unset, and bash's unset of a missing name is a
    // quiet no-op; popping the real value would let a session mutate
    // state it cannot see.
    const [view, session] = makeHiddenView()
    await view.unset('SLACK_TOKEN')
    expect(session.env.SLACK_TOKEN).toBe('xoxb')
  })

  it('a hidden readonly var reports not readonly', () => {
    // isReadonly answers about the session's visible world; saying
    // "readonly" about a name that reads as unset would leak it.
    const [view, session] = makeHiddenView()
    setAttr(session, 'SLACK_TOKEN', VarAttr.Readonly)
    expect(view.isReadonly('SLACK_TOKEN')).toBe(false)
  })

  it('visibleEnv matches the scalars when nothing is hidden', () => {
    const session = new Session({ sessionId: 's', cwd: '/', vars: varsFromEnv({ A: '1' }) })
    expect(visibleEnv(session)).toEqual({ ...session.env })
  })

  it('visibleEnv filters hidden names', () => {
    const [, session] = makeHiddenView()
    const env = visibleEnv(session)
    expect('SLACK_TOKEN' in env).toBe(false)
    expect('AWS_SECRET_KEY' in env).toBe(false)
    expect(env.PUBLIC).toBe('1')
    expect(Object.keys(env).sort()).toEqual(['PUBLIC', 'PWD'])
  })
})

function elementSession(): Session {
  const session = new Session({ sessionId: 's', cwd: '/' })
  seedVar(session, 'm', { a: '1', k5: '9', '0': 'z' })
  seedVar(session, 'arr', ['10', '20', '30'])
  seedVar(session, 's5', '5')
  seedVar(session, 'i', '1')
  return session
}

describe('stripKeyQuotes', () => {
  it('removes one surrounding pair only', () => {
    expect(stripKeyQuotes('"x"')).toBe('x')
    expect(stripKeyQuotes("'x'")).toBe('x')
    expect(stripKeyQuotes('x')).toBe('x')
    expect(stripKeyQuotes('"x')).toBe('"x')
    expect(stripKeyQuotes('""')).toBe('')
  })
})

describe('elementIndex', () => {
  it('resolves ints, arithmetic, and errors to zero', () => {
    expect(elementIndex('3', {})).toBe(3)
    expect(elementIndex(' -2 ', {})).toBe(-2)
    expect(elementIndex('i+1', { i: '1' })).toBe(2)
    // An unresolvable expression indexes element 0, bash's
    // unset-name-is-zero arithmetic rule.
    expect(elementIndex('$bad', {})).toBe(0)
  })
})

describe('subscriptIndex', () => {
  it('lands the assignments a subscript makes and seeds RANDOM', async () => {
    const s = new Session({ sessionId: 's' })
    seedVar(s, 'i', '1')
    s.vars[RANDOM] = makeVar('1')
    expect(await subscriptIndex(s, '3')).toBe(3)
    expect(await subscriptIndex(s, 'i+1')).toBe(2)
    // The subscript's assignment lands, bash's `a[x=3]`.
    expect(await subscriptIndex(s, 'x=3')).toBe(3)
    expect(s.vars.x?.value).toBe('3')
    // One that fails lands what it assigned before failing, then throws
    // in bash's words rather than reading element 0.
    await expect(subscriptIndex(s, 'y=4, 1/0')).rejects.toThrow(/^y=4, 1\/0: /)
    expect(s.vars.y?.value).toBe('4')
    // A seed reaches the generator, and the draw after it advances the
    // session past it.
    expect(await subscriptIndex(s, 'RANDOM=42, RANDOM')).toBe(17772)
    const drawn = s.vars[RANDOM].value
    expect(nextRandom(s, typeof drawn === 'string' ? drawn : undefined)).toBe(26794)
    // Through a door, a refusal is the gate's.
    const view = sessionView(s, new Policies([new DenySecrets()]))
    await expect(subscriptIndex(s, 'SECRET_N=1', view)).rejects.toBeInstanceOf(PolicyDenied)
    expect(s.env.SECRET_N).toBeUndefined()
  })
})

describe('sessionElements', () => {
  it('resolves associative subscripts literally', () => {
    const ops = sessionElements(elementSession())
    expect(ops.resolve('m', 'a', {})).toBe('a')
    expect(ops.resolve('m', '"a"', {})).toBe('a')
    // A key spelled like arithmetic stays a key.
    expect(ops.resolve('m', '1+1', {})).toBe('1+1')
  })

  it('resolves indexed subscripts as arithmetic with negative wrap', () => {
    const ops = sessionElements(elementSession())
    expect(ops.resolve('arr', '1+1', {})).toBe('2')
    expect(ops.resolve('arr', 'i', { i: '2' })).toBe('2')
    expect(ops.resolve('arr', '-1', {})).toBe('2')
    expect(() => ops.resolve('arr', '-9', {})).toThrow(ArithError)
  })

  it('reads by kind, scalars answering as element 0', () => {
    const ops = sessionElements(elementSession())
    expect(ops.read('m', 'a')).toBe('1')
    expect(ops.read('m', 'zz')).toBeNull()
    expect(ops.read('arr', '1')).toBe('20')
    expect(ops.read('arr', '9')).toBeNull()
    expect(ops.read('s5', '0')).toBe('5')
    expect(ops.read('s5', '1')).toBeNull()
    expect(ops.read('missing', '0')).toBeNull()
  })
})

describe('managed variables through the session door', () => {
  function managedVar(value: string | null): ShellVar {
    return {
      value,
      attrs: new Set([VarAttr.Export]),
      managed: { source: 'env', ref: '', key: 'TOKEN', eager: false },
    }
  }

  it('set detaches a fetched managed var', async () => {
    const [view, session] = makeView()
    session.vars.TOKEN = managedVar('s3cr3t')
    await view.set('TOKEN', 'mine')
    const v = session.vars.TOKEN
    expect(v.managed).toBeUndefined()
    expect(v.value).toBe('mine')
    expect(v.attrs).toEqual(new Set([VarAttr.Export]))
  })

  it('set detaches an unfetched managed var', async () => {
    const [view, session] = makeView()
    session.vars.TOKEN = managedVar(null)
    await view.set('TOKEN', 'mine')
    const v = session.vars.TOKEN
    expect(v.managed).toBeUndefined()
    expect(v.value).toBe('mine')
  })

  it('unset deletes a managed name quietly', async () => {
    const [view, session] = makeView()
    session.vars.TOKEN = managedVar('s3cr3t')
    await view.unset('TOKEN')
    expect('TOKEN' in session.vars).toBe(false)
  })
})

describe('a failing coercion', () => {
  it('lands what it assigned before the error', async () => {
    // bash: `declare -i n; x='y=5,1/0'; n=x` refuses the assignment but
    // leaves y at 5, and a RANDOM seed in the expression seeds.
    const [view, s] = makeView()
    s.vars[RANDOM] = makeVar('1')
    seedVar(s, 'n', '0')
    setAttr(s, 'n', VarAttr.Integer)
    seedVar(s, 'x', 'y=5,1/0')
    await expect(view.set('n', 'x')).rejects.toBeInstanceOf(ArithError)
    expect(s.vars.y?.value).toBe('5')
    // The refused assignment left n as it was.
    expect(s.env.n).toBe('0')
    seedVar(s, 'x', 'RANDOM=42,1/0')
    await expect(view.set('n', 'x')).rejects.toBeInstanceOf(ArithError)
    const drawn = s.vars[RANDOM].value
    expect(nextRandom(s, typeof drawn === 'string' ? drawn : undefined)).toBe(17772)
  })
})
