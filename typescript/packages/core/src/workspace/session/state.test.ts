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

import { varsFromEnv } from './session.ts'
import { setAttr } from './state.ts'
import { ArithError } from '../../shell/errors.ts'
import { VarAttr, type ShellVar } from '../../shell/variable.ts'
import { CallStack } from '../../shell/call_stack.ts'
import { describe, expect, it } from 'vitest'
import type { SessionView } from '../../view/types.ts'
import { PolicyDenied } from '../../policy/errors.ts'
import { ReadonlyVariableError } from '../../shell/errors.ts'
import { SessionState } from './session.ts'
import {
  assignElement,
  elementIsSet,
  envSnapshot,
  inCallEnv,
  outliveCall,
  positionalParams,
  seedVar,
  sessionView,
  setPositionalParams,
  subscriptIndex,
  visibleArrays,
  visibleAssocs,
  visibleEnv,
} from './state.ts'
import { RANDOM } from '../../shell/constants.ts'
import { makeVar } from '../../shell/variable.ts'
import { makeArray } from '../../shell/array.ts'
import { parseProgram } from '../../shell/parse/parse.ts'
import { runWithSession } from '../../context/session_context.ts'

function makeView(): [SessionView, SessionState] {
  const session = new SessionState({ sessionId: 's', cwd: '/', vars: varsFromEnv({ A: '1' }) })
  return [sessionView(session), session]
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
    // One entry point for every write: a string stores a scalar, or element
    // 0 of an array it lands on as bash's `A=s` does, a list stores a whole
    // array, and the two storages stay exclusive.
    const [view, session] = makeView()
    await view.set('A', makeArray(['x', 'y']))
    expect(session.arrays.A).toEqual(makeArray(['x', 'y']))
    expect('A' in session.env).toBe(false)
    await view.set('A', 's')
    expect(session.arrays.A).toEqual(makeArray(['s', 'y']))
    expect('A' in session.env).toBe(false)
    await view.set('S', 's')
    expect(session.env.S).toBe('s')
    expect('S' in session.arrays).toBe(false)
  })

  it('integer coercion resolves elements', async () => {
    // `n=a[1]+1` under `-i` reads the element, as bash does, through
    // the same resolver every other arithmetic entry point uses.
    const [view, session] = makeView()
    seedVar(session, 'a', makeArray(['1', '2']))
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

  it('a protected name reads and refuses every write', async () => {
    const [view, session] = makeView()
    session.visibility = {
      ...session.visibility,
      protected: { names: ['A'], patterns: ['SECRET_*'] },
    }
    expect(view.get('A')).toBe('1')
    await expect(view.set('SECRET_KEY', 'x')).rejects.toThrow('SECRET_KEY: permission')
    expect('SECRET_KEY' in session.env).toBe(false)
    await expect(view.unset('A')).rejects.toBeInstanceOf(PolicyDenied)
    await expect(view.mark('A', VarAttr.Readonly, true)).rejects.toBeInstanceOf(PolicyDenied)
    expect(session.vars.get('A')?.attrs.has(VarAttr.Readonly)).toBe(false)
    await view.set('PUBLIC', 'y')
    expect(session.env.PUBLIC).toBe('y')
  })

  it('envSnapshot is a copy', () => {
    const session = new SessionState({ sessionId: 's', cwd: '/', vars: varsFromEnv({ A: '1' }) })
    const snap = envSnapshot(session)
    expect(snap).toEqual({ A: '1', PWD: '/' })
    expect(snap).not.toBe(session.env)
  })

  it('the view carries no session handle', () => {
    // The view is the whole capability: five facts, no way back to the
    // raw session object behind them.
    const [view] = makeView()
    expect('session' in view).toBe(false)
  })
})

function makeHiddenView(): [SessionView, SessionState] {
  const session = new SessionState({
    sessionId: 's',
    cwd: '/',
    vars: varsFromEnv({ PUBLIC: '1', SLACK_TOKEN: 'xoxb', AWS_SECRET_KEY: 'k' }),
    visibility: { vars: { names: ['SLACK_TOKEN'], patterns: ['AWS_*'] } },
  })
  return [sessionView(session), session]
}

