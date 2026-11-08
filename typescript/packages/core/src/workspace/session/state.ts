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

import { sessionAccess, sessionVoice } from '../../context/session_context.ts'
import { memoryRoom } from '../../io/memory.ts'
import { PolicyDenied, preSessionGate, type Policies } from '../../policy/index.ts'
import type { ShellVars } from '../../rs/session.ts'
import { rawValue, varOf } from '../../rs/session.ts'
import type { Item, ShellTask } from '../../rs/shell.ts'
import { plainDecimal } from '../../shell/arith.ts'
import { arrayGet, ShellArray } from '../../shell/array.ts'
import { joinBytes } from '../../shell/bytes.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import { ArithError } from '../../shell/errors.ts'
import type { ShellValue, VarAttr } from '../../shell/variable.ts'
import { asyncContextIsolatesTasks } from '../../utils/async_context.ts'
import type { SessionView } from '../../view/types.ts'
import { argsBytes, checkEnv, entryBytes, envLimit, framesBytes, outsideBytes } from './budget.ts'
import type { SessionState } from './session.ts'
import { drive, faultError, listens, SessionGate } from './task.ts'

/**
 * Hand the session's shell the state around it that a task reads: the
 * positional parameters in scope, the special parameters, the options,
 * `max_env` and the bytes the session holds beside its variables, the bytes
 * left under `max_memory`, the running command's line and process, and the
 * voice the shell's diagnostics lead with. Mirrors Python's frame.
 */
export function frame(session: SessionState, callStack: CallStack | null = null): void {
  const calls = callStack !== null && callStack.depth > 1 ? [callStack.getAllPositional()] : []
  const limit = envLimit()
  const outside = limit === null ? 0 : outsideBytes(session)
  session.vars.shell.frame({
    positional: session.positionalArgs,
    calls,
    status: session.lastExitCode,
    pid: session.shellPid ?? session.processId ?? 0,
    lastJob: session.lastBgJobId,
    argv0: session.argv0,
    options: new Map(Object.entries(session.shellOptions)),
    shopts: new Map(Object.entries(session.shopts)),
    envLimit: limit,
    outside,
    pipeStatus: session.pipeStatus,
    functionNames: session.functionNames,
    callLines: session.callLines,
    paren: callStack?.paren ?? false,
    memoryRoom: memoryRoom(),
    line: session.lineNumber,
    bashPid: session.bashPid,
    voice: sessionVoice(session),
  })
}

/**
 * Run one gated write on the session's shell to its end: `start` makes the
 * task, given whether a policy listens. Mirrors Python's run_write.
 */
export async function runWrite(
  session: SessionState,
  policies: Policies | null,
  start: (heard: boolean) => ShellTask,
  diagnostics: (string | Uint8Array)[] | null = null,
): Promise<bigint> {
  frame(session)
  const task = start(listens(policies))
  return (await drive(task, new SessionGate(session, policies), diagnostics ?? [])) as bigint
}

/**
 * The one copy-out of a session's environment.
 *
 * Every tier that hands the env onward as a process view (a command's or
 * CLI's or a runtime's `ctx.env`, the `env` builtin) copies through here, so
 * the hidden-vars filter lands on all of them. Only exported scalars, as
 * bash's child environment: `X=hello` is absent, `export Y=world` present,
 * `export Z` (unset) absent.
 *
 * Diverges from bash on one point: bash also carries each function
 * `export -f` marked, as a `BASH_FUNC_NAME%%` entry. mirage hands those to a
 * nested shell directly (`SessionState.newShell`), so neither `env` nor a
 * runtime lists them.
 */
export function envSnapshot(session: SessionState): Record<string, string> {
  const out = Object.create(null) as Record<string, string>
  for (const [name, value] of session.vars.shell.exported()) out[name] = value
  return out
}

/**
 * The name a `declare -n` reference points at, null otherwise (also for a
 * reference not yet aimed, which stands for nothing).
 */
export function namerefTarget(session: SessionState, name: string): string | null {
  return session.vars.shell.namerefTarget(name)
}

/**
 * The variable a name stands for, following `declare -n` chains; the empty
 * name for a chain that comes back to itself, which bash reads as unset.
 */
export function deref(session: SessionState, name: string): string {
  return session.vars.shell.deref(name)
}

function visible(session: SessionState, name: string): ShellValue | null {
  const record = session.vars.shell.visible(name)
  return record === null ? null : varOf(record).value
}

/** The variable's value, null when unset, hidden or an array; a name reference reads its target. */
export function envGet(session: SessionState, name: string): string | null {
  const value = visible(session, name)
  return typeof value === 'string' ? value : null
}

