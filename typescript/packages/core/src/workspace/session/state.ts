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

import type { SessionView } from '../../view/types.ts'
import { PolicyDenied, preSessionGate, type Policies } from '../../policy/index.ts'
import { evaluateArith, plainDecimal } from '../../shell/arith.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import {
  arrayExtent,
  arrayGet,
  arrayHas,
  arrayValues,
  arrayWith,
  makeArray,
  type ShellArray,
} from '../../shell/array.ts'
import {
  FUNCNAME,
  PIPESTATUS,
  RANDOM,
  RANDOM_MODULUS,
  RANDOM_UNSET,
} from '../../shell/constants.ts'
import { encodeText } from '../../shell/bytes.ts'
import { ArithError, ExitSignal, ReadonlyError } from '../../shell/errors.ts'
import type { ArithResult, ArithWrite, ElementOps } from '../../shell/types.ts'
import { varHidden } from '../../utils/hidden.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { ReadonlyVariableError } from './errors.ts'
import { draw, initialSeed } from './rng.ts'
import { ownRecord, sessionEntry, setSessionEntry } from './session.ts'
import type { ShellValue, ShellVar } from '../../shell/variable.ts'
import {
  coerceValue,
  detach,
  makeVar,
  TempEnv,
  VarAttr,
  withAttr,
  withValue,
} from '../../shell/variable.ts'
import type { SessionState } from './session.ts'

/**
 * The one copy-out of a session's environment.
 *
 * Every tier that hands the env onward as a process view (command
 * opts, `inv.env`, guest `RunArgs.env`, the `env` builtin) copies
 * through here, so the hidden-vars filter lands on all of them by
 * construction rather than on however many hand-rolled copies someone
 * remembers. The copy keeps the null prototype session records carry.
 *
 * *Exported* names only, which is what makes this the process view
 * rather than a second spelling of `visibleEnv`. bash puts a variable
 * in a child's environment when it carries the export attribute, not
 * when it happens to hold a string: `X=hello` is absent from `env` and
 * `export Y=world` is present. An unset name carrying the attribute
 * (`export Z`) is absent too, which falls out of the value check
 * rather than needing its own arm.
 *
 * Diverges from bash on one point: bash also carries each function
 * `export -f` marked, as a `BASH_FUNC_NAME%%` entry. mirage hands those to
 * a nested shell directly (`SessionState.newShell`), so neither `env` nor a
 * runtime lists them.
 */
export function envSnapshot(session: SessionState): Record<string, string> {
  const out = ownRecord<string>()
  for (const [name, v] of Object.entries(session.vars)) {
    if (
      typeof v.value === 'string' &&
      v.attrs.has(VarAttr.Export) &&
      !varHidden(session.visibility, name)
    ) {
      out[name] = v.value
    }
  }
  return out
}

/**
 * The name a `declare -n` reference points at, null otherwise. Null
 * also for a reference declared but not yet aimed (`declare -n r`
 * before `r=v`): bash treats the first assignment as naming the target,
 * so until then it stands for nothing.
 */
export function namerefTarget(session: SessionState, name: string): string | null {
  const v = sessionEntry(session.vars, name)
  if (!v?.attrs.has(VarAttr.Nameref)) return null
  return typeof v.value === 'string' && v.value ? v.value : null
}

/**
 * The variable a name stands for, following `declare -n` chains. A name
 * that is not a reference is its own answer. A chain that comes back to
 * itself (`declare -n a=b; declare -n b=a`) is bash's circular name
 * reference, read as unset: it resolves to the empty name, which no
 * record has, so a reader sees unset and a writer falls back to the
 * reference's own record. The warning line is the one part not
 * reproduced.
 */
export function deref(session: SessionState, name: string): string {
  let current = name
  const seen = new Set<string>()
  for (;;) {
    const target = namerefTarget(session, current)
    if (target === null) return current
    if (seen.has(current)) return ''
    seen.add(current)
    current = target
  }
}

/** The variable's value, null when unset or hidden. Sync on purpose:
 * `$X` expansion is the hot path, so a read stays a record lookup plus
 * the hidden check. A name reference reads its target. */
export function envGet(session: SessionState, name: string): string | null {
  const resolved = deref(session, name)
  if (varHidden(session.visibility, resolved)) return null
  const v = sessionEntry(session.vars, resolved)
  return v !== undefined && typeof v.value === 'string' ? v.value : null
}

/**
 * Whether `readonly` has marked the name.
 *
 * A hidden name answers false: isReadonly speaks about the session's
 * visible world, and calling a name that reads as unset "readonly"
 * would leak it. `followRef` asks about what a `declare -n` reference
 * points at; a write to the reference itself (`declare -n r=w`,
 * `unset -n r`) asks about the reference.
 */
function envIsReadonly(session: SessionState, name: string, followRef = true): boolean {
  const resolved = followRef ? deref(session, name) : name
  if (varHidden(session.visibility, resolved)) return false
  const v = sessionEntry(session.vars, resolved)
  return v?.attrs.has(VarAttr.Readonly) ?? false
}

/**
 * The env mapping a reader tier should resolve names against.
 *
 * Always a filtered copy, never `session.env`: that getter is itself a
 * projection built fresh per access, so handing it out would copy the
 * store anyway and freeze the answer at that moment. TS diverges from
 * python's lazy mapping view deliberately: expansion sites read records
 * with plain property access, so a copy is the shape they already
 * consume, and env sizes make the copy cost noise.
 *
 * The *shell* view, and no longer a synonym for `envSnapshot`: this is
 * what `$X`, arithmetic, `[[ ]]`, `IFS` and the bare `set` listing
 * resolve against, and they see every variable, exported or not. The
 * two were the same function while the process view was also "every
 * string", and reusing it once the process view narrowed would have
 * stopped `$X` resolving a plain assignment. python kept them separate
 * all along (`_VisibleEnv` beside `env_snapshot`); this is TS catching
 * up to it.
 */
