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
import { arrayValues, type ShellArray } from '../../shell/array.ts'
import { varHidden } from '../../utils/hidden.ts'
import { ReadonlyVariableError } from './errors.ts'
import { ownRecord, sessionEntry } from './session.ts'
import type { Session } from './session.ts'

/**
 * The one copy-out of a session's environment.
 *
 * Every tier that hands the env onward as a process view (command
 * opts, `inv.env`, guest `RunArgs.env`, the `env` builtin) copies
 * through here, so the hidden-vars filter lands on all of them by
 * construction rather than on however many hand-rolled copies someone
 * remembers. The copy keeps the null prototype session records carry.
 */
export function envSnapshot(session: Session): Record<string, string> {
  if (session.hiddenVars == null) return ownRecord(session.env)
  const out = ownRecord<string>()
  for (const [name, value] of Object.entries(session.env)) {
    if (!varHidden(session.hiddenVars, name)) out[name] = value
  }
  return out
}

/** The variable's value, null when unset or hidden. Sync on purpose:
 * `$X` expansion is the hot path, so a read stays a record lookup plus
 * the hidden check. */
export function envGet(session: Session, name: string): string | null {
  if (varHidden(session.hiddenVars, name)) return null
  return sessionEntry(session.env, name) ?? null
}

/**
 * Whether `readonly` has marked the name.
 *
 * A hidden name answers false: isReadonly speaks about the session's
 * visible world, and calling a name that reads as unset "readonly"
 * would leak it.
 */
function envIsReadonly(session: Session, name: string): boolean {
  if (varHidden(session.hiddenVars, name)) return false
  return session.readonlyVars.has(name)
}

/**
 * The env mapping a reader tier should resolve names against.
 *
 * The raw record when nothing is hidden (the common case pays
 * nothing), a filtered copy otherwise. TS diverges from python's lazy
 * mapping view deliberately: expansion sites read records with plain
 * property access, so a filtered copy is the shape they already
 * consume, and env sizes make the copy cost noise.
 */
export function visibleEnv(session: Session): Record<string, string> {
  if (session.hiddenVars == null) return session.env
  return envSnapshot(session)
}

/**
 * The arrays mapping a reader tier should resolve names against.
 *
 * The arrays twin of `visibleEnv`: the embedder can seed
 * `session.arrays` before narrowing, so a hidden name can hold an
 * array and array reads need the same filter env reads get.
 */
export function visibleArrays(session: Session): Record<string, ShellArray> {
  if (session.hiddenVars == null) return session.arrays
  const out = ownRecord<ShellArray>()
  for (const [name, value] of Object.entries(session.arrays)) {
    if (!varHidden(session.hiddenVars, name)) out[name] = value
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
export function ensureVarVisible(session: Session, name: string): void {
  if (varHidden(session.hiddenVars, name)) {
    throw new PolicyDenied(`${name}: permission denied`, name)
  }
}

async function setVar(
  session: Session,
  policies: Policies | null,
  name: string,
  value: string | ShellArray,
): Promise<void> {
  ensureVarVisible(session, name)
  if (session.readonlyVars.has(name)) {
    throw new ReadonlyVariableError(name)
  }
  const rendered = typeof value === 'string' ? value : arrayValues(value).join(' ')
  await preSessionGate(policies, {
    plane: 'env',
    verb: 'set',
    key: name,
    value: rendered,
    sessionId: session.sessionId,
  })
  if (typeof value === 'string') {
    session.env[name] = value
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete session.arrays[name]
  } else {
    session.arrays[name] = value
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete session.env[name]
  }
}

/**
 * Drop one variable through the session plane's gate; a missing name
 * is quiet. A hidden name is a quiet no-op that writes nothing:
 * hidden reads as unset, bash's unset of a missing name is quiet, and
 * popping the real value would let a session mutate state it cannot
 * see. Throws ReadonlyVariableError when the name is readonly,
 * PolicyDenied when a preSession policy refuses the write.
 */
async function unsetVar(session: Session, policies: Policies | null, name: string): Promise<void> {
  if (varHidden(session.hiddenVars, name)) return
  if (session.readonlyVars.has(name)) {
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
  delete session.env[name]
}

/**
 * The session plane's view: five facts bound to one session.
 *
 * The one constructor every tier uses — builtins, the command
 * dispatcher, a bare unit test — so the gate cannot be skipped by
 * picking a different door. The view is the whole capability: it
 * carries no handle back to the raw session.
 */
export function sessionView(session: Session, policies: Policies | null = null): SessionView {
  return {
    get: (name) => envGet(session, name),
    snapshot: () => envSnapshot(session),
    set: (name, value) => setVar(session, policies, name, value),
    unset: (name) => unsetVar(session, policies, name),
    isReadonly: (name) => envIsReadonly(session, name),
  }
}
