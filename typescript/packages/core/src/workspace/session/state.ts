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

import { explaining, sessionAccess, sessionVoice } from '../../context/session_context.ts'
import { memoryRoom } from '../../io/memory.ts'
import { PolicyDenied } from '../../policy/index.ts'
import { DryRun } from '../../policy/types.ts'
import { rawValue, varOf } from '../../rs/session.ts'
import type { Item, Outcome, Shell } from '../../rs/shell.ts'
import { arrayGet, ShellArray } from '../../shell/array.ts'
import { joinBytes } from '../../shell/bytes.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import type { ShellValue, VarAttr } from '../../shell/variable.ts'
import type { SessionView } from '../../view/types.ts'
import {
  argsBytes,
  checkEnv,
  entryBytes,
  envLimit,
  framesBytes,
  outsideBytes,
  positionalBytes,
} from './budget.ts'
import type { SessionState } from './session.ts'
import { faultError } from './task.ts'

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
 * Whether a policy is deciding here: a method may read the session it is
 * handed but not change it. Mirrors Python's deciding.
 */
export function deciding(): boolean {
  return explaining() === DryRun.DECIDING
}

/** Refuse a write a policy makes while it decides. Mirrors Python's _refuse_deciding. */
function refuseDeciding(name: string): void {
  if (deciding()) {
    throw new PolicyDenied(`${name}: permission denied`, name)
  }
}

/**
 * Run one write on the session's shell; a hidden name refuses with EACCES. `write` is the shell's write, which answers its result and its
 * warnings. Mirrors Python's run_write.
 */