/**
 * Whether `readonly` has marked the name; a hidden name is not, which would
 * leak it. `followRef` asks about what a `declare -n` reference points at; a
 * write to the reference itself asks about it.
 */
export function envIsReadonly(session: SessionState, name: string, followRef = true): boolean {
  return session.vars.shell.isReadonly(name, followRef)
}

/**
 * A live, read-only record over a shell's names, which `names` lists and
 * `lookup` reads one of at a time, as Python's Mapping views do: no copy of
 * every record per access, and an assignment into it throws.
 */
function liveRecord<T>(
  names: () => string[],
  lookup: (name: string) => T | undefined,
): Readonly<Record<string, T>> {
  return new Proxy(Object.create(null) as Record<string, T>, {
    get: (_, name) => (typeof name === 'string' ? lookup(name) : undefined),
    has: (_, name) => typeof name === 'string' && lookup(name) !== undefined,
    ownKeys: () => names(),
    getOwnPropertyDescriptor: (_, name) => {
      const value = typeof name === 'string' ? lookup(name) : undefined
      if (value === undefined) return undefined
      return { value, enumerable: true, configurable: true, writable: false }
    },
    set: () => false,
    deleteProperty: () => false,
    defineProperty: () => false,
  })
}

/**
 * The env mapping a reader tier resolves names against: live, read-only,
 * hidden names left out, a lookup following references. Mirrors Python's
 * visible_env.
 */
export function visibleEnv(session: SessionState): Readonly<Record<string, string>> {
  return liveRecord(
    () => session.vars.shell.visibleNames('scalar'),
    (name) => envGet(session, name) ?? undefined,
  )
}

/**
 * The indexed arrays a reader tier resolves names against. `PIPESTATUS` and
 * `FUNCNAME` answer a lookup from the shell's own bookkeeping, which the
 * frame hands it, and never list: bash's `declare -p PIPESTATUS` is `not
 * found`. Mirrors Python's visible_arrays.
 */
export function visibleArrays(session: SessionState): Readonly<Record<string, ShellArray>> {
  return liveRecord(
    () => session.vars.shell.visibleNames('indexed'),
    (name) => {
      frame(session)
      const raw = session.vars.shell.indexed(name)
      return raw === null ? undefined : new ShellArray(raw)
    },
  )
}

/** The associative arrays a reader tier resolves names against. Mirrors Python's visible_assocs. */
export function visibleAssocs(
  session: SessionState,
): Readonly<Record<string, Record<string, string>>> {
  return liveRecord(
    () => session.vars.shell.visibleNames('assoc'),
    (name) => {
      const value = visible(session, name)
      return value !== null && typeof value === 'object' && !(value instanceof ShellArray)
        ? value
        : undefined
    },
  )
}

/**
 * An indexed subscript resolved outside an arithmetic expression: `a[i]=v`,
 * `unset 'a[i]'`. It is arithmetic, so it may assign (`a[x=3]`) and seed
 * (`a[RANDOM=42]`); each lands through the gate. One that fails lands what it
 * assigned before failing, then throws. Mirrors Python's subscript_index.
 */
export async function subscriptIndex(
  session: SessionState,
  subscript: string,
  policies: Policies | null = null,
): Promise<bigint> {
  const plain = plainDecimal(subscript)
  if (plain !== null) return plain
  const shell = session.vars.shell
  return runWrite(session, policies, (heard) => shell.index(subscript, { listens: heard }))
}

/**
 * `subscriptIndex` whose failure ends the line, in bash's words: `unset
 * 'a[1/0]'` aborts with `1/0: division by 0`. Mirrors Python's
 * fatal_subscript_index.
 */
export async function fatalSubscriptIndex(
  session: SessionState,
  subscript: string,
  policies: Policies | null = null,
): Promise<bigint> {
  try {
    return await subscriptIndex(session, subscript, policies)
  } catch (err) {
    if (err instanceof ArithError) throw err.signal('', true)
    throw err
  }
}

/**
 * Evaluate an arithmetic command, a `let` operand or a test's integer
 * operand against the session, its writes landed through the gate in order;
 * `expand` for a `let` operand, whose subscripts expand first. Mirrors
 * Python's session_arith.
 */
export async function sessionArith(
  session: SessionState,
  text: string,
  policies: Policies | null = null,
  callStack: CallStack | null = null,
  expand = false,
): Promise<bigint> {
  const shell = session.vars.shell
  frame(session, callStack)
  const task = shell.arith(text, expand, { listens: listens(policies) })
  return (await drive(task, new SessionGate(session, policies), [])) as bigint
}