export function visibleEnv(session: SessionState): Record<string, string> {
  const out = ownRecord<string>()
  for (const [name, v] of Object.entries(session.vars)) {
    if (typeof v.value === 'string' && !varHidden(session.visibility, name)) {
      out[name] = v.value
    }
  }
  return out
}

/**
 * The arrays mapping a reader tier should resolve names against.
 *
 * The arrays twin of `visibleEnv`: the embedder can seed
 * `session.arrays` before narrowing, so a hidden name can hold an
 * array and array reads need the same filter env reads get.
 */
export function visibleArrays(session: SessionState): Record<string, ShellArray> {
  const out = ownRecord<ShellArray>()
  for (const [name, v] of Object.entries(session.vars)) {
    if (Array.isArray(v.value) && !varHidden(session.visibility, name)) {
      out[name] = v.value
    }
  }
  // PIPESTATUS and FUNCNAME are the session's records, never the store's:
  // an assignment to either is ignored, as bash ignores one, because the
  // record answers before the store.
  if (!varHidden(session.visibility, PIPESTATUS)) {
    out[PIPESTATUS] = session.pipeStatus.map((code) => String(code))
  }
  if (session.functionNames !== null && !varHidden(session.visibility, FUNCNAME)) {
    out[FUNCNAME] = [...session.functionNames]
  }
  return out
}

/**
 * The associative arrays a reader tier should resolve names against.
 *
 * The third sibling beside `visibleEnv` and `visibleArrays`, for the
 * same reason both exist: the embedder can seed a hidden name with any
 * value shape, so every reader tier filters the same way.
 */
export function visibleAssocs(session: SessionState): Record<string, Record<string, string>> {
  const out = ownRecord<Record<string, string>>()
  for (const [name, v] of Object.entries(session.vars)) {
    if (
      v.value !== null &&
      typeof v.value === 'object' &&
      !Array.isArray(v.value) &&
      !varHidden(session.visibility, name)
    ) {
      out[name] = v.value
    }
  }
  return out
}

/**
 * Write one variable through the session plane's gate.
 *
 * General over variable shapes: a string stores a scalar, a ShellArray
 * stores a whole array, and the two storages stay exclusive. Semantics
 * live here once — the hidden refusal, readonly refusal, the
 * `preSession` policy gate (whose context value renders an array as
 * its present elements joined by spaces), then the store — so every
 * writer states them the same way whichever tier or spelling asked.
 * Writers with richer mechanics (subscripts, appends, holes) compute
 * the resulting value on a copy and hand it here, so a denial never
 * leaves a half-applied write. Null policies gate nothing (a writer
 * outside a workspace). Throws PolicyDenied when the name is hidden
 * for this session (a landed write would clobber the real value the
 * host's wiring still reads; a swallowed one would gaslight the
 * writer — the vars twin of EACCES on a create into hidden path
 * space), ReadonlyVariableError when the name is readonly, and
 * PolicyDenied when a preSession policy refuses the write.
 */
/**
 * Refuse a write that names a hidden variable.
 *
 * The sync half of `setVar`'s hidden gate, shared with the
 * expansion-time writers that land on the raw env (`${X:=d}`,
 * `$((X=5))`, `printf -v`): a landed write would clobber the real
 * value the host's wiring still reads, and a swallowed one would
 * gaslight the writer; refuse loudly instead, the vars twin of EACCES
 * on a create into hidden path space.
 */
/**
 * Remove one surrounding quote pair from an associative subscript.
 *
 * An arithmetic reference carries its subscript verbatim, so `m["x"]`
 * arrives with the quotes bash would have removed; one layer comes off
 * and anything else is the key itself.
 */
export function stripKeyQuotes(text: string): string {
  const first = text.charAt(0)
  if (
    text.length >= 2 &&
    first === text.charAt(text.length - 1) &&
    (first === '"' || first === "'")
  ) {
    return text.slice(1, -1)
  }
  return text
}

/**
 * The `ElementOps` implementation bound to one session.
 *
 * It lives beside the other reader projections because the session view
 * needs it too: the `-i` coercion evaluates `n=a[1]+1` at the write, and a
 * resolver that imported the session view would close a cycle.
 */
class SessionElements implements ElementOps {
  constructor(private readonly session: SessionState) {}

  isAssoc(name: string): boolean {
    return visibleAssocs(this.session)[name] !== undefined
  }

  holdsArray(name: string): boolean {
    return this.isAssoc(name) || visibleArrays(this.session)[name] !== undefined
  }

  /** `subscript` is an associative array's raw subscript text, or an indexed
   * one's index, which the evaluator has already read as arithmetic. */
  resolve(name: string, subscript: string): string {
    if (visibleAssocs(this.session)[name] !== undefined) {
      return stripKeyQuotes(subscript)
    }
    let idx = Number(subscript)
    if (idx < 0) {
      const arr = visibleArrays(this.session)[name]
      if (arr !== undefined) idx += arrayExtent(arr)
      else if (envGet(this.session, name) !== null) idx += 1
      if (idx < 0) throw new ArithError('bad array subscript', `${name}[${subscript}]`)
    }
    return String(idx)
  }

  read(name: string, key: string): string | null {
    const amap = visibleAssocs(this.session)[name]
    if (amap !== undefined) return amap[key] ?? null
    const arr = visibleArrays(this.session)[name]
    const idx = Number(key)
    if (arr === undefined) {
      const scalar = envGet(this.session, name)
      if (scalar === null) return null
      return idx === 0 ? scalar : null
    }
    return arrayHas(arr, idx) ? arrayGet(arr, idx) : null
  }
}

