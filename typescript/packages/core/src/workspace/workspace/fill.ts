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

import { invokedEnvNames, suppliedEnvNames } from '../../commands/cli/walk.ts'
import type { Runtime } from '../../runtime/base.ts'
import type { RouteDecision } from '../../runtime/routing/index.ts'
import { VFSRuntime } from '../../runtime/table.ts'
import { SecretsError } from '../../secrets/errors.ts'
import { fieldSummary } from '../../secrets/summary.ts'
import { fetchSecret } from '../../secrets/registry.ts'
import type { ResolvedSource } from '../../secrets/types.ts'
import { SHOPT_DEFAULTS } from '../../shell/constants.ts'
import {
  arithReads,
  assignmentValues,
  commandInvocations,
  commandWords,
  envReads,
  identifierNames,
  implicitReads,
  opaqueReads,
  referencedNames,
  sameNode,
} from '../../shell/parse/index.ts'
import type { ManagedRef, ShellVar } from '../../shell/variable.ts'
import { VarAttr, withValue } from '../../shell/variable.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { varHidden } from '../../utils/hidden.ts'
import { lookup } from '../lookup/lookup.ts'
import { Consumer } from '../lookup/types.ts'
import type { MountRegistry } from '../mount/registry.ts'
import { setSessionEntry, type Session } from '../session/session.ts'
import { deref } from '../session/state.ts'

// Appended to an alias value before parsing it for the read walk: the
// rest of the invoking line lands there at dispatch, so the trailing
// command's arguments are statically unknowable, never absent. "$@" is
// bash's own spelling for those words, and it parses as a special
// variable no read walk collects -- a synthetic *name* here would be a
// real variable a workspace could manage, and every alias would read it.
const ALIAS_REST = ' "$@"'

/**
 * Function bodies the line itself defines, every one per name.
 *
 * A name defined more than once on the line keeps every body: which
 * definition an invocation runs depends on where it sits between them
 * (`f() { :; }; f; f() { ...; }; f` runs both), so all of them may be
 * selected.
 */
function definedBodies(node: TSNodeLike): Map<string, TSNodeLike[]> {
  const out = new Map<string, TSNodeLike[]>()
  const stack: TSNodeLike[] = [node]
  for (;;) {
    const current = stack.pop()
    if (current === undefined) break
    if (current.type === 'function_definition') {
      const nameNode = current.childForFieldName?.('name') ?? null
      const body = current.childForFieldName?.('body') ?? null
      if (nameNode !== null && nameNode.text !== '' && body !== null) {
        const bodies = out.get(nameNode.text)
        if (bodies === undefined) out.set(nameNode.text, [body])
        else bodies.push(body)
      }
    }
    stack.push(...current.namedChildren)
  }
  return out
}

/**
 * The line's tree plus every body its command words can run.
 *
 * A body runs at invocation, not where it is defined, so the read
 * walks skip definition subtrees; this is where an invoked body joins
 * back in. A command word pulls in every body it could select, all of
 * them rather than the likeliest: the session's stored function AND
 * the line's own redefinition (`f; f() { :; }` runs the stored body
 * first, so neither may shadow the other), and a stored alias's
 * expansion, reparsed here because dispatch reparses it after this
 * pass has already run. Alias values join only under `expand_aliases`,
 * the same gate alias expansion applies at dispatch. Each name
 * resolves once, so mutual recursion terminates; over-selection only
 * ever over-fetches, under-selection is the bug.
 */
export function lineNodes(
  node: TSNodeLike,
  session: Session,
  reparse: (line: string) => TSNodeLike,
): TSNodeLike[] {
  const defined = definedBodies(node)
  const expand = session.shopts.expand_aliases ?? SHOPT_DEFAULTS.get('expand_aliases') ?? false
  const nodes: TSNodeLike[] = [node]
  const seen = new Set<string>()
  const frontier: TSNodeLike[] = [node]
  for (;;) {
    const current = frontier.pop()
    if (current === undefined) break
    for (const word of commandWords(current)) {
      if (seen.has(word)) continue
      seen.add(word)
      const stored = Object.hasOwn(session.functions, word) ? session.functions[word] : undefined
      const bodies = Array.isArray(stored) ? [...(stored as TSNodeLike[])] : []
      bodies.push(...(defined.get(word) ?? []))
      const aliased = Object.hasOwn(session.aliases, word) ? session.aliases[word] : undefined
      // An alias is a textual prefix: dispatch appends the
      // invocation's rest to the value, so the value's trailing
      // command is parsed with a dynamic rest-word. That keeps its
      // argument list honest -- a CLI named in an alias reads as
      // "verbs unknowable" (whole spec tree) rather than "no verb
      // selected".
      if (expand && aliased !== undefined) bodies.push(reparse(aliased + ALIAS_REST))
      nodes.push(...bodies)
      frontier.push(...bodies)
    }
  }
  return nodes
}

