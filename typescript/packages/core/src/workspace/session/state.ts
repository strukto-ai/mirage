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

import type { SessionView } from '../../ops/types.ts'
import { PolicyDenied, preSessionGate, type Policies } from '../../policy/index.ts'
import { evaluateArith } from '../../shell/arith.ts'
import {
  arrayExtent,
  arrayGet,
  arrayHas,
  arrayValues,
  arrayWith,
  makeArray,
  type ShellArray,
} from '../../shell/array.ts'
import { PIPESTATUS, RANDOM, RANDOM_MODULUS, RANDOM_UNSET } from '../../shell/constants.ts'
import { ArithError } from '../../shell/errors.ts'
import type { ArithWrite, ElementOps } from '../../shell/types.ts'
import { varHidden } from '../../utils/hidden.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { ReadonlyVariableError } from './errors.ts'
import { draw, initialSeed } from './rng.ts'
import { ownRecord, sessionEntry, setSessionEntry } from './session.ts'
import type { ShellValue, ShellVar } from '../../shell/variable.ts'
import { coerceValue, detach, makeVar, VarAttr, withAttr, withValue } from '../../shell/variable.ts'
import type { Session } from './session.ts'

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
 */
export function envSnapshot(session: Session): Record<string, string> {
  const out = ownRecord<string>()
  for (const [name, v] of Object.entries(session.vars)) {
    if (
      typeof v.value === 'string' &&
      v.attrs.has(VarAttr.Export) &&
      !varHidden(session.hiddenVars, name)
    ) {
      out[name] = v.value
    }
  }
  return out
}

/**
 * The names carrying the export attribute, sorted, hidden removed.
 *
 * Wider than `envSnapshot`'s keys by exactly the unset ones: a name
 * `export Z` marked but never assigned is listed by `export -p` as
 * `declare -x Z` while staying out of the environment. So the printers
 * read this and the process view reads `envSnapshot`, rather than one
 * of them re-deriving the other's filter.
 */
export function exportedNames(session: Session): string[] {
  const out: string[] = []
  for (const [name, v] of Object.entries(session.vars)) {
    if (v.attrs.has(VarAttr.Export) && !varHidden(session.hiddenVars, name)) {
      out.push(name)
    }
  }
  return out.sort(compareCodePoints)
}

/**
 * The name a `declare -n` reference points at, null otherwise. Null
 * also for a reference declared but not yet aimed (`declare -n r`
 * before `r=v`): bash treats the first assignment as naming the target,
 * so until then it stands for nothing.
 */