/** Element callbacks bound to one session, for `evaluateArith`. */
export function sessionElements(session: SessionState): ElementOps {
  return new SessionElements(session)
}

/**
 * Land arithmetic assignments in order, each as the whole variable it
 * produces, so a refusal never leaves one half-applied. Each lands the way
 * `assignElement` lands one: through a reference on its target, a bare name
 * over an array at element 0 (`A=(old keep); n='A=9'` keeps `keep`), naming
 * the element it assigns so an `-i` array never runs its other elements
 * again (`A=(0 'x++'); declare -i A; (( A[0]=9 ))` leaves `x++`).
 * Both of its contexts, a subscript and an `-i` value, end the shell on a
 * readonly name (`declare -i n; ( n='R=3'; echo no )` ends only the
 * subshell): ExitSignal.
 */
async function landWrites(
  session: SessionState,
  store: SessionView['set'],
  writes: readonly ArithWrite[],
): Promise<void> {
  for (const write of writes) {
    const name = deref(session, write.name) || write.name
    const assoc = visibleAssocs(session)[name]
    const arr = visibleArrays(session)[name]
    let value: ShellValue = write.value
    let assigned: ReadonlySet<number | string> | null = null
    if (assoc !== undefined) {
      const key = write.key ?? '0'
      value = { ...assoc, [key]: write.value }
      assigned = new Set([key])
    } else if (write.key !== null || arr !== undefined) {
      const index = write.key === null ? 0 : Number(write.key)
      // A scalar becomes element 0, as `assignElement` turns it
      // (`x=7; n='x[1]=5'` keeps the 7).
      const scalar = arr === undefined ? conversionScalar(session, name) : undefined
      value = arrayWith(arr ?? makeArray(scalar === undefined ? [] : [scalar]), index, write.value)
      assigned = new Set([index])
    }
    try {
      await store(name, value, true, assigned)
    } catch (err) {
      if (err instanceof ReadonlyVariableError) throw new ReadonlyError(err.varName).signal(true)
      throw err
    }
  }
}

/**
 * An indexed subscript resolved outside an arithmetic expression:
 * `${a[i]}`, `a[i]=v`, `unset 'a[i]'`, `[[ -v a[i] ]]`.
 *
 * The subscript is arithmetic, so it may assign (`a[x=3]`) and seed
 * (`a[RANDOM=42]`), and bash binds those as it evaluates them. Each
 * lands through the session view once the index is known, then the `RANDOM`
 * reader replays the draws made after the seed. A subscript that fails
 * to evaluate lands what it assigned before failing and then throws, the
 * subscript text leading the message, since bash aborts the line on it
 * (`${a[1/0]}` is `1/0: division by 0`) rather than reading element 0.
 * `view` is the gated session view; null lands the writes ungated, outside a
 * workspace. Throws what the session view throws too: a PolicyDenied, or an
 * ArithError from a `-i` name refusing the value; a readonly name ends the
 * shell wherever a subscript is (`${a[R=3]}`): ExitSignal.
 */
export async function subscriptIndex(
  session: SessionState,
  subscript: string,
  view: SessionView | null = null,
): Promise<number> {
  const plain = plainDecimal(subscript)
  if (plain !== null) return Number(plain)
  const reader = randomReader(session)
  let idx = 0
  let writes: readonly ArithWrite[]
  let error: ArithError | ReadonlyError | null = null
  try {
    const result = sessionArith(session, subscript, reader, session.shellOptions.nounset === true)
    idx = Number(result.value)
    writes = result.writes
  } catch (err) {
    if (!(err instanceof ArithError || err instanceof ReadonlyError)) throw err
    error = err
    writes = err.writes
  }
  await landWrites(
    session,
    (name, value, followRef, assigned) =>
      view !== null
        ? view.set(name, value, followRef, assigned)
        : setVar(session, null, name, value, followRef, undefined, assigned),
    writes,
  )
  reader.settle()
  if (error instanceof ReadonlyError) throw error.signal(true)
  if (error !== null) throw error
  return idx
}

/**
 * The `-i` coercion: evaluate the incoming text as arithmetic.
 *
 * Reads resolve against the visible env, so `n=x+1` sees `x`, and
 * element references resolve through the session's resolver, so
 * `n=a[1]+1` and `n=m[k]+1` see the element; an unresolvable name is 0
 * (`n=abc` stores `0`), which is the arithmetic rule, not a refusal. A
 * malformed expression throws ArithError with the offending text led,
 * which is how every caller voices it (`bash: 1+: syntax error: operand
 * expected`), so it is spelled once here rather than at each of the
 * sites that catch it.
 */
/** Evaluate a host-supplied seed; invalid arithmetic propagates. Read
 * without the generator on offer: a host word naming `RANDOM` would
 * otherwise draw, and the draw reseed, without end. */
export function seedFrom(word: string, session: SessionState): number {
  const value = evaluateArith(word, visibleEnv(session), sessionElements(session)).value
  const modulus = BigInt(RANDOM_MODULUS)
  return Number(((value % modulus) + modulus) % modulus)
}

/** Draw from the session generator, or null after RANDOM is unset.
 * Shell assignments validate and seed at the session view. A host-seeded
 * variable is consumed here on its first read. Reseeding resets repeat
 * suppression to zero independently of the stored word. */