/**
 * Whether any of the line's commands runs on a guest runtime.
 *
 * A guest receives the exported environment as one snapshot, so every
 * managed name may be read whatever the line spells --
 * `python3 -c 'os.environ[...]'` never writes a `$NAME` the walk could
 * see. The vfs runtime is the executor itself, whose commands read
 * vars one at a time, so it does not count. Keyed on the walked set's
 * own command words (stored function bodies included) because the
 * static table binds every captured command in the workspace, not this
 * line's.
 */
export function guestBound(
  nodes: TSNodeLike[],
  decision: RouteDecision | null,
  staticBindings: Record<string, Runtime | null>,
): boolean {
  const bindings = decision !== null ? decision.bindings : staticBindings
  const words = new Set<string>(['*'])
  for (const node of nodes) {
    for (const word of commandWords(node)) words.add(word)
  }
  for (const word of words) {
    const runtime = Object.hasOwn(bindings, word) ? bindings[word] : undefined
    if (runtime != null && !(runtime instanceof VFSRuntime)) return true
  }
  return false
}

/**
 * Env names the line's installed CLIs are about to read.
 *
 * An installed CLI reads a managed name through `Option.env` with no
 * `$NAME` in the line's text, so the fill set has to be told. A head
 * word counts only when dispatch would actually run the CLI (`lookup`):
 * a function, builtin or namespace command shadowing the name wins
 * routing, and a head the session's profile hides never runs at all.
 * The invocation's literal words then prune the tree
 * (`invokedEnvNames`), so `ntn api get` contributes the api and get
 * chain rather than every sibling verb's options, minus the options
 * the invocation itself supplies (`suppliedEnvNames`): typed outranks
 * environment, so the parser never reads those.
 */
export function cliEnvNames(
  nodes: TSNodeLike[],
  session: Session,
  registry: MountRegistry,
): ReadonlySet<string> {
  const out = new Set<string>()
  for (const node of nodes) {
    for (const [head, args] of commandInvocations(node)) {
      if (head === null) continue
      const install = registry.clis.get(head)
      if (install === null) continue
      if (lookup(head, session, registry) !== Consumer.CLI) continue
      if (args.includes(null)) {
        for (const name of invokedEnvNames(install.spec, null)) out.add(name)
        continue
      }
      const literal = args.filter((arg): arg is string => arg !== null)
      const words = new Set(literal.filter((arg) => !arg.startsWith('-')))
      const supplied = suppliedEnvNames(install.spec, literal)
      for (const name of invokedEnvNames(install.spec, words)) {
        if (!supplied.has(name)) out.add(name)
      }
    }
  }
  return out
}

/**
 * The session's unfetched managed names, hidden ones excluded.
 *
 * A hidden name never fetches at all: the snapshot filters it and
 * expansion reads it as unset, so no fetch could ever be visible.
 */
function pendingOf(session: Session): Map<string, ManagedRef> {
  const out = new Map<string, ManagedRef>()
  for (const [name, v] of Object.entries(session.vars)) {
    if (v.managed === undefined || v.value !== null) continue
    if (varHidden(session.hiddenVars, name)) continue
    out.set(name, v.managed)
  }
  return out
}

// A prefix assignment's value may carry expansions (the walk reads
// them), but a substitution runs commands of its own, which is exactly
// the "nothing runs before the masks land" premise the prefix trades on.
const MASK_VALUE_BLOCKERS: ReadonlySet<string> = new Set([
  'command_substitution',
  'process_substitution',
])

/**
 * Whether an assignment's subtree defeats the masking premise.
 *
 * A command or process substitution runs code before the prefix is
 * over, and an opaque read (`${!name}`) reads a name no walk can
 * spell, so neither may sit inside a masking statement.
 */
function replacementBlocked(part: TSNodeLike): boolean {
  if (opaqueReads(part)) return true
  const stack = [...part.namedChildren]
  for (;;) {
    const current = stack.pop()
    if (current === undefined) break
    if (MASK_VALUE_BLOCKERS.has(current.type)) return true
    stack.push(...current.namedChildren)
  }
  return false
}