export function runWrite(
  session: SessionState,
  write: (shell: Shell) => Outcome,
  diagnostics: (string | Uint8Array)[] | null = null,
  callStack: CallStack | null = null,
): bigint {
  frame(session, callStack)
  const [result, said] = write(session.vars.shell)
  if (diagnostics !== null) diagnostics.push(...said)
  if (result[0] !== 'ok') throw faultError(result)
  return result[1] as bigint
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
 *
 * The shell reads its records out once per change: a command takes the
 * snapshot several times (its words, its admission, its context), and every
 * take after the first is a copy of the last.
 */
export function envSnapshot(session: SessionState): Record<string, string> {
  const shell = session.vars.shell
  const stamp = shell.stamp()
  let held = session.envHeld
  if (held?.[0] !== stamp) {
    const env = Object.create(null) as Record<string, string>
    for (const [name, value] of shell.exported()) env[name] = value
    held = [stamp, env]
    session.envHeld = held
  }
  return Object.assign(Object.create(null) as Record<string, string>, held[1])
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
 * (`a[RANDOM=42]`); each lands as it is made. One that fails lands what it
 * assigned before failing, then throws. Mirrors Python's subscript_index.
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function subscriptIndex(session: SessionState, subscript: string): Promise<bigint> {
  const plain = session.vars.shell.plainIndex(subscript)
  if (plain !== null) return plain
  return runWrite(session, (shell) => shell.index(subscript))
}

/**
 * Evaluate an arithmetic command, a `let` operand or a test's integer
 * operand against the session, its writes landed in order; `expand` for a
 * `let` operand, whose subscripts expand first. Mirrors Python's
 * session_arith.
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function sessionArith(
  session: SessionState,
  text: string,
  callStack: CallStack | null = null,
  expand = false,
): Promise<bigint> {
  return runWrite(session, (shell) => shell.arith(text, expand), null, callStack)
}

/**
 * The scalar an array conversion keeps as element 0; for a live `RANDOM`
 * looking the name up draws (`RANDOM[1]=5` leaves `[0]` one draw). Mirrors
 * Python's conversion_scalar.
 */
export function conversionScalar(session: SessionState, name: string): string | null {
  const answer = session.vars.shell.conversionScalar(name)
  if (Array.isArray(answer)) throw faultError(['arith', (answer as readonly Item[])[1] ?? null])
  return answer as string | null
}

/**
 * Evaluate `text` as an `-i` write coerces it, land what it assigns, and give
 * back the value: a `declare -ni r=M` value, which bash evaluates before
 * refusing the reference (`M='X=5'` sets X). `added` is a `r+=M`'s added
 * text, evaluated after `text` in the same evaluation and added to it.
 * Mirrors Python's evaluate_integer.
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function evaluateInteger(
  session: SessionState,
  text: string,
  added: string | null = null,
): Promise<string> {
  return String(runWrite(session, (shell) => shell.integer(text, added)))
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

const ELEMENT_STATUS = ['ok', 'denied', 'readonly', 'subscript', 'notarray'] as const

/**
 * What the value a name stands for is, references followed: `scalar`,
 * `indexed` or `assoc`; null when unset or hidden. It reads no value, so
 * asking it of a large array costs nothing. Mirrors Python's var_kind.
 */
export function varKind(
  session: SessionState,
  name: string,
): 'scalar' | 'indexed' | 'assoc' | null {
  return session.vars.shell.kind(name)
}

/** Run one element write and name the status it came to. Mirrors Python's _element_write. */
function elementWrite(
  session: SessionState,
  write: (shell: Shell) => Outcome,
  diagnostics: (string | Uint8Array)[] | null = null,
): (typeof ELEMENT_STATUS)[number] {
  return ELEMENT_STATUS[Number(runWrite(session, write, diagnostics))] ?? 'ok'
}

/**
 * Append words at the extent of the indexed array a name holds (`a+=(x y)`),
 * each in place, so a loop building an array costs each word once. Mirrors
 * Python's push_words.
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function pushWords(
  session: SessionState,
  name: string,
  words: readonly string[],
): Promise<void> {
  elementWrite(session, (shell) => shell.push(name, words))
}

/**
 * Clear one element (`unset 'a[i]'`), keeping the indexes after it: an
 * associative subscript is the key verbatim, an indexed one arithmetic whose
 * writes land first, and a scalar's element 0 the whole scalar. `every` for a
 * subscript typed as `@` or `*`, which empties an indexed array. A hidden or
 * unset name clears nothing. Mirrors Python's unset_element.
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function unsetElement(
  session: SessionState,
  name: string,
  subscript: string,
  every = false,
): Promise<(typeof ELEMENT_STATUS)[number]> {
  return elementWrite(session, (shell) => shell.unsetElement(name, subscript, every))
}

/**
 * Whether a `name` / `name[sub]` reference names a set value, what `test -v`
 * asks: a bare name over an array checks element 0, `name[@]` any element,
 * an indexed subscript evaluates and what it assigns lands (`[[ -v a[x=2] ]]`
 * leaves x at 2). Mirrors Python's element_is_set.
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function elementIsSet(
  session: SessionState,
  ref: string,
  expanded = false,
): Promise<boolean> {
  return runWrite(session, (shell) => shell.isSet(ref, { expanded })) !== 0n
}

/**
 * Assign one element (or a bare name resolved as element 0 of an array, a
 * scalar otherwise) in place. The subscript arrives already expanded: an
 * associative name takes it as the key verbatim, an indexed one evaluates it
 * as arithmetic, even when the name is readonly. `append` concatenates, or
 * adds under `-i`. Without a `diagnostics` sink, a seed's arithmetic error
 * propagates. Mirrors Python's assign_element.
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function assignElement(
  session: SessionState,
  name: string,
  subscript: string | null,
  value: string,
  append = false,
  diagnostics: (string | Uint8Array)[] | null = null,
): Promise<(typeof ELEMENT_STATUS)[number]> {
  const warns = diagnostics !== null
  return elementWrite(
    session,
    (shell) => shell.element(name, subscript, value, { append, warns }),
    diagnostics,
  )
}

/**
 * Write one variable through the session plane. A string stores a scalar, a
 * ShellArray an indexed array, a record an associative one. Readonly and
 * hidden names refuse; the value is shaped by the name's attributes
 * (`-i -l -u`) before it lands. `followRef` resolves a `declare -n` reference
 * to its target first; `assigned` names the elements an array write assigns;
 * `added` is an integer `+=`'s text; without a `diagnostics` sink, a seed's
 * arithmetic error propagates. Mirrors Python's set_var.
 */
// eslint-disable-next-line @typescript-eslint/require-await
async function setVar(
  session: SessionState,
  name: string,
  value: ShellValue,
  followRef = true,
  diagnostics: (string | Uint8Array)[] | null = null,
  assigned: ReadonlySet<bigint | string> | null = null,
  added: string | null = null,
): Promise<void> {
  refuseDeciding(name)
  const [raw, assoc] = rawValue(value)
  runWrite(
    session,
    (shell) =>
      shell.set(name, raw, {
        assoc,
        followRef,
        assigned: assigned === null ? null : [...assigned],
        added,
        warns: diagnostics !== null,
      }),
    diagnostics,
  )
}

/**
 * Drop one variable through the session plane; a missing or hidden name is
 * quiet. A name an enclosing scope shadows is that scope's to lose: the
 * unset reveals the value it saved. `followRef` resolves a `declare -n`
 * reference to its target; `unset -n r` drops the reference and passes
 * false. Mirrors Python's unset_var.
 */
// eslint-disable-next-line @typescript-eslint/require-await
async function unsetVar(session: SessionState, name: string, followRef = true): Promise<void> {
  refuseDeciding(name)
  runWrite(session, (shell) => shell.unset(name, { followRef }))
}

/**
 * Turn one attribute on or off through the session plane, writing no value:
 * `export NAME` on a fresh name leaves it unset. A null attribute declares
 * the name and changes no attribute. `followRef` marks what a `declare -n`
 * reference points at; `declare -rn r` marks the reference itself. Mirrors
 * Python's mark_var.
 */
// eslint-disable-next-line @typescript-eslint/require-await
async function markVar(
  session: SessionState,
  name: string,
  attr: VarAttr | null,
  on: boolean,
  followRef = true,
): Promise<void> {
  refuseDeciding(name)
  runWrite(session, (shell) => shell.mark(name, attr, on, { followRef }))
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
 * function change the function's own. `values` is held as given and never
 * changed in place, which lets a frame and `positionalBytes` know an array
 * they read already.
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
    checkEnv(session, positionalBytes(session), argsBytes(values))
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
 * Write a variable past the writer's checks.
 *
 * Two kinds of caller: seeding a session before it is handed out, and the
 * shell's own bookkeeping (`$PWD`/`$OLDPWD` after a `cd`, `BASH_REMATCH`
 * after `[[ =~ ]]`). A variable the line named goes through
 * `SessionView.set` instead. A prefix assignment (`FOO=bar cmd`) lands here
 * too, after asking `ensureVarVisible`.
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
 * Turn one attribute on or off past the writer's checks, creating the name unset if
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
 * The session plane's view: ten facts bound to one session.
 *
 * The one constructor every tier uses, so its checks cannot be skipped by
 * picking a different entry point. The view carries no handle back to the
 * raw session. `diagnostics` is the evaluator's warning sink.
 */
export function sessionView(
  session: SessionState,
  diagnostics?: (string | Uint8Array)[],
): SessionView {
  return {
    get: (name) => envGet(session, name),
    snapshot: () => envSnapshot(session),
    set: (name, value, followRef = true, assigned = null, added = null) =>
      setVar(session, name, value, followRef, diagnostics ?? null, assigned, added),
    unset: (name, followRef = true) => unsetVar(session, name, followRef),
    mark: (name, attr, on, followRef = true) => markVar(session, name, attr, on, followRef),
    isReadonly: (name, followRef = true) => envIsReadonly(session, name, followRef),
    profile: () => session.profile,
    cwd: () => session.cwd,
    sessionId: session.sessionId,
    access: () => sessionAccess(session),
  }
}