export function nextRandom(session: SessionState, stored: string | undefined): number | null {
  if (
    session.randomSeed === RANDOM_UNSET ||
    (stored === undefined && session.randomSeed !== null)
  ) {
    return null
  }
  let state: number
  let last: number
  const seed =
    stored !== undefined && stored !== session.randomSeed ? seedFrom(stored, session) : null
  if (seed !== null) {
    state = seed
    last = 0
  } else if (session.randomState === null) {
    state = initialSeed(session.sessionId)
    last = 0
  } else {
    state = session.randomState
    last = session.randomLast
  }
  const [nextState, value] = draw(state, last)
  state = nextState
  session.randomState = state
  session.randomLast = value
  const word = String(value)
  const existing = session.vars[RANDOM]
  session.vars[RANDOM] = existing !== undefined ? withValue(existing, word) : makeVar(word)
  session.randomSeed = word
  return value
}

/**
 * Arithmetic's reads of `$RANDOM`, bound to one session.
 *
 * A read before the expression assigns `RANDOM` draws from the session
 * generator. bash seeds at the instant of an assignment and every later
 * read draws from the new seed (`$((RANDOM=42, RANDOM))` is the first
 * draw after seeding with 42). Here the assignment is still pending at
 * the session view, which lands it gated after evaluation, so the
 * evaluator tells the reader of each assignment as it is made (`wrote`),
 * the reader seeds a scratch generator the way the session view will and draws
 * from that, and `settle` replays the draws on the session once the
 * session view has seeded it: the session ends where bash's does, seeded and
 * advanced by every read since the last assignment, and the write still
 * reaches the gate as the assignment it is. Each assignment restarts
 * the scratch generator and the count, since the session view lands only the
 * last value written, and the draws are replayed only if the session view did
 * land it: an assignment the caller never applied leaves the session as
 * it was.
 *
 * Lives beside the session view rather than with the generator because the
 * session view needs it too: `RANDOM=RANDOM` draws once while the seed is
 * evaluated, then seeds with the draw, as bash does: it reads an
 * assigned seed as an arithmetic expression.
 */
export class RandomReader {
  private seeded: string | null = null
  private state = 0
  private last = 0
  private draws = 0

  constructor(private readonly session: SessionState) {}

  private special(name: string): boolean {
    const session = this.session
    return (
      name === RANDOM && !varHidden(session.visibility, name) && session.randomSeed !== RANDOM_UNSET
    )
  }

  /** The dynamic value of a name, null for a name that has none. */
  readonly read = (name: string): string | null => {
    if (!this.special(name)) return null
    if (this.seeded === null) {
      const value = nextRandom(this.session, visibleEnv(this.session)[name])
      return value === null ? null : String(value)
    }
    const [state, value] = draw(this.state, this.last)
    this.state = state
    this.last = value
    this.draws += 1
    return String(value)
  }

  /** Note an assignment the expression made: the name and its value, an
   * integer's text. */
  readonly wrote = (name: string, value: string): void => {
    if (!this.special(name)) return
    this.seeded = value
    const modulus = BigInt(RANDOM_MODULUS)
    this.state = Number(((BigInt(value) % modulus) + modulus) % modulus)
    this.last = 0
    this.draws = 0
  }

  /** Replay the scratch draws on the session generator, once the session view
   * has seeded it with the value the expression assigned. */
  settle(): void {
    if (this.seeded === null || this.session.randomSeed !== this.seeded) return
    for (let i = 0; i < this.draws; i++) {
      nextRandom(this.session, visibleEnv(this.session)[RANDOM])
    }
    this.draws = 0
  }
}

/**
 * End `RANDOM`'s special meaning when a non-string lands on it.
 *
 * Once bash turns `RANDOM` into an array it neither draws nor seeds,
 * so `RANDOM=(1 2)`, `declare -a RANDOM`, `RANDOM[1]=5` and
 * `RANDOM+=(3)` all leave an ordinary array that `$RANDOM` reads element
 * 0 of, for good, as `unset RANDOM` does. Every store entry point calls this,
 * gated or not, since a host seeding an array onto the name means the
 * same thing.
 */
export function noteRandomKind(session: SessionState, name: string, value: ShellValue): void {
  if (name === RANDOM && typeof value !== 'string') session.randomSeed = RANDOM_UNSET
}

/**
 * The scalar an array conversion keeps as element 0.
 *
 * When bash turns a variable into an array, its current value becomes
 * element 0, and for a live `RANDOM` looking the name up is what draws:
 * `RANDOM[1]=5` leaves `[0]` holding one draw and `declare -a RANDOM` one
 * alone, after which the array is ordinary.
 */
export function conversionScalar(session: SessionState, name: string): string | undefined {
  if (name === RANDOM) {
    const drawn = nextRandom(session, visibleEnv(session)[RANDOM])
    if (drawn !== null) return String(drawn)
  }
  return session.env[name]
}

/** Bind arithmetic `$RANDOM` reads to a session. */
export function randomReader(session: SessionState): RandomReader {
  return new RandomReader(session)
}

/**
 * Evaluate `text` as every arithmetic context of the shell does: against
 * the visible env and the session's elements, drawing through `reader`, and
 * stopping at a write to a readonly name, as bash's evaluation does
 * (`(( X=5, R=3 ))` binds X and refuses R). Throws ArithError when the text
 * does not evaluate, and ReadonlyError, carrying the writes made before it,
 * for a readonly name. `added` is an integer `+=`'s added text, read after
 * `text` in the same evaluation and added to it.
 */
export function sessionArith(
  session: SessionState,
  text: string,
  reader: RandomReader,
  nounset = false,
  added: string | null = null,
): ArithResult {
  return evaluateArith(
    text,
    visibleEnv(session),
    sessionElements(session),
    reader.read,
    reader.wrote,
    nounset,
    (name) => readonlyTarget(session, name),
    added,
  )
}

/**
 * The readonly variable a write to `name` reaches, through a `declare -n`
 * reference, which the refusal names; null when the write lands. Mirrors
 * Python's _readonly_target.
 */
function readonlyTarget(session: SessionState, name: string): string | null {
  const target = deref(session, name)
  return envIsReadonly(session, target, false) ? target : null
}