/**
 * The names a standalone assignment statement definitely replaces.
 *
 * Null when the statement is not a plain replacement: a `+=` reads the
 * standing value into the result, a subscript writes one element, a
 * substitution in the value runs code mid-prefix, and a declaration
 * operand that is not an assignment (a flag word, a bare name) leaves
 * the statement's effect to the builtin's own rules.
 */
function assignmentMasks(stmt: TSNodeLike): ReadonlySet<string> | null {
  const parts = stmt.type === 'variable_assignment' ? [stmt] : [...stmt.namedChildren]
  const names = new Set<string>()
  for (const part of parts) {
    if (part.type !== 'variable_assignment') return null
    if (part.children.some((child) => child.type === '+=')) return null
    const nameNode = part.childForFieldName?.('name') ?? null
    if (nameNode?.type !== 'variable_name') return null
    if (nameNode.text === '') return null
    if (replacementBlocked(part)) return null
    names.add(nameNode.text)
  }
  return names
}

// Statement separators, comments and a body container's own delimiters
// (`{`/`}`, `(`/`)`): the prefix walk steps over these the way the
// python twin steps over anonymous nodes.
const MASK_WALK_SKIPS: ReadonlySet<string> = new Set([';', '\n', 'comment', '{', '}', '(', ')'])

// The declaring builtins whose plain assignments land like `X=v`:
// `declare`/`typeset`/`export`/`readonly` assign in any context.
// `local` is gated on the body flag because outside a function it
// refuses without writing, so the standing value stays readable.
const DECLARATION_MASK_HEADS: ReadonlySet<string> = new Set([
  'declare',
  'typeset',
  'export',
  'readonly',
])

/**
 * Whether a declaration statement's assignments land as writes.
 *
 * `inBody` says the statement sits in a function body, where `local`
 * writes; at top level it refuses without writing.
 */
function declarationReplaces(stmt: TSNodeLike, inBody: boolean): boolean {
  const head = stmt.children[0]?.text
  if (head === 'local') return inBody
  return head !== undefined && DECLARATION_MASK_HEADS.has(head)
}

/**
 * The names a plain `unset` statement definitely removes.
 *
 * Null when anything is unprovable: a flag other than `-v`/`--` (`-f`
 * touches functions, `-n` the nameref itself), an operand no static
 * read can spell, or a head that is not `unset` at all (the grammar
 * parses `unsetenv` into the same node type, and no builtin answers
 * it).
 */
function unsetMasks(stmt: TSNodeLike): ReadonlySet<string> | null {
  const head = stmt.children[0]
  if (head?.text !== 'unset') return null
  const names = new Set<string>()
  for (const child of stmt.namedChildren) {
    if (child.type === 'word') {
      if (child.text !== '-v' && child.text !== '--') return null
    } else if (child.type === 'variable_name') {
      if (child.text === '') return null
      names.add(child.text)
    } else {
      return null
    }
  }
  return names
}

/**
 * Names one unit definitely replaces before anything can read them.
 *
 * The unit's leading run of plain statements that only assign,
 * declare-with-value or unset masks its names for everything after:
 * the write lands before any command runs, invoked bodies and CLIs
 * only run from later statements, and even an opaque read there
 * observes the replacement. The prefix ends at the first statement
 * that is anything else, that runs in the background (`&` detaches it
 * to a subshell, so nothing persists), or that touches a readonly name
 * (the write fails and the standing value stays observable). A name
 * read while still unmasked (`TOKEN=$TOKEN`) stays fetched: within a
 * statement the read precedes the write.
 *
 * The unit is the typed line for the top-level prefix, and a defined
 * body for that body's own reads (`ownMasks`); `inBody` says which,
 * because `local` writes only inside a function and refuses at top
 * level with the standing value still readable.
 *
 * `writesGated` empties the set: a `preSession` policy may refuse a
 * write mid-line while later statements still run, and a refused mask
 * would leave the standing value readable, so under such a policy
 * nothing masks and the fetch keeps today's shape.
 */