describe('hidden vars in the session view', () => {
  it('a hidden var reads as unset', () => {
    const [view] = makeHiddenView()
    expect(view.get('SLACK_TOKEN')).toBeNull()
    expect(view.get('AWS_SECRET_KEY')).toBeNull()
    expect(view.get('PUBLIC')).toBe('1')
  })

  it('snapshot omits hidden vars', () => {
    // Every copy-out routes through envSnapshot, so one omission here
    // is invisibility in ctx.env, RunArgs.env and the env builtin at
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
    // a swallow; the session view refuses loudly instead, the vars twin of
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
    const session = new SessionState({ sessionId: 's', cwd: '/', vars: varsFromEnv({ A: '1' }) })
    expect(visibleEnv(session)).toEqual({ ...session.env })
  })

  it('visibleEnv filters hidden names', () => {
    const [, session] = makeHiddenView()
    const env = visibleEnv(session)
    expect('SLACK_TOKEN' in env).toBe(false)
    expect('AWS_SECRET_KEY' in env).toBe(false)
    expect(env.PUBLIC).toBe('1')
    expect(Object.keys(env).sort()).toEqual(['IFS', 'OPTERR', 'OPTIND', 'PATH', 'PUBLIC', 'PWD'])
  })
})

function elementSession(): SessionState {
  const session = new SessionState({ sessionId: 's', cwd: '/' })
  seedVar(session, 'm', { a: '1', k5: '9', '0': 'z' })
  seedVar(session, 'arr', makeArray(['10', '20', '30']))
  seedVar(session, 's5', '5')
  seedVar(session, 'i', '1')
  return session
}

describe('elementIsSet', () => {
  it('reads a key verbatim and lands an indexed subscript', async () => {
    const session = elementSession()
    expect(await elementIsSet(session, 'm[a]')).toBe(true)
    expect(await elementIsSet(session, 'm["a"]')).toBe(true)
    expect(await elementIsSet(session, 'm[zz]')).toBe(false)
    // The subscript is the key verbatim, never arithmetic.
    expect(await elementIsSet(session, 'm[1+1]')).toBe(false)
    expect(await elementIsSet(session, 'm[@]')).toBe(true)
    expect(await elementIsSet(session, 'arr[2]')).toBe(true)
    expect(await elementIsSet(session, 'arr[9]')).toBe(false)
    expect(await elementIsSet(session, 'arr[@]')).toBe(true)
    // An indexed subscript is arithmetic, and what it assigns lands.
    expect(await elementIsSet(session, 'arr[j=2]')).toBe(true)
    expect(session.vars.get('j')?.value).toBe('2')
    // A bare name over an array checks element 0 (the literal key "0" for
    // an associative one).
    expect(await elementIsSet(session, 'm')).toBe(true)
    expect(await elementIsSet(session, 'arr')).toBe(true)
    expect(await elementIsSet(session, 's5')).toBe(true)
    expect(await elementIsSet(session, 'missing')).toBe(false)
    expect(await elementIsSet(session, 'not a ref')).toBe(false)
    // PIPESTATUS answers from the shell's own bookkeeping.
    session.pipeStatus = [0, 1]
    expect(await elementIsSet(session, 'PIPESTATUS[1]')).toBe(true)
    expect(await elementIsSet(session, 'PIPESTATUS[2]')).toBe(false)
  })
})

describe('assignElement', () => {
  it('writes an associative key and appends to it', async () => {
    const session = elementSession()
    expect(await assignElement(session, 'm', 'b', '2')).toBe('ok')
    expect(await assignElement(session, 'm', 'b', 'x', true)).toBe('ok')
    // A bare target over an associative array is the key "0".
    expect(await assignElement(session, 'm', null, 'top')).toBe('ok')
    expect(await assignElement(session, 'm', '', 'v')).toBe('subscript')
    expect(session.assocs.m?.b).toBe('2x')
    expect(session.assocs.m?.['0']).toBe('top')
  })

  it('writes an indexed element and answers each refusal', async () => {
    const session = elementSession()
    const held = session.vars.delete('s5')
    session.vars.set('ro', { value: held?.value ?? null, attrs: new Set([VarAttr.Readonly]) })
    session.visibility = { ...session.visibility, vars: { names: ['h'], patterns: [] } }
    expect(await assignElement(session, 'arr', '1', 'X')).toBe('ok')
    expect(await assignElement(session, 'arr', '-1', 'Y')).toBe('ok')
    expect(await assignElement(session, 'arr', '-9', 'n')).toBe('subscript')
    // An existing scalar migrates to element 0 under a subscript.
    seedVar(session, 'sc', 'base')
    expect(await assignElement(session, 'sc', '1', 'one')).toBe('ok')
    expect(await assignElement(session, 'ro', '0', 'x')).toBe('readonly')
    expect(await assignElement(session, 'h', '0', 'x')).toBe('denied')
    expect(session.arrays.arr).toEqual(makeArray(['10', 'X', 'Y']))
    expect(session.arrays.sc).toEqual(makeArray(['base', 'one']))
  })
})