/**
 * The `-i` coercion and the `RANDOM` seed, as one evaluation. The
 * incoming text evaluates as arithmetic against the visible env, element
 * references resolving through the session's resolver, so `n=x+1` sees
 * `x` and `n=a[1]+1` the element; an unresolvable name is 0 (`n=abc`
 * stores `0`), the arithmetic rule, not a refusal. `RANDOM` draws, as in
 * every other arithmetic context, so `n=RANDOM` and a `RANDOM=RANDOM`
 * seed both advance the generator. The assignments the expression makes
 * are kept for the session view to land (`landCoercion`): bash binds `x` in
 * `n='x=5'` and in `RANDOM='x=5'`, before the error too if the expression
 * then fails. A malformed expression throws ArithError with the
 * offending text leading, the way every caller voices it; a write to a
 * readonly name ends the shell (ExitSignal), as bash's coercion does, where
 * a seed (`evaluate`) reports it the way it reports a malformed one.
 */
class IntegerCoercion {
  readonly reader: RandomReader
  readonly writes: ArithWrite[] = []

  constructor(private readonly session: SessionState) {
    this.reader = randomReader(session)
  }

  readonly run = (text: string, added: string | null = null): string => {
    try {
      return this.evaluate(text, added)
    } catch (err) {
      if (err instanceof ReadonlyError) throw err.signal(true)
      throw err
    }
  }

  /**
   * The value `text` evaluates to, keeping the writes it made before an
   * ArithError or a ReadonlyError. With `added`, the two sides of an
   * integer `+=` (`appended`) evaluate in turn in one evaluation and add:
   * the second sees what the first assigned, and an error names the side
   * that made it, as bash's does (`N+=1+` is `1+: syntax error`).
   */
  evaluate(text: string, added: string | null = null): string {
    const session = this.session
    // Inside a `declare -g` the expression still reads the function's
    // scope, as bash's does (`local H=2; declare -gi G=H` stores 2), while
    // the value lands on the global.
    const reachAgain = stepBack(session)
    let result: ArithResult
    try {
      result = sessionArith(session, text, this.reader, false, added)
    } catch (err) {
      if (err instanceof ArithError || err instanceof ReadonlyError) {
        this.writes.push(...err.writes)
      }
      throw err
    } finally {
      reachAgain()
    }
    this.writes.push(...result.writes)
    return result.value.toString()
  }
}

/**
 * Land the assignments a coercion made, each through the session view, in the scope
 * it read, then settle its `RANDOM` draws. Inside a `declare -g` that is the
 * function's: `local G=3; declare -gi G='G=G+10'` leaves the local at 13 and
 * stores 13 globally, as bash's does (`stepBack`).
 */
async function landCoercion(
  session: SessionState,
  store: SessionView['set'],
  coercion: IntegerCoercion,
): Promise<void> {
  const reachAgain = stepBack(session)
  try {
    await landWrites(session, store, coercion.writes)
  } finally {
    reachAgain()
  }
  coercion.reader.settle()
}

/**
 * Evaluate `text` as an `-i` write coerces it, land what it assigns through
 * `view`, and give back the value: a `declare -ni r=M` value, which bash
 * evaluates before refusing the reference (`M='X=5'` sets X), and its
 * `r+=M` form, whose `added` text evaluates after `text` in the same
 * evaluation and adds to it. Inside a `declare -g` it reads the
 * function's scope, as the coercion does. A hidden name throws
 * PolicyDenied and a readonly one ExitSignal, which ends the shell as
 * bash's does, the assignments before it landed; a malformed text throws
 * ArithError once the ones before the error land.
 */
export async function evaluateInteger(
  session: SessionState,
  view: SessionView,
  text: string,
  added: string | null = null,
): Promise<string> {
  const coercion = new IntegerCoercion(session)
  try {
    return coercion.run(text, added)
  } finally {
    await landCoercion(
      session,
      (name, value, followRef, assigned) => view.set(name, value, followRef, assigned),
      coercion,
    )
  }
}

/**
 * What a `+=` hands `setVar`: the held text then the added one, or on an
 * integer the held text with the added one as `added`, the two evaluating
 * there in turn and summing behind the store's refusals. The held value
 * evaluates too, so `n='x=5'; declare -i n; n+=x` stores 10, and an empty
 * side counts as 0. An array extends element 0 and a map key `"0"`
 * (`S=x; declare -a S+=y` gives `([0]="xy")`), and `held` is null when unset.
 */
export function appended(
  held: ShellValue | null,
  added: string,
  integer: boolean,
): [string, string | null] {
  const text =
    typeof held === 'string' ? held : Array.isArray(held) ? arrayGet(held, 0) : (held?.['0'] ?? '')
  return integer ? [text, added] : [text + added, null]
}

export function ensureVarVisible(session: SessionState, name: string): void {
  if (varHidden(session.visibility, name)) {
    throw new PolicyDenied(`${name}: permission denied`, name)
  }
}