/**
 * The scalar an array conversion keeps as element 0; for a live `RANDOM`
 * looking the name up draws (`RANDOM[1]=5` leaves `[0]` one draw). Mirrors
 * Python's conversion_scalar.
 */
export function conversionScalar(session: SessionState, name: string): string | null {
  const answer = session.vars.shell.conversionScalar(name)
  if (Array.isArray(answer))
    throw faultError(['arith', (answer as readonly Item[])[1] ?? null], new Map())
  return answer as string | null
}

/**
 * Evaluate `text` as an `-i` write coerces it, land what it assigns, and give
 * back the value: a `declare -ni r=M` value, which bash evaluates before
 * refusing the reference (`M='X=5'` sets X). `added` is a `r+=M`'s added
 * text, evaluated after `text` in the same evaluation and added to it.
 * Mirrors Python's evaluate_integer.
 */
export async function evaluateInteger(
  session: SessionState,
  policies: Policies | null,
  text: string,
  added: string | null = null,
): Promise<string> {
  const shell = session.vars.shell
  const value = await runWrite(session, policies, (heard) =>
    shell.integer(text, added, { listens: heard }),
  )
  return String(value)
}

/**
 * What a `+=` hands `setVar`: the held text then the added one, or on an
 * integer the held text with the added one as `added`. An array extends
 * element 0 and a map key `"0"`. Mirrors Python's appended.
 */
export function appended(
  held: ShellValue | null,
  added: string,
  integer: boolean,
): [string, string | null] {
  let text: string | null | undefined
  if (held instanceof ShellArray) text = arrayGet(held, 0)
  else if (held !== null && typeof held === 'object') text = held['0']
  else text = held
  const base = text ?? ''
  return integer ? [base, added] : [joinBytes(base + added), null]
}

/**
 * Refuse a write that names a hidden variable, the vars twin of EACCES on a
 * create into hidden path space. Mirrors Python's ensure_var_visible.
 */
export function ensureVarVisible(session: SessionState, name: string): void {
  if (session.vars.shell.hidden(name)) {
    throw new PolicyDenied(`${name}: permission denied`, name)
  }
}

// The names the shell maintains itself (`seedVar`'s second caller): a `cd`
// writes the first two and `[[ =~ ]]` the third, ungated, because they are
// the shell's to keep current rather than the session's to admit. Mirrors
// Python `SHELL_BOOKKEEPING`.
export const SHELL_BOOKKEEPING: ReadonlySet<string> = new Set(['PWD', 'OLDPWD', 'BASH_REMATCH'])

/**
 * Vet a variable table a snapshot restores through the session gate: every
 * variable fires `preSession` as a `set` of its rendered value before any of
 * them lands, and a refusal aborts the load. The shell's own bookkeeping is
 * exempt here as it is live. Mirrors Python `gate_restored_vars`.
 */
export async function gateRestoredVars(
  policies: Policies | null,
  sessionId: string,
  table: ShellVars,
): Promise<void> {
  const shell = table.shell
  for (const name of shell.names()) {
    if (SHELL_BOOKKEEPING.has(name)) continue
    await preSessionGate(policies, {
      verb: 'set',
      key: name,
      value: shell.rendered(name),
      sessionId,
    })
  }
}

const ELEMENT_STATUS = ['ok', 'denied', 'readonly', 'subscript'] as const

/**
 * Whether a `name` / `name[sub]` reference names a set value, what `test -v`
 * asks: a bare name over an array checks element 0, `name[@]` any element,
 * an indexed subscript evaluates and what it assigns lands (`[[ -v a[x=2] ]]`
 * leaves x at 2). Mirrors Python's element_is_set.
 */
export async function elementIsSet(
  session: SessionState,
  ref: string,
  policies: Policies | null = null,
  expanded = false,
): Promise<boolean> {
  const shell = session.vars.shell
  return (
    (await runWrite(session, policies, (heard) =>
      shell.isSet(ref, { expanded, listens: heard }),
    )) !== 0n
  )
}

/**
 * Assign one element (or a bare name resolved as element 0) a builtin names,
 * as one gated write of the whole value it makes, so a `pre_session` rule
 * sees `m[k]=v` as a write to `m`. The subscript arrives already expanded: an
 * associative name takes it as the key verbatim, an indexed one evaluates it
 * as arithmetic. Without a `diagnostics` sink, a seed's arithmetic error
 * propagates. Mirrors Python's assign_element.
 */
