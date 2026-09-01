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

import type { ShellArray } from './array.ts'

/** What a shell variable can hold. */
export type ShellValue = string | ShellArray | Record<string, string>

// What one attributed write does to a scalar before it is stored. `-i`
// needs the arithmetic evaluator, which lives above this module, so the
// caller injects it rather than this leaf importing upward.
export type Coercer = (text: string) => string

/**
 * One bash variable attribute, spelled as its `declare` letter.
 *
 * Declaration order is the order `declare -p` prints a cluster in,
 * pinned exhaustively against bash 5.2.37 over all 72 ordered pairs of
 * `a A i l n r t u x`: `a`/`A` first, then `i n r t x`, then `l`/`u`. It
 * is bash's own internal order, not the order the letters were typed in
 * (`declare -xri` prints `-irx`), and not alphabetical.
 *
 * `-a` and `-A` are deliberately absent: whether a variable is an
 * indexed array, an associative array or a scalar is what its value
 * *is*, so storing it a second time as an attribute would let the two
 * contradict each other. `attrLetters` derives them from the value.
 */
export enum VarAttr {
  Integer = 'i',
  Nameref = 'n',
  Readonly = 'r',
  Trace = 't',
  Export = 'x',
  Lower = 'l',
  Upper = 'u',
}

// `declare -p` print order, derived from the enum rather than restated:
// a string enum has no reverse mapping, so `Object.values` is its
// declaration order exactly. Python reads the same order off `VarAttr`
// itself, so an attribute added to one enum cannot print in a different
// place from the other, and cannot be silently dropped by a hand-written
// list nobody remembered to extend.
const ATTR_ORDER: VarAttr[] = Object.values(VarAttr)

/** What a variable's value is, derived from the value itself. */
export enum VarKind {
  Scalar = 'scalar',
  Indexed = 'indexed',
  Assoc = 'assoc',
}

/**
 * Where a managed variable's value comes from.
 *
 * A managed variable is an ordinary `ShellVar` carrying one of these:
 * the pointer is host configuration (a YAML/in-app env entry), never
 * something an agent line can spell, and it is what serializes -- the
 * fetched value never does. All fill-step state rides here so a
 * session can carry managed entries the workspace never declared.
 *
 * `source` is the registered source name (`env`, `dotenv`, `aws-sm`,
 * or a user-registered one); `ref` the source's address for one secret
 * (a secret id, a dotenv path; `''` where the source has no
 * sub-address); `key` which field of the fetched secret this variable
 * reads (the variable's own name at declaration by default); `eager`
 * joins every line's fetch set instead of waiting for a line that
 * references the name.
 */
export interface ManagedRef {
  readonly source: string
  readonly ref: string
  readonly key: string
  readonly eager: boolean
}

/**
 * One shell variable: a value plus the attributes set on it.
 *
 * Readonly on purpose. Every writer already computes its result on a
 * copy and hands the finished value to the session door (`[...arr]`
 * before an element write, and so on), precisely so a refused write
 * leaves nothing half-applied. Making the record immutable turns that
 * convention into something the type enforces: the only way to change a
 * variable is to hand the door a new record, so a policy gate cannot be
 * walked around by reaching into storage.
 *
 * `value` is null in bash's third state: declared with attributes but
 * *unset*, which `readonly NAME` and `export NAME` on a fresh name both
 * produce. It is not the empty string -- GNU prints `declare -r ONLY`
 * for one and `declare -r EMPTY=""` for the other, `${ONLY-d}` expands
 * to `d` while `${EMPTY-d}` does not, and `env` carries the empty one
 * but not the unset one.
 */
export interface ShellVar {
  readonly value: ShellValue | null
  readonly attrs: ReadonlySet<VarAttr>
  /**
   * Set when the value comes from a secrets source. Unfetched is
   * exactly the third state above: value null with attributes, so
   * `envSnapshot`'s existing value check already omits it. `withValue`
   * deliberately carries this field (the fill step writes through it)
   * and `detach` is the agent-write arm.
   */
  readonly managed?: ManagedRef
}

const NO_ATTRS: ReadonlySet<VarAttr> = new Set()

/** Build a variable record. */
export function makeVar(
  value: ShellValue | null = null,
  attrs: ReadonlySet<VarAttr> = NO_ATTRS,
): ShellVar {
  return { value, attrs }
}

/**
 * What kind of variable this is, read off its value.
 *
 * An unset variable reads as a scalar: bash renders `declare -i n` with
 * no `-a`, so nothing but an actual array value earns the letter.
 */