async function setVar(
  session: SessionState,
  policies: Policies | null,
  name: string,
  value: ShellValue,
  followRef = true,
  diagnostics?: (string | Uint8Array)[],
  assigned: ReadonlySet<number | string> | null = null,
  added: string | null = null,
): Promise<void> {
  if (followRef) name = deref(session, name) || name
  ensureVarVisible(session, name)
  if (envIsReadonly(session, name, false)) {
    throw new ReadonlyVariableError(name)
  }
  // Attributes belong to the name, not to the value, so a plain
  // assignment keeps them: `declare -i n; n=3` stays an integer. The old
  // two-container store had to remember to evict the name from whichever
  // container it was not landing in; one record cannot disagree with
  // itself that way.
  const existing = sessionEntry(session.vars, name)
  // The value-shaping attributes (`-i -l -u`) apply here, at the write,
  // which is where bash applies them: `declare -l s; s=ABC` stores `abc`,
  // so every reader agrees without per-read work. `-i` evaluates against
  // the visible env, and a bad expression throws the arithmetic error
  // as bash does. Coercion runs before the gate so a rule judges the
  // value that will land: `declare -l profile; profile=ADMIN` stores `admin`,
  // and a rule refusing `admin` must see that, not the raw text.
  const coercion = new IntegerCoercion(session)
  const store: SessionView['set'] = (name, value, followRef, assigned) =>
    setVar(session, policies, name, value, followRef, diagnostics, assigned)
  let shaped: ShellValue = value
  if (existing !== undefined && existing.attrs.size > 0) {
    try {
      shaped = coerceValue(value, existing.attrs, (text) => coercion.run(text, added), assigned)
    } catch (err) {
      // bash bound what the expression assigned before it failed
      // (`declare -i n; x='y=5,1/0'; n=x` leaves y at 5, and a RANDOM
      // seed in it seeds); they land, gated, before the refusal reports.
      if (err instanceof ArithError || err instanceof ExitSignal) {
        await landCoercion(session, store, coercion)
      }
      throw err
    }
  }
  await preSessionGate(policies, {
    plane: 'env',
    verb: 'set',
    key: name,
    value: gateRendering(shaped),
    sessionId: session.sessionId,
  })
  if (name === RANDOM && session.randomSeed !== RANDOM_UNSET && typeof shaped === 'string') {
    // A seed that fails or writes a readonly name seeds nothing: its
    // earlier writes land and the error is reported, but the line goes on,
    // unless the write was in a subscript.
    try {
      const value = BigInt(coercion.evaluate(shaped))
      const modulus = BigInt(RANDOM_MODULUS)
      session.randomState = Number(((value % modulus) + modulus) % modulus)
    } catch (err) {
      if (err instanceof ExitSignal) await landCoercion(session, store, coercion)
      if (!(err instanceof ArithError || err instanceof ReadonlyError)) throw err
      await landCoercion(session, store, coercion)
      if (err instanceof ReadonlyError && (err.inSubscript || diagnostics === undefined)) {
        throw err.signal()
      }
      if (diagnostics === undefined) throw err
      diagnostics.push(err.message)
      return
    }
    session.randomSeed = shaped
    session.randomLast = 0
  }
  noteRandomKind(session, name, shaped)
  // The assignments the coercion or the seed made land now, gated each,
  // before the name they were made for.
  await landCoercion(session, store, coercion)
  // A reference cannot hold an array: one landing on an unaimed
  // `declare -n` record drops the mark (`withValue`) and bash says so
  // (`declare -n r; r=(x)`). A declaration that named the kind (`-a`,
  // `-A`) took the mark off before writing, silently, as bash does.
  if (
    diagnostics !== undefined &&
    existing?.attrs.has(VarAttr.Nameref) === true &&
    typeof shaped === 'object'
  ) {
    diagnostics.push(encodeText(`bash: warning: ${name}: removing nameref attribute\n`))
  }
  let stored = existing === undefined ? makeVar(shaped) : withValue(existing, shaped)
  // An agent write to a managed name shadows session-locally: the
  // pointer drops and the record becomes a plain variable for this
  // session only. Only the host-tier fill step writes pointer-keeping
  // records, and it goes directly into `session.vars`, not here.
  if (stored.managed !== undefined) stored = detach(stored)
  // `set -a` marks every name assigned *while it is on*, which is why
  // it is read here at write time rather than applied to the session in
  // bulk when the option flips: `B=1; set -a; C=2; set +a; D=3` exports
  // only C.
  if (session.shellOptions.allexport === true) {
    stored = withAttr(stored, VarAttr.Export)
  }
  setSessionEntry(session.vars, name, stored)
}

/**
 * Drop one variable through the session plane's gate; a missing name
 * is quiet. A hidden name is a quiet no-op that writes nothing:
 * hidden reads as unset, bash's unset of a missing name is quiet, and
 * popping the real value would let a session mutate state it cannot
 * see. Throws ReadonlyVariableError when the name is readonly,
 * PolicyDenied when a preSession policy refuses the write.
 */
async function unsetVar(
  session: SessionState,
  policies: Policies | null,
  name: string,
  followRef = true,
): Promise<void> {
  if (followRef) name = deref(session, name) || name
  if (varHidden(session.visibility, name)) return
  if (envIsReadonly(session, name, false)) {
    throw new ReadonlyVariableError(name)
  }
  await preSessionGate(policies, {
    plane: 'env',
    verb: 'unset',
    key: name,
    value: null,
    sessionId: session.sessionId,
  })

  drop(session, name)
  // bash: unsetting RANDOM strips its special meaning for good.
  if (name === RANDOM) session.randomSeed = RANDOM_UNSET
}

function place(session: SessionState, name: string, v: ShellVar | null): void {
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  if (v === null) delete session.vars[name]
  else setSessionEntry(session.vars, name, v)
}

/**
 * Put each name's global record in place for a `declare -g`, and return the
 * call that puts the running locals back. Outside a function, or for a name
 * no frame on the call path shadows, the global record is already in place.
 * Otherwise the running local lives in `session.vars` and the global is
 * what the *outermost* shadowing frame saved, so the two swap for the
 * declaration: its writes, marks and kind checks reach the global, and the
 * local comes back untouched, which is what GNU shows (`local G=5; declare
 * -gr G=1` leaves `$G` at 5 and writable in the function, 1 and frozen
 * outside, and a nested `declare -g` reaches past the caller's local too).
 * Arithmetic it runs still reads the locals (`stepBack`).
 */