describe('visible views', () => {
  it('list only what a lookup finds', () => {
    const session = elementSession()
    seedVar(session, 'SECRET', 'k')
    session.visibility = { ...session.visibility, vars: { names: ['SECRET'], patterns: [] } }
    const env = visibleEnv(session)
    expect('SECRET' in env).toBe(false)
    expect(Object.keys(env).every((name) => name in session.env)).toBe(true)
    expect(Object.keys(visibleArrays(session))).toEqual(['arr'])
    expect(Object.keys(visibleAssocs(session))).toEqual(['m'])
    session.pipeStatus = [3]
    expect(visibleArrays(session).PIPESTATUS).toEqual(makeArray(['3']))
    expect(Object.keys(visibleArrays(session))).not.toContain('PIPESTATUS')
  })
})

describe('subscriptIndex', () => {
  it('lands the assignments a subscript makes and seeds RANDOM', async () => {
    const s = new SessionState({ sessionId: 's' })
    seedVar(s, 'i', '1')
    s.vars.set(RANDOM, makeVar('1'))
    expect(await subscriptIndex(s, '3')).toBe(3n)
    expect(await subscriptIndex(s, 'i+1')).toBe(2n)
    // The subscript's assignment lands, bash's `a[x=3]`.
    expect(await subscriptIndex(s, 'x=3')).toBe(3n)
    expect(s.vars.get('x')?.value).toBe('3')
    // One that fails lands what it assigned before failing, then throws
    // in bash's words rather than reading element 0.
    await expect(subscriptIndex(s, 'y=4, 1/0')).rejects.toThrow(/^y=4, 1\/0: /)
    expect(s.vars.get('y')?.value).toBe('4')
    // A seed reaches the generator, and the draw after it advances the
    // session past it.
    expect(await subscriptIndex(s, 'RANDOM=42, RANDOM')).toBe(17772n)
    expect(s.vars.shell.nextRandom()).toBe(26794)
    // A protected name the subscript assigns refuses.
    s.visibility = { ...s.visibility, protected: { patterns: ['SECRET_*'] } }
    await expect(subscriptIndex(s, 'SECRET_N=1')).rejects.toBeInstanceOf(PolicyDenied)
    expect(s.env.SECRET_N).toBeUndefined()
  })
})

describe('managed variables through the session view', () => {
  function managedVar(value: string | null): ShellVar {
    return {
      value,
      attrs: new Set([VarAttr.Export]),
      managed: { source: 'env', ref: '', key: 'TOKEN', eager: false },
    }
  }

  it('set detaches a fetched managed var', async () => {
    const [view, session] = makeView()
    session.vars.set('TOKEN', managedVar('s3cr3t'))
    await view.set('TOKEN', 'mine')
    const v = session.vars.get('TOKEN')
    expect(v?.managed).toBeUndefined()
    expect(v?.value).toBe('mine')
    expect(v?.attrs).toEqual(new Set([VarAttr.Export]))
  })

  it('set detaches an unfetched managed var', async () => {
    const [view, session] = makeView()
    session.vars.set('TOKEN', managedVar(null))
    await view.set('TOKEN', 'mine')
    const v = session.vars.get('TOKEN')
    expect(v?.managed).toBeUndefined()
    expect(v?.value).toBe('mine')
  })

  it('unset deletes a managed name quietly', async () => {
    const [view, session] = makeView()
    session.vars.set('TOKEN', managedVar('s3cr3t'))
    await view.unset('TOKEN')
    expect(session.vars.has('TOKEN')).toBe(false)
  })
})