export async function assignElement(
  session: SessionState,
  policies: Policies | null,
  name: string,
  subscript: string | null,
  value: string,
  append = false,
  diagnostics: (string | Uint8Array)[] | null = null,
): Promise<(typeof ELEMENT_STATUS)[number]> {
  const shell = session.vars.shell
  const warns = diagnostics !== null
  const write = (): Promise<bigint> =>
    runWrite(
      session,
      policies,
      (heard) => shell.element(name, subscript, value, { append, listens: heard, warns }),
      diagnostics,
    )
  let code = 0n
  if (policies === null || !asyncContextIsolatesTasks) code = await write()
  else {
    await policies.decisions.withinCall(session.sessionId, async () => {
      code = await write()
    })
  }
  return ELEMENT_STATUS[Number(code)] ?? 'ok'
}

/**
 * Write one variable through the session plane's gate. A string stores a
 * scalar, a ShellArray an indexed array, a record an associative one.
 * Readonly and hidden names refuse; the value is shaped by the name's
 * attributes (`-i -l -u`) before the `pre_session` policy judges it, lands,
 * and is put back when `post_session` refuses. `followRef` resolves a
 * `declare -n` reference to its target first; `assigned` names the elements
 * an array write assigns; `added` is an integer `+=`'s text; without a
 * `diagnostics` sink, a seed's arithmetic error propagates. Mirrors Python's
 * set_var.
 */
async function setVar(
  session: SessionState,
  policies: Policies | null,
  name: string,
  value: ShellValue,
  followRef = true,
  diagnostics: (string | Uint8Array)[] | null = null,
  assigned: ReadonlySet<bigint | string> | null = null,
  added: string | null = null,
): Promise<void> {
  const [raw, assoc] = rawValue(value)
  const shell = session.vars.shell
  await runWrite(
    session,
    policies,
    (heard) =>
      shell.set(name, raw, {
        assoc,
        followRef,
        assigned: assigned === null ? null : [...assigned],
        added,
        listens: heard,
        warns: diagnostics !== null,
      }),
    diagnostics,
  )
}

/**
 * Drop one variable through the session plane's gate; a missing or hidden
 * name is quiet. A name an enclosing scope shadows is that scope's to lose:
 * the unset reveals the value it saved. `followRef` resolves a `declare -n`
 * reference to its target; `unset -n r` drops the reference and passes
 * false. Mirrors Python's unset_var.
 */
async function unsetVar(
  session: SessionState,
  policies: Policies | null,
  name: string,
  followRef = true,
): Promise<void> {
  const shell = session.vars.shell
  await runWrite(session, policies, (heard) => shell.unset(name, { followRef, listens: heard }))
}

/**
 * Turn one attribute on or off through the session plane's gate, writing no
 * value: `export NAME` on a fresh name leaves it unset. A null attribute
 * declares the name and changes no attribute. `followRef` marks what a
 * `declare -n` reference points at; `declare -rn r` marks the reference
 * itself. Mirrors Python's mark_var.
 */
async function markVar(
  session: SessionState,
  policies: Policies | null,
  name: string,
  attr: VarAttr | null,
  on: boolean,
  followRef = true,
): Promise<void> {
  const shell = session.vars.shell
  await runWrite(session, policies, (heard) =>
    shell.mark(name, attr, on, { followRef, listens: heard }),
  )
}

/**
 * Put each name's global record in place for a `declare -g`, and return the
 * call that puts the running locals back (`local G=5; declare -gr G=1` leaves
 * `$G` at 5 in the function, 1 and frozen outside). Mirrors Python's
 * reach_global.
 */
export function reachGlobal(session: SessionState, names: readonly string[]): () => void {
  const shell = session.vars.shell
  shell.reachGlobal(names)
  return () => {
    shell.unreach()
  }
}

/**
 * Let a temporary-environment variable outlive its call: bash keeps `x` from
 * `x=1 f` once something inside runs `export x` or `readonly x`. Mirrors
 * Python's outlive_call.
 */
export function outliveCall(session: SessionState, name: string): void {
  session.vars.shell.outliveCall(name)
}

/** Whether the running function's call assigned `name` in front. Mirrors Python's in_call_env. */
export function inCallEnv(session: SessionState, name: string): boolean {
  return session.vars.shell.inCallEnv(name)
}

/**
 * The names a running builtin's or program's prefix assignments set for it,
 * which no listing shows (`QX=1 export -p` lists no QX); a function's are
 * its own scope's, and list.
 */
export function prefixTemporaries(session: SessionState): string[] {
  return session.prefixSaves.flatMap((saved) => [...saved.keys()])
}

/**
 * The positional parameters in scope: inside a function its own, even none;
 * outside every function the shell's.
 */