export function reachGlobal(session: SessionState, names: readonly string[]): () => void {
  const swapped: [string, Map<string, ShellVar | null>, ShellVar | null][] = []
  for (const name of new Set(names)) {
    const outer = session.localFrames.find((frame) => frame.has(name))
    if (outer === undefined) continue
    swapped.push([name, outer, sessionEntry(session.vars, name) ?? null])
    place(session, name, outer.get(name) ?? null)
  }
  session.reached = swapped
  return () => {
    for (const [name, outer, running] of session.reached) {
      outer.set(name, sessionEntry(session.vars, name) ?? null)
      place(session, name, running)
    }
    session.reached = []
  }
}

/**
 * Put the locals a running `declare -g` set aside back in place for one
 * arithmetic evaluation or the writes it made, and return the call that
 * reaches the globals again, keeping what those writes gave the locals.
 */
function stepBack(session: SessionState): () => void {
  const reached = session.reached.map(
    ([name]) => [name, sessionEntry(session.vars, name) ?? null] as const,
  )
  for (const [name, , running] of session.reached) place(session, name, running)
  return () => {
    session.reached = session.reached.map(([name, outer]) => [
      name,
      outer,
      sessionEntry(session.vars, name) ?? null,
    ])
    for (const [name, v] of reached) place(session, name, v)
  }
}

/** The innermost scope on the call path that saved `name`. */
function shadowingFrame(
  session: SessionState,
  name: string,
): Map<string, ShellVar | null> | undefined {
  for (let i = session.localFrames.length - 1; i >= 0; i--) {
    const frame = session.localFrames[i]
    if (frame?.has(name) === true) return frame
  }
  return undefined
}

/**
 * Remove a variable as bash's `unset` does.
 *
 * A name the running function made local stays unset until it returns.
 * A name an enclosing scope shadows, a caller's `local` or the temporary
 * environment of `x=1 f`, is that scope's to lose: the unset reveals the
 * value it saved, and the name holds that value from then on (GNU:
 * `x=old; x=pre f` where f runs `unset x` reads `old` inside f and after
 * it).
 */