describe('a failing coercion', () => {
  it('lands what it assigned before the error', async () => {
    // bash: `declare -i n; x='y=5,1/0'; n=x` refuses the assignment but
    // leaves y at 5, and a RANDOM seed in the expression seeds.
    const [view, s] = makeView()
    s.vars.set(RANDOM, makeVar('1'))
    seedVar(s, 'n', '0')
    setAttr(s, 'n', VarAttr.Integer)
    seedVar(s, 'x', 'y=5,1/0')
    await expect(view.set('n', 'x')).rejects.toBeInstanceOf(ArithError)
    expect(s.vars.get('y')?.value).toBe('5')
    // The refused assignment left n as it was.
    expect(s.env.n).toBe('0')
    seedVar(s, 'x', 'RANDOM=42,1/0')
    await expect(view.set('n', 'x')).rejects.toBeInstanceOf(ArithError)
    expect(s.vars.shell.nextRandom()).toBe(17772)
  })
})

describe('positional parameters in scope', () => {
  it("are a function's own even when empty", () => {
    const session = new SessionState({ sessionId: 's', positionalArgs: ['a', 'b'] })
    const stack = new CallStack()
    expect(positionalParams(session, stack)).toEqual(['a', 'b'])
    stack.push([])
    expect(positionalParams(session, stack)).toEqual([])
    setPositionalParams(session, stack, ['x'])
    expect(stack.getAllPositional()).toEqual(['x'])
    expect(session.positionalArgs).toEqual(['a', 'b'])
    stack.pop()
    setPositionalParams(session, stack, ['y'])
    expect(session.positionalArgs).toEqual(['y'])
  })
})

describe('scopes on the call path', () => {
  it('unset reveals what an enclosing scope saved', async () => {
    const [view, session] = makeView()
    const shell = session.vars.shell
    seedVar(session, 'A', 'old')
    const temp = shell.openTemp()
    shell.saveTemp(temp, 'A')
    seedVar(session, 'A', 'pre')
    const outer = shell.enter()
    await view.unset('A')
    expect(session.env.A).toBe('old')
    shell.leave(outer)
    shell.closeTemp(temp)
    expect(session.env.A).toBe('old')
  })

  it('unset of a local leaves it unset', async () => {
    const [view, session] = makeView()
    const shell = session.vars.shell
    seedVar(session, 'A', '1')
    const outer = shell.enter()
    shell.shadow('A', false)
    seedVar(session, 'A', 'local')
    await view.unset('A')
    expect('A' in session.env).toBe(false)
    shell.leave(outer)
    expect(session.env.A).toBe('1')
  })

  it('outliveCall keeps a temporary-environment name', () => {
    const session = new SessionState({ sessionId: 's' })
    const shell = session.vars.shell
    const temp = shell.openTemp()
    shell.saveTemp(temp, 'A')
    seedVar(session, 'A', 't')
    const outer = shell.enter()
    expect(inCallEnv(session, 'A')).toBe(true)
    outliveCall(session, 'A')
    expect(inCallEnv(session, 'A')).toBe(false)
    shell.leave(outer)
    shell.closeTemp(temp)
    expect(session.env.A).toBe('t')
  })
})

describe('the frame a task reads', () => {
  it('voices the session it frames while another runs', async () => {
    const [, session] = makeView()
    const [, other] = makeView()
    const held = parseProgram('true\necho here')
    session.lineNode = held.root.namedChildren[1] ?? null
    const gone = parseProgram('echo there')
    other.lineNode = gone.root.namedChildren[0] ?? null
    gone.release()
    setAttr(session, 'r', VarAttr.Nameref)
    const notes: (string | Uint8Array)[] = []
    await runWithSession(other, () => sessionView(session, notes).set('r', makeArray(['x'])))
    held.release()
    expect(
      notes.map((note) => (typeof note === 'string' ? note : new TextDecoder().decode(note))),
    ).toEqual(['bash: line 2: warning: r: removing nameref attribute\n'])
  })
})