export function positionalParams(session: SessionState, callStack: CallStack | null): string[] {
  if (callStack !== null && callStack.depth > 1) return callStack.getAllPositional()
  return session.positionalArgs
}

/**
 * Replace the positional parameters in scope; `set --` and `shift` inside a
 * function change the function's own.
 */
export function setPositionalParams(
  session: SessionState,
  callStack: CallStack | null,
  values: string[],
): void {
  if (callStack !== null && callStack.depth > 1) {
    checkEnv(
      session,
      argsBytes(callStack.getAllPositional()),
      argsBytes(values),
      framesBytes(callStack),
    )
    callStack.setPositional(values)
  } else {
    checkEnv(session, argsBytes(session.positionalArgs), argsBytes(values))
    session.positionalArgs = values
  }
}

/**
 * Record the caller's record before a `local` shadows it, once per function;
 * a local `RANDOM` is an ordinary variable for the function's extent, and so
 * is a local `LINENO` or `BASHPID`, its `unset` the function's own; with `-I`
 * (`inherit`) it keeps the meaning the caller's has. Mirrors Python's
 * shadow_local.
 */
export function shadowLocal(session: SessionState, name: string, inherit = false): void {
  session.vars.shell.shadow(name, inherit)
}

/**
 * Write a variable without consulting the gate.
 *
 * Two kinds of caller: seeding a session before it is handed out, and the
 * shell's own bookkeeping (`$PWD`/`$OLDPWD` after a `cd`, `BASH_REMATCH`
 * after `[[ =~ ]]`). A variable the line named goes through
 * `SessionView.set` instead. A prefix assignment (`FOO=bar cmd`) lands here
 * too, after asking `ensureVarVisible` and `preSession` with the value.
 *
 * Nor does it count against max_env: a caller that grows a value a line
 * chose, as a prefix assignment does, calls `checkEnv` first.
 */
export function seedVar(session: SessionState, name: string, value: ShellValue): void {
  const [raw, assoc] = rawValue(value)
  session.vars.shell.seed(name, raw, assoc)
}

/**
 * Set `$_` as bash does once a simple command has run in the shell: its last
 * word after expansion, which is its name when it took no argument, and empty
 * for a line that only assigned or redirected. Mirrors Python's
 * bind_last_word.
 */
export function bindLastWord(session: SessionState, words: readonly string[]): void {
  seedVar(session, '_', words[words.length - 1] ?? '')
}

/**
 * Turn one attribute on or off without the gate, creating the name unset if
 * needed, as `readonly NAME` on a fresh name does; a null attribute only
 * declares the name.
 */
export function setAttr(
  session: SessionState,
  name: string,
  attr: VarAttr | null,
  on = true,
): void {
  if (!session.vars.has(name)) checkEnv(session, 0, entryBytes(name, undefined))
  session.vars.shell.setAttr(name, attr, on)
}

/**
 * A session write as one call, so a ONCE answer to its preSession question
 * stands until its postSession one is answered too. Without task isolation
 * a call cannot be told from another task's, so there the write is its own.
 * Mirrors Python's `_one_call`.
 */
function oneCall(
  session: SessionState,
  policies: Policies | null,
  write: () => Promise<void>,
): Promise<void> {
  return policies === null || !asyncContextIsolatesTasks
    ? write()
    : policies.decisions.withinCall(session.sessionId, write)
}

/**
 * The session plane's view: ten facts bound to one session.
 *
 * The one constructor every tier uses, so the gate cannot be skipped by
 * picking a different entry point. The view carries no handle back to the
 * raw session. `diagnostics` is the evaluator's warning sink.
 */
export function sessionView(
  session: SessionState,
  policies: Policies | null = null,
  diagnostics?: (string | Uint8Array)[],
): SessionView {
  return {
    get: (name) => envGet(session, name),
    snapshot: () => envSnapshot(session),
    set: (name, value, followRef = true, assigned = null, added = null) =>
      oneCall(session, policies, () =>
        setVar(session, policies, name, value, followRef, diagnostics ?? null, assigned, added),
      ),
    unset: (name, followRef = true) =>
      oneCall(session, policies, () => unsetVar(session, policies, name, followRef)),
    mark: (name, attr, on, followRef = true) =>
      oneCall(session, policies, () => markVar(session, policies, name, attr, on, followRef)),
    isReadonly: (name, followRef = true) => envIsReadonly(session, name, followRef),
    profile: () => session.profile,
    cwd: () => session.cwd,
    sessionId: session.sessionId,
    access: () => sessionAccess(session),
  }
}