function drop(session: SessionState, name: string): void {
  const frame = shadowingFrame(session, name)
  const saved = frame?.get(name) ?? null
  if (frame !== undefined && frame !== session.localVars && name !== RANDOM) {
    frame.delete(name)
    if (saved !== null) {
      setSessionEntry(session.vars, name, saved)
      return
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete session.vars[name]
}

/**
 * Let a temporary-environment variable outlive its call.
 *
 * bash keeps a name that `x=1 f` put in front of a function once
 * something inside runs `export x` or `readonly x`: x still holds its
 * value after f returns, where otherwise the caller's comes back.
 */
export function outliveCall(session: SessionState, name: string): void {
  const frame = shadowingFrame(session, name)
  if (frame instanceof TempEnv) frame.delete(name)
}

/**
 * Whether the running function's call assigned `name` in front.
 *
 * `x=1 f` puts `x` in f's temporary environment, which sits right under
 * f's own frame of locals.
 */
export function inCallEnv(session: SessionState, name: string): boolean {
  const below = session.localFrames[session.localFrames.length - 2]
  return below instanceof TempEnv && below.has(name)
}

/**
 * The positional parameters in scope.
 *
 * Inside a function they are the function's own, even when it was called
 * with none: bash's `f` run bare sees `$#` as 0, never its caller's
 * count. Outside every function they are the shell's.
 */
export function positionalParams(session: SessionState, callStack: CallStack | null): string[] {
  if (callStack !== null && callStack.depth > 1) return callStack.getAllPositional()
  return session.positionalArgs
}

/**
 * Replace the positional parameters in scope.
 *
 * `set --` and `shift` inside a function change the function's own and
 * leave the caller's alone, as bash's do.
 */
export function setPositionalParams(
  session: SessionState,
  callStack: CallStack | null,
  values: string[],
): void {
  if (callStack !== null && callStack.depth > 1) callStack.setPositional(values)
  else session.positionalArgs = values
}

/**
 * Record the caller's record before a `local` shadows it, once per frame.
 *
 * `RANDOM` parks its generator marker too: a local `RANDOM` is an ordinary
 * variable for the function's extent (`local RANDOM=5; echo $RANDOM`
 * prints 5, and `local RANDOM=(7)` leaves the caller's generator alone),
 * and `restoreLocals` hands the marker back.
 */
export function shadowLocal(
  session: SessionState,
  locals: Map<string, ShellVar | null>,
  name: string,
): void {
  if (locals.has(name)) return
  locals.set(name, sessionEntry(session.vars, name) ?? null)
  if (name === RANDOM) {
    session.localRandom.push(session.randomSeed)
    session.randomSeed = RANDOM_UNSET
  }
}

/**
 * Put a returning function's shadowed records back.
 *
 * Deliberate divergence: bash reseeds the global generator when a local
 * `RANDOM` is popped (`RANDOM=42; f(){ local RANDOM; }; f; echo $RANDOM`
 * prints 11074 where 17772 was next); mirage resumes the caller's
 * sequence where it left off.
 */
export function restoreLocals(session: SessionState, locals: Map<string, ShellVar | null>): void {
  for (const [key, old] of locals) {
    if (old === null) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete session.vars[key]
    } else {
      setSessionEntry(session.vars, key, old)
    }
  }
  if (locals.has(RANDOM)) session.randomSeed = session.localRandom.pop() ?? null
}

/**
 * The session plane's view: five facts bound to one session.
 *
 * The one constructor every tier uses — builtins, the command
 * dispatcher, a bare unit test — so the gate cannot be skipped by
 * picking a different entry point. The view is the whole capability: it
 * carries no handle back to the raw session.
 */
/**
 * Write a variable without consulting the gate.
 *
 * For seeding a session before it is handed out -- the embedder
 * populating an environment, a test arranging state. `visibleArrays`
 * already names this case ("the embedder can seed session.arrays before
 * narrowing"). Anything reached from a command line goes through
 * `SessionView.set` instead, which is the whole point of the store being
 * read-only from outside.
 */
export function seedVar(session: SessionState, name: string, value: ShellValue): void {
  const existing = sessionEntry(session.vars, name)
  setSessionEntry(
    session.vars,
    name,
    existing === undefined ? makeVar(value) : withValue(existing, value),
  )
  noteRandomKind(session, name, value)
}

/**
 * Turn one attribute on or off, creating the name if needed.
 *
 * bash's `readonly NAME` / `export NAME` on a name that does not exist
 * yet marks it anyway, and the name stays *unset*: GNU prints
 * `declare -r ONLY` with no value and `${ONLY-d}` still expands to `d`.
 * So the record is created with no value, not with an empty string.
 *
 * A null attribute changes no attribute and only ensures the name
 * exists, which is what a bare `local L` / `declare D` does: GNU answers
 * `declare -- L` and `${L-d}` still expands to `d`, so those two cannot
 * route through a value writer either.
 */
export function setAttr(
  session: SessionState,
  name: string,
  attr: VarAttr | null,
  on = true,
): void {
  const existing = sessionEntry(session.vars, name) ?? makeVar()
  setSessionEntry(session.vars, name, attr === null ? existing : withAttr(existing, attr, on))
}

/**
 * Turn one attribute on or off through the session plane's gate.
 *
 * The no-value writer beside `setVar`. `export NAME`, `readonly NAME`
 * and a bare `local NAME` on a fresh name write no value at all -- the
 * name stays unset and merely declared -- so routing them through
 * `setVar` would have to invent one, and inventing `''` is exactly the
 * divergence that made `export Z` show up in `env` and `${L-d}` stop
 * expanding to `d`. A null attribute declares the name and changes no
 * attribute.
 *
 * Gated all the same, because a mark is still a session write: a
 * hidden name refuses, and `preSession` sees it with a null value,
 * which is how a rule tells a mark from an assignment if it cares.
 * Skipping the gate here would let a line the agent types put an
 * attribute on a name the deployment refused it.
 */
async function markVar(
  session: SessionState,
  policies: Policies | null,
  name: string,
  attr: VarAttr | null,
  on: boolean,
  followRef = true,
): Promise<void> {
  // `readonly r` and `export r` on a reference mark what it points at,
  // and `declare -rn r` the reference itself (`followRef` false); the
  // nameref attribute always belongs to the reference's own record.
  if (followRef && attr !== VarAttr.Nameref) name = deref(session, name) || name
  ensureVarVisible(session, name)
  await preSessionGate(policies, {
    plane: 'env',
    verb: 'set',
    key: name,
    value: null,
    sessionId: session.sessionId,
  })
  setAttr(session, name, attr, on)
}

export function sessionView(
  session: SessionState,
  policies: Policies | null = null,
  diagnostics?: (string | Uint8Array)[],
): SessionView {
  return {
    get: (name) => envGet(session, name),
    snapshot: () => envSnapshot(session),
    set: (name, value, followRef = true, assigned = null, added = null) =>
      setVar(session, policies, name, value, followRef, diagnostics, assigned, added),
    unset: (name, followRef = true) => unsetVar(session, policies, name, followRef),
    mark: (name, attr, on, followRef = true) =>
      markVar(session, policies, name, attr, on, followRef),
    isReadonly: (name, followRef = true) => envIsReadonly(session, name, followRef),
    profile: () => session.profile,
  }
}

// The names the shell maintains itself (`seedVar`'s second caller): a `cd`
// writes the first two and `[[ =~ ]]` the third, ungated, because they are
// the shell's to keep current rather than the session's to admit. Mirrors
// Python `SHELL_BOOKKEEPING`.
export const SHELL_BOOKKEEPING: ReadonlySet<string> = new Set(['PWD', 'OLDPWD', 'BASH_REMATCH'])

/**
 * The value a `preSession` hook is shown for one variable: a scalar as
 * itself, an indexed array as its present elements joined by spaces, an
 * associative one in sorted-key order, and null for a variable that is
 * declared but unset. One rendering, so a rule reads the same text whether
 * the write came from a typed line or a restore. Mirrors Python
 * `gate_rendering`.
 */
export function gateRendering(value: ShellValue | null): string | null {
  if (value === null) return null
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return arrayValues(value).join(' ')
  return Object.keys(value)
    .sort(compareCodePoints)
    .map((k) => value[k])
    .join(' ')
}

/**
 * Vet a variable table a snapshot restores through the session gate.
 *
 * A snapshot is the one env input the deployment did not author, so the
 * `preSession` rule that refuses a name on a typed line has to see the
 * restore too. Every restored variable fires the gate as a `set` of its
 * rendered value before any of them lands, and a refusal aborts the load
 * with the `PolicyDenied` a live `export` of that name reports, rather
 * than dropping the one variable: a partial restore is a workspace whose
 * state matches no snapshot. The shell's own bookkeeping
 * (`SHELL_BOOKKEEPING`) is exempt here as it is live. Null policies gate
 * nothing. Mirrors Python `gate_restored_vars`.
 */
export async function gateRestoredVars(
  policies: Policies | null,
  sessionId: string,
  table: Record<string, ShellVar>,
): Promise<void> {
  for (const [name, variable] of Object.entries(table)) {
    if (SHELL_BOOKKEEPING.has(name)) continue
    await preSessionGate(policies, {
      plane: 'env',
      verb: 'set',
      key: name,
      value: gateRendering(variable.value),
      sessionId,
    })
  }
}