export function namerefTarget(session: Session, name: string): string | null {
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
export function deref(session: Session, name: string): string {
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
export function envGet(session: Session, name: string): string | null {
  const resolved = deref(session, name)
  if (varHidden(session.hiddenVars, resolved)) return null
  const v = sessionEntry(session.vars, resolved)
  return v !== undefined && typeof v.value === 'string' ? v.value : null
}

/**
 * Whether `readonly` has marked the name.
 *
 * A hidden name answers false: isReadonly speaks about the session's
 * visible world, and calling a name that reads as unset "readonly"
 * would leak it.
 */
function envIsReadonly(session: Session, name: string): boolean {
  const resolved = deref(session, name)
  if (varHidden(session.hiddenVars, resolved)) return false
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
export function visibleEnv(session: Session): Record<string, string> {
  const out = ownRecord<string>()
  for (const [name, v] of Object.entries(session.vars)) {
    if (typeof v.value === 'string' && !varHidden(session.hiddenVars, name)) {
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
export function visibleArrays(session: Session): Record<string, ShellArray> {
  const out = ownRecord<ShellArray>()
  for (const [name, v] of Object.entries(session.vars)) {
    if (Array.isArray(v.value) && !varHidden(session.hiddenVars, name)) {
      out[name] = v.value
    }
  }
  // PIPESTATUS is the session's record, never the store's: an assignment
  // to it is ignored, as bash ignores one, because the record answers
  // before the store.
  if (!varHidden(session.hiddenVars, PIPESTATUS)) {
    out[PIPESTATUS] = session.pipeStatus.map((code) => String(code))
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
export function visibleAssocs(session: Session): Record<string, Record<string, string>> {
  const out = ownRecord<Record<string, string>>()
  for (const [name, v] of Object.entries(session.vars)) {
    if (
      v.value !== null &&
      typeof v.value === 'object' &&
      !Array.isArray(v.value) &&
      !varHidden(session.hiddenVars, name)
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
 * Resolve an indexed subscript in arithmetic context.
 *
 * bash evaluates indexed subscripts as arithmetic (`a[i+1]`); an
 * unresolvable expression indexes element 0, mirroring bash's
 * unset-name-is-zero arithmetic rule.
 */
export function elementIndex(
  subscript: string,
  env: Readonly<Record<string, string>>,
  elements: ElementOps | null = null,
  readVar: ((name: string) => string | null) | null = null,
  wroteVar: ((name: string, value: string) => void) | null = null,
): number {
  const trimmed = subscript.trim()
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed)
  try {
    return Number(evaluateArith(subscript, env, 0, elements, readVar, wroteVar).value)
  } catch (error) {
    if (error instanceof ArithError) return 0
    throw error
  }
}

/**
 * The `ElementOps` implementation bound to one session.
 *
 * A class rather than closures because the resolver recurses: an
 * indexed subscript is arithmetic and may itself hold an element
 * reference, so `resolve` hands the evaluator the same pair of
 * callbacks it is one of. It lives beside the other reader projections
 * because the session door needs it too: the `-i` coercion evaluates
 * `n=a[1]+1` at the write, and a resolver that imported the door would
 * close a cycle.
 */
class SessionElements implements ElementOps {
  constructor(
    private readonly session: Session,
    private readonly reader: RandomReader | null = null,
  ) {}

  isAssoc(name: string): boolean {
    return visibleAssocs(this.session)[name] !== undefined
  }

  resolve(name: string, subscript: string, env: Readonly<Record<string, string>>): string {
    if (visibleAssocs(this.session)[name] !== undefined) {
      return stripKeyQuotes(subscript)
    }
    const reader = this.reader
    let idx = elementIndex(
      subscript,
      env,
      sessionElements(this.session, reader),
      reader?.read ?? null,
      reader?.wrote ?? null,
    )
    if (idx < 0) {
      const arr = visibleArrays(this.session)[name]
      if (arr !== undefined) idx += arrayExtent(arr)
      else if (envGet(this.session, name) !== null) idx += 1
      if (idx < 0) throw new ArithError(`${name}[${subscript}]: bad array subscript`)
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

/** Element callbacks bound to one session, for `evaluateArith`. `reader`
 * is the expression's `RANDOM` reader, so a subscript draws from the
 * same generator as the expression around it; null where nothing
 * draws. */
export function sessionElements(session: Session, reader: RandomReader | null = null): ElementOps {
  return new SessionElements(session, reader)
}

/**
 * The whole variable one arithmetic write produces. A scalar is itself;
 * an element is the array it lands in, the way `assignElement` lands
 * one, so a refusal never leaves a write half-applied.
 */
function writtenValue(session: Session, write: ArithWrite): ShellValue {
  if (write.key === null) return write.value
  const assoc = visibleAssocs(session)[write.name]
  if (assoc !== undefined) return { ...assoc, [write.key]: write.value }
  const arr = visibleArrays(session)[write.name]
  return arrayWith(arr ?? makeArray([]), Number(write.key), write.value)
}

/**
 * An indexed subscript resolved outside an arithmetic expression:
 * `${a[i]}`, `a[i]=v`, `unset 'a[i]'`, `[[ -v a[i] ]]`.
 *
 * The subscript is arithmetic, so it may assign (`a[x=3]`) and seed
 * (`a[RANDOM=42]`), and bash binds those as it evaluates them. Each
 * lands through the door once the index is known, then the `RANDOM`
 * reader replays the draws made after the seed. A subscript that fails
 * to evaluate lands what it assigned before failing and then throws, the
 * subscript text leading the message, since bash aborts the line on it
 * (`${a[1/0]}` is `1/0: division by 0`) rather than reading element 0.
 * `view` is the gated door; null lands the writes ungated, outside a
 * workspace. Throws what the door throws too: a PolicyDenied, a
 * ReadonlyVariableError, or an ArithError from a `-i` name refusing the
 * value.
 */
export async function subscriptIndex(
  session: Session,
  subscript: string,
  view: SessionView | null = null,
): Promise<number> {
  const trimmed = subscript.trim()
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed)
  const reader = randomReader(session)
  let idx = 0
  let writes: readonly ArithWrite[]
  let error: ArithError | null = null
  try {
    const result = evaluateArith(
      subscript,
      visibleEnv(session),
      0,
      sessionElements(session, reader),
      reader.read,
      reader.wrote,
    )
    idx = Number(result.value)
    writes = result.writes
  } catch (err) {
    if (!(err instanceof ArithError)) throw err
    error = err
    writes = err.writes
  }
  for (const write of writes) {
    const value = writtenValue(session, write)
    if (view !== null) await view.set(write.name, value)
    else await setVar(session, null, write.name, value)
  }
  reader.settle()
  if (error !== null) throw new ArithError(`${subscript.trim()}: ${error.message}`)
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
export function seedFrom(word: string, session: Session): number {
  const value = evaluateArith(word, visibleEnv(session), 0, sessionElements(session)).value
  const modulus = BigInt(RANDOM_MODULUS)
  return Number(((value % modulus) + modulus) % modulus)
}

/** Draw from the session generator, or null after RANDOM is unset.
 * Shell assignments validate and seed at the session door. A host-seeded
 * variable is consumed here on its first read. Reseeding resets repeat
 * suppression to zero independently of the stored word. */
export function nextRandom(session: Session, stored: string | undefined): number | null {
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
 * the session door, which lands it gated after evaluation, so the
 * evaluator tells the reader of each assignment as it is made (`wrote`),
 * the reader seeds a scratch generator the way the door will and draws
 * from that, and `settle` replays the draws on the session once the
 * door has seeded it: the session ends where bash's does, seeded and
 * advanced by every read since the last assignment, and the write still
 * reaches the gate as the assignment it is. Each assignment restarts
 * the scratch generator and the count, since the door lands only the
 * last value written, and the draws are replayed only if the door did
 * land it: an assignment the caller never applied leaves the session as
 * it was.
 *
 * Lives beside the door rather than with the generator because the
 * door needs it too: `RANDOM=RANDOM` draws once while the seed is
 * evaluated, then seeds with the draw, as bash's `assign_random` does
 * through `evalexp`.
 */
export class RandomReader {
  private seeded: string | null = null
  private state = 0
  private last = 0
  private draws = 0

  constructor(private readonly session: Session) {}

  private special(name: string): boolean {
    const session = this.session
    return (
      name === RANDOM && !varHidden(session.hiddenVars, name) && session.randomSeed !== RANDOM_UNSET
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

  /** Replay the scratch draws on the session generator, once the door
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
 * bash's `convert_var_to_array` drops the dynamic value and the assign
 * hook, so `RANDOM=(1 2)`, `declare -a RANDOM`, `RANDOM[1]=5` and
 * `RANDOM+=(3)` all leave an ordinary array that `$RANDOM` reads element
 * 0 of, for good, as `unset RANDOM` does. Every store door calls this,
 * gated or not, since a host seeding an array onto the name means the
 * same thing.
 */
export function noteRandomKind(session: Session, name: string, value: ShellValue): void {
  if (name === RANDOM && typeof value !== 'string') session.randomSeed = RANDOM_UNSET
}

/**
 * The scalar an array conversion keeps as element 0.
 *
 * bash's `convert_var_to_array` copies the variable's current value into
 * element 0, and for a live `RANDOM` looking the name up is what draws:
 * `RANDOM[1]=5` leaves `[0]` holding one draw and `declare -a RANDOM` one
 * alone, after which the array is ordinary.
 */
export function conversionScalar(session: Session, name: string): string | undefined {
  if (name === RANDOM) {
    const drawn = nextRandom(session, visibleEnv(session)[RANDOM])
    if (drawn !== null) return String(drawn)
  }
  return session.env[name]
}

/** Bind arithmetic `$RANDOM` reads to a session. */
export function randomReader(session: Session): RandomReader {
  return new RandomReader(session)
}

/**
 * The `-i` coercion and the `RANDOM` seed, as one evaluation. The
 * incoming text evaluates as arithmetic against the visible env, element
 * references resolving through the session's resolver, so `n=x+1` sees
 * `x` and `n=a[1]+1` the element; an unresolvable name is 0 (`n=abc`
 * stores `0`), the arithmetic rule, not a refusal. `RANDOM` draws, as in
 * every other arithmetic context, so `n=RANDOM` and a `RANDOM=RANDOM`
 * seed both advance the generator. The assignments the expression makes
 * are kept for the door to land (`landCoercion`): bash binds `x` in
 * `n='x=5'` and in `RANDOM='x=5'`, before the error too if the expression
 * then fails. A malformed expression throws ArithError with the
 * offending text leading, the way every caller voices it.
 */
class IntegerCoercion {
  readonly reader: RandomReader
  readonly writes: ArithWrite[] = []

  constructor(private readonly session: Session) {
    this.reader = randomReader(session)
  }

  readonly run = (text: string): string => {
    const session = this.session
    try {
      const result = evaluateArith(
        text,
        visibleEnv(session),
        0,
        sessionElements(session, this.reader),
        this.reader.read,
        this.reader.wrote,
      )
      this.writes.push(...result.writes)
      return result.value.toString()
    } catch (err) {
      if (err instanceof ArithError) {
        this.writes.push(...err.writes)
        throw new ArithError(`${text}: ${err.message}`)
      }
      throw err
    }
  }
}

/**
 * Land the assignments a coercion made, each through the door, then
 * settle its `RANDOM` draws.
 */
async function landCoercion(
  session: Session,
  policies: Policies | null,
  coercion: IntegerCoercion,
): Promise<void> {
  for (const write of coercion.writes) {
    await setVar(session, policies, write.name, writtenValue(session, write))
  }
  coercion.reader.settle()
}

export function ensureVarVisible(session: Session, name: string): void {
  if (varHidden(session.hiddenVars, name)) {
    throw new PolicyDenied(`${name}: permission denied`, name)
  }
}

async function setVar(
  session: Session,
  policies: Policies | null,
  name: string,
  value: ShellValue,
  followRef = true,
): Promise<void> {
  if (followRef) name = deref(session, name) || name
  ensureVarVisible(session, name)
  if (envIsReadonly(session, name)) {
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
  let shaped: ShellValue = value
  if (existing !== undefined && existing.attrs.size > 0) {
    try {
      shaped = coerceValue(value, existing.attrs, coercion.run)
    } catch (err) {
      // bash bound what the expression assigned before it failed
      // (`declare -i n; x='y=5,1/0'; n=x` leaves y at 5, and a RANDOM
      // seed in it seeds); they land, gated, before the refusal reports.
      if (err instanceof ArithError) await landCoercion(session, policies, coercion)
      throw err
    }
  }
  const rendered =
    typeof shaped === 'string'
      ? shaped
      : Array.isArray(shaped)
        ? arrayValues(shaped).join(' ')
        : Object.keys(shaped)
            .sort(compareCodePoints)
            .map((k) => shaped[k])
            .join(' ')
  await preSessionGate(policies, {
    plane: 'env',
    verb: 'set',
    key: name,
    value: rendered,
    sessionId: session.sessionId,
  })
  if (name === RANDOM && session.randomSeed !== RANDOM_UNSET && typeof shaped === 'string') {
    try {
      const value = BigInt(coercion.run(shaped))
      const modulus = BigInt(RANDOM_MODULUS)
      session.randomState = Number(((value % modulus) + modulus) % modulus)
    } catch (err) {
      if (!(err instanceof ArithError)) throw err
      session.diagnostics.push(err.message)
      await landCoercion(session, policies, coercion)
      return
    }
    session.randomSeed = shaped
    session.randomLast = 0
  }
  noteRandomKind(session, name, shaped)
  // The assignments the coercion or the seed made land now, gated each,
  // before the name they were made for.
  await landCoercion(session, policies, coercion)
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
  session: Session,
  policies: Policies | null,
  name: string,
  followRef = true,
): Promise<void> {
  if (followRef) name = deref(session, name) || name
  if (varHidden(session.hiddenVars, name)) return
  if (envIsReadonly(session, name)) {
    throw new ReadonlyVariableError(name)
  }
  await preSessionGate(policies, {
    plane: 'env',
    verb: 'unset',
    key: name,
    value: null,
    sessionId: session.sessionId,
  })

  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete session.vars[name]
  // bash: unsetting RANDOM strips its special meaning for good.
  if (name === RANDOM) session.randomSeed = RANDOM_UNSET
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
  session: Session,
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
export function restoreLocals(session: Session, locals: Map<string, ShellVar | null>): void {
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
 * picking a different door. The view is the whole capability: it
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
export function seedVar(session: Session, name: string, value: ShellValue): void {
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
export function setAttr(session: Session, name: string, attr: VarAttr | null, on = true): void {
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
  session: Session,
  policies: Policies | null,
  name: string,
  attr: VarAttr | null,
  on: boolean,
): Promise<void> {
  // `readonly r` and `export r` on a reference mark what it points at;
  // the nameref attribute itself belongs to the reference's own record.
  if (attr !== VarAttr.Nameref) name = deref(session, name) || name
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

export function sessionView(session: Session, policies: Policies | null = null): SessionView {
  return {
    get: (name) => envGet(session, name),
    snapshot: () => envSnapshot(session),
    set: (name, value, followRef = true) => setVar(session, policies, name, value, followRef),
    unset: (name, followRef = true) => unsetVar(session, policies, name, followRef),
    mark: (name, attr, on) => markVar(session, policies, name, attr, on),
    isReadonly: (name) => envIsReadonly(session, name),
    profile: () => session.profile,
  }
}