export function maskedNames(
  node: TSNodeLike,
  session: Session,
  writesGated: boolean,
  inBody = false,
  before: TSNodeLike | null = null,
): ReadonlySet<string> {
  if (writesGated) return new Set()
  const masked = new Set<string>()
  const needed = new Set<string>()
  const children = node.children
  for (let idx = 0; idx < children.length; idx += 1) {
    const stmt = children[idx]
    if (stmt === undefined) break
    // A stored statement is discounted by exactly the prefix that runs
    // before it, never by its own writes.
    if (before !== null && sameNode(stmt, before)) break
    if (MASK_WALK_SKIPS.has(stmt.type)) continue
    let masks: ReadonlySet<string> | null
    if (stmt.type === 'variable_assignment' || stmt.type === 'variable_assignments') {
      masks = assignmentMasks(stmt)
    } else if (stmt.type === 'declaration_command') {
      masks = declarationReplaces(stmt, inBody) ? assignmentMasks(stmt) : null
    } else if (stmt.type === 'unset_command') {
      masks = unsetMasks(stmt)
    } else {
      break
    }
    if (masks === null) break
    const following = children[idx + 1]
    if (following?.type === '&') break
    const readonlyHit = [...masks].some((name) => {
      const record = Object.hasOwn(session.vars, name) ? session.vars[name] : undefined
      return record?.attrs.has(VarAttr.Readonly) ?? false
    })
    if (readonlyHit) break
    for (const name of referencedNames(stmt)) {
      for (const target of [name, deref(session, name)]) {
        if (!masked.has(target)) needed.add(target)
      }
    }
    for (const name of masks) masked.add(name)
  }
  return new Set([...masked].filter((name) => !needed.has(name)))
}

// A defined body joins the walk as one of these containers; an alias
// parses to a program, the shape the typed line has.
const BODY_CONTAINERS: ReadonlySet<string> = new Set(['compound_statement', 'subshell'])

/**
 * A walked unit's own leading masks, discounting its own reads.
 *
 * A defined body's prefix masks the body's later reads exactly as the
 * line's prefix masks the line's: the body runs its statements in
 * order, so `local TOKEN=x` shadows before anything after it can read,
 * whatever scope the invocation runs in. An alias expansion is a
 * program run mid-line, where `local` refuses without writing, so only
 * the context-free forms mask there. A stored body joins as its
 * statements, one node each (the granularity the per-statement policy
 * pass judges at), but the stored list keeps the original container
 * alive, so each statement recovers its body scope through its parent:
 * the prefix that runs before it (`before`) discounts its reads
 * exactly as a same-line body's prefix would.
 */
function ownMasks(node: TSNodeLike, session: Session, writesGated: boolean): ReadonlySet<string> {
  let own: ReadonlySet<string> = new Set()
  if (BODY_CONTAINERS.has(node.type)) own = maskedNames(node, session, writesGated, true)
  else if (node.type === 'program') own = maskedNames(node, session, writesGated)
  const parent = node.parent ?? null
  if (parent !== null && BODY_CONTAINERS.has(parent.type)) {
    const scoped = maskedNames(parent, session, writesGated, true, node)
    if (scoped.size > 0) own = new Set([...own, ...scoped])
  }
  return own
}

/**
 * What the line's own assignments may leave in each target.
 *
 * Per target name, the literal values assigned anywhere in the walked
 * set and, for dynamic values, the names those values read. Both feed
 * the arithmetic chase: an arithmetic read of the target recurses into
 * whichever value lands, and ordering is not modelled -- every
 * candidate counts, which only over-fetches.
 */
function assignedReach(nodes: TSNodeLike[]): Map<string, [Set<string>, Set<string>]> {
  const out = new Map<string, [Set<string>, Set<string>]>()
  for (const node of nodes) {
    for (const [name, literal, reads] of assignmentValues(node)) {
      let entry = out.get(name)
      if (entry === undefined) {
        entry = [new Set<string>(), new Set<string>()]
        out.set(name, entry)
      }
      if (literal !== null) entry[0].add(literal)
      for (const read of reads) entry[1].add(read)
    }
  }
  return out
}

/**
 * Every name an arithmetic read may reach through stored values.
 *
 * Arithmetic resolution recurses: a name's value is evaluated as an
 * expression of its own, so `name=TOKEN; echo $((name))` reads TOKEN.
 * The chase follows each read name through its session value, its
 * nameref target, and the line's own assignments (`assignedReach`),
 * tokenizing values with `identifierNames`. A pending managed name has
 * no value yet, so the chase adds it and stops there: what its fetched
 * value may spell is unknowable before the fetch. The executor closes
 * that hole by planning again once the values land, so a fetched value
 * naming another managed variable is reached on the next pass.
 */