export function varKind(v: ShellVar): VarKind {
  if (Array.isArray(v.value)) return VarKind.Indexed
  if (v.value !== null && typeof v.value === 'object') return VarKind.Assoc
  return VarKind.Scalar
}

/** The variable with a new value and the same attributes. */
export function withValue(v: ShellVar, value: ShellValue | null): ShellVar {
  return { ...v, value }
}

/**
 * The variable with its managed pointer dropped, value kept.
 *
 * An agent write to a managed name shadows session-locally: the record
 * becomes a plain variable for this session only, so the fill step
 * never clobbers it and the declaration (new sessions fetch fresh) and
 * the remote store are untouched by construction.
 */
export function detach(v: ShellVar): ShellVar {
  return { value: v.value, attrs: v.attrs }
}

/**
 * The variable with one attribute turned on or off. `+attr` is the off
 * direction, which is why this takes a flag rather than being two
 * functions.
 */
export function withAttr(v: ShellVar, attr: VarAttr, on = true): ShellVar {
  const attrs = new Set(v.attrs)
  if (on) attrs.add(attr)
  else attrs.delete(attr)
  return { ...v, attrs }
}

/**
 * The stored attribute letters, in `declare -p` print order.
 *
 * The tail of `attrLetters` without the `a`/`A` kind lead, which is
 * derived rather than stored. Split out because two callers want the
 * stored half alone: the serializer, which must not write a letter it
 * would then read back as an attribute the value already implies, and
 * `attrLetters` itself.
 */
/**
 * Apply the value-shaping attributes to one scalar being stored.
 *
 * bash applies these at assignment, not at read: `declare -l s; s=ABC`
 * stores `abc`, and `declare -i n; n=2+2` stores `4`, so `declare -p`
 * and `$s` agree with no per-read work. Order is integer first, then
 * case, which only matters for hex digits and is what GNU does
 * (`declare -il n=0xA` stores `10`). `-l` and `-u` cannot both hold; a
 * declaration that sets one clears the other, so at most one applies.
 */
export function coerceScalar(
  text: string,
  attrs: ReadonlySet<VarAttr>,
  integer: Coercer | null,
): string {
  let out = text
  if (attrs.has(VarAttr.Integer) && integer !== null) out = integer(out)
  if (attrs.has(VarAttr.Lower)) return out.toLowerCase()
  if (attrs.has(VarAttr.Upper)) return out.toUpperCase()
  return out
}

/**
 * `coerceScalar` lifted over every value shape. An array applies the
 * attribute per element, which is GNU's `declare -ai a=(1+1 2*3)` giving
 * `([0]="2" [1]="6")`.
 */
export function coerceValue(
  value: ShellValue,
  attrs: ReadonlySet<VarAttr>,
  integer: Coercer | null,
): ShellValue {
  if (!attrs.has(VarAttr.Integer) && !attrs.has(VarAttr.Lower) && !attrs.has(VarAttr.Upper)) {
    return value
  }
  if (typeof value === 'string') return coerceScalar(value, attrs, integer)
  if (Array.isArray(value)) {
    return value.map((v) => (v === null ? null : coerceScalar(v, attrs, integer)))
  }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value)) out[k] = coerceScalar(v, attrs, integer)
  return out
}

export function storedAttrs(v: ShellVar): string {
  return ATTR_ORDER.filter((a) => v.attrs.has(a)).join('')
}

/**
 * The attribute set a stored letter cluster spells, the inverse of
 * `storedAttrs`, used when a persisted session is read back. A letter
 * that names no attribute is ignored rather than throwing: the store is
 * shared with the other language and with future versions, and refusing
 * to load a session because one letter is unknown loses far more than
 * the letter.
 */
export function attrsFromLetters(letters: string): ReadonlySet<VarAttr> {
  const known = new Set<string>(ATTR_ORDER)
  const out = new Set<VarAttr>()
  for (const c of letters.split('')) {
    if (known.has(c)) out.add(c as VarAttr)
  }
  return out
}

/**
 * The attribute cluster `declare -p` prints for this variable.
 *
 * `-a`/`-A` come from the value's kind and lead, then the stored
 * attributes in print order. bash prints `--` for a plain scalar with
 * nothing set, which is the caller's to render since only it knows it is
 * writing a `declare` line.
 */
export function attrLetters(v: ShellVar): string {
  const kind = varKind(v)
  let lead = ''
  if (kind === VarKind.Indexed) lead = 'a'
  else if (kind === VarKind.Assoc) lead = 'A'
  return lead + storedAttrs(v)
}