function arithTargets(
  session: Session,
  names: ReadonlySet<string>,
  assigned: Map<string, [Set<string>, Set<string>]>,
): Set<string> {
  const out = new Set<string>()
  const frontier = [...names]
  for (;;) {
    const name = frontier.pop()
    if (name === undefined) break
    if (out.has(name)) continue
    out.add(name)
    const target = deref(session, name)
    if (!out.has(target)) frontier.push(target)
    const value = session.vars[name]?.value ?? null
    // Any element of an array or map value may be the one the
    // recursion lands on (`arr=(TOKEN); $((arr))` reads arr[0]), so
    // every string in the structure is chased.
    if (typeof value === 'string') {
      frontier.push(...identifierNames(value))
    } else if (Array.isArray(value)) {
      for (const item of value) if (item !== null) frontier.push(...identifierNames(item))
    } else if (value !== null) {
      for (const item of Object.values(value)) frontier.push(...identifierNames(item))
    }
    const entry = assigned.get(name)
    if (entry !== undefined) {
      for (const literal of entry[0]) frontier.push(...identifierNames(literal))
      frontier.push(...entry[1])
    }
  }
  return out
}

/**
 * The pending names the line's walked set is about to read.
 *
 * An opaque read (`opaqueReads`) or a command head no static read can
 * spell (`$tool api ...` -- the program that runs is not decidable
 * before expansion, so neither is its read set) selects everything
 * pending; otherwise the set is the walk's references (nameref targets
 * resolved through the session), the printing forms' explicit targets,
 * the implicit reads (`implicitReads`: a tilde reads `$HOME`, a bare
 * `cd` does too), the names an arithmetic read reaches through stored
 * values (`arithTargets`: `name=TOKEN; echo $((name))` reads TOKEN),
 * the routed CLIs' env names, the eager-marked entries, and, when some
 * command renders the whole environment,
 * everything pending except what every such render provably skips
 * (`env -u TOKEN`, an assignment prefix; the `excluded` third of
 * `envReads`). Each walked unit's reads are discounted by that unit's
 * own leading masks first (`ownMasks`: a body's `local` shadows its
 * own later reads), and the line's masked names come off last, the
 * opaque selections included: a masked name is replaced before
 * anything at all runs, so whatever the line turns out to read
 * observes the replacement, eagerness notwithstanding.
 */
function wanted(
  session: Session,
  nodes: TSNodeLike[],
  pending: Map<string, ManagedRef>,
  lineCliEnvNames: ReadonlySet<string>,
  masked: ReadonlySet<string>,
  writesGated: boolean,
): Set<string> {
  const unmaskedPending = (): Set<string> =>
    new Set([...pending.keys()].filter((name) => !masked.has(name)))
  const referenced = new Set<string>()
  const printed = new Set<string>()
  const implicit = new Set<string>()
  let renderedAny = false
  let renderedExcluded: ReadonlySet<string> | null = null
  const assigned = assignedReach(nodes)
  for (const [position, node] of nodes.entries()) {
    const reads = envReads(node)
    if (opaqueReads(node)) return unmaskedPending()
    if (commandInvocations(node).some(([head]) => head === null)) {
      return unmaskedPending()
    }
    const own = position === 0 ? new Set<string>() : ownMasks(node, session, writesGated)
    if (reads.whole) {
      renderedAny = true
      const prior: ReadonlySet<string> | null = renderedExcluded
      // The parameter annotation breaks tsc's circular inference:
      // `renderedExcluded` is assigned from an arrow whose context is
      // itself.
      renderedExcluded =
        prior === null
          ? reads.excluded
          : new Set([...prior].filter((name: string) => reads.excluded.has(name)))
    }
    const arith = arithReads(node)
    if (arith.size > 0) {
      for (const name of arithTargets(session, arith, assigned)) {
        if (!own.has(name)) referenced.add(name)
      }
    }
    for (const name of reads.names) if (!own.has(name)) printed.add(name)
    for (const name of implicitReads(node)) if (!own.has(name)) implicit.add(name)
    for (const name of referencedNames(node)) if (!own.has(name)) referenced.add(name)
  }
  const out = new Set<string>([...printed, ...implicit, ...lineCliEnvNames])
  for (const [name, ref] of pending) {
    if (ref.eager) out.add(name)
  }
  for (const name of referenced) {
    out.add(name)
    out.add(deref(session, name))
  }
  if (renderedAny) {
    const skipped = renderedExcluded ?? new Set<string>()
    for (const name of pending.keys()) {
      if (!skipped.has(name)) out.add(name)
    }
  }
  return new Set([...out].filter((name) => pending.has(name) && !masked.has(name)))
}

/**
 * The managed names one line is about to read, without fetching.
 *
 * Pure planning, split from `fillEnv` so the executor can consult the
 * admission text-pass between deciding and fetching: a line already
 * denied on its literal words never reaches a source. Masks come off
 * each unit's own leading prefix: the line's, which `lineNodes` puts
 * first, masks everything after it (a stored body or alias runs at an
 * invocation point, after the masking prefix), and a defined body's
 * masks only that body's reads (`ownMasks`). `writesGated` says a
 * policy hooks `preSession`, so no assignment or unset is trusted to
 * land (`maskedNames`).
 */
export function fillNames(
  session: Session,
  nodes: TSNodeLike[],
  whole: boolean,
  lineCliEnvNames: ReadonlySet<string>,
  writesGated = false,
): ReadonlySet<string> {
  const pending = pendingOf(session)
  if (pending.size === 0) return new Set()
  if (whole) return new Set(pending.keys())
  const first = nodes[0]
  const masked = first === undefined ? new Set<string>() : maskedNames(first, session, writesGated)
  return wanted(session, nodes, pending, lineCliEnvNames, masked, writesGated)
}

/**
 * Fetch the named managed values into the session.
 *
 * The session is the truth, not the workspace's declaration: it may
 * carry entries the workspace never declared (per-session env, a
 * hydrated record), and a var that already holds a value never
 * refetches -- which also makes the re-entrant fill of a nested eval
 * idempotent. Fetches group by `(source, ref)`, one await per distinct
 * secret, and the fetched value lands directly in `session.vars` with
 * the pointer kept: this is the one host-tier writer, above the
 * agent's gated door.
 *
 * A failed fetch, or a secret without the wanted field, throws
 * SecretsError naming the variable and the source -- never the ref,
 * never any value, and never the source's own words, which go to the
 * host log instead (an SDK error can spell paths or identifiers, and
 * stderr is the agent's to read). The executor folds it into the
 * line's result (exit 1), so a dead source fails exactly the commands
 * that need it.
 *
 * `sources` is the workspace's declared instances. A pointer naming
 * one fetches through its configured source; a pointer naming none
 * falls back to the source of that name, built from ambient defaults.
 */
export async function fillEnv(
  session: Session,
  names: ReadonlySet<string>,
  sources?: Readonly<Record<string, ResolvedSource>>,
): Promise<void> {
  if (names.size === 0) return
  const pending = pendingOf(session)
  interface Member {
    name: string
    key: string
    record: ShellVar
  }
  const groups = new Map<string, { source: string; ref: string; members: Member[] }>()
  for (const name of [...names].sort(compareCodePoints)) {
    const pointer = pending.get(name)
    const record = Object.hasOwn(session.vars, name) ? session.vars[name] : undefined
    if (pointer === undefined || record === undefined) continue
    const groupKey = JSON.stringify([pointer.source, pointer.ref])
    const member = { name, key: pointer.key, record }
    const group = groups.get(groupKey)
    if (group === undefined) {
      groups.set(groupKey, { source: pointer.source, ref: pointer.ref, members: [member] })
    } else {
      group.members.push(member)
    }
  }
  for (const { source, ref, members } of groups.values()) {
    const listed = members.map((m) => m.name).join(', ')
    // A declared instance is named by the deployment, so the summary
    // is told the source behind it: `{prod: {source: env}}` must
    // redact like `env`, not like an unknown name.
    const declared =
      sources !== undefined && Object.hasOwn(sources, source) ? sources[source] : undefined
    const provider = declared?.source ?? source
    let secret
    try {
      secret = await fetchSecret(source, ref, sources)
    } catch (caught) {
      console.warn(`secret fetch for ${listed} from ${source} failed: ${String(caught)}`)
      throw new SecretsError(`${listed}: cannot fetch from ${source}`, { cause: caught })
    }
    for (const { name, key, record } of members) {
      const value = Object.hasOwn(secret.fields, key) ? secret.fields[key] : undefined
      if (value === undefined) {
        throw new SecretsError(
          `${name}: wanted field '${key}', the ${source} secret has ` +
            fieldSummary(secret.fields, provider),
        )
      }
      setSessionEntry(session.vars, name, withValue(record, value))
    }
  }
}
