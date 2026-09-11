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

import { checkRules } from './validate.ts'
import { PolicyError } from '../../policy/errors.ts'
import { intersectPatterns, patternMatches, splitPattern } from '../../policy/match/pattern.ts'
import { WILDCARD } from '../../policy/constants.ts'
import type { CommandRule, AdmissionRules, HideReason, ProfileScript } from '../../policy/types.ts'
import type { HiddenPaths, HiddenVars, MountMode, ShowEntry, ShownPaths } from '../../types.ts'
import { weakerMode } from '../../types.ts'
import {
  anchorDepth,
  classifyPaths,
  classifyShows,
  classifyVars,
  hideDepth,
  isGlob,
  showDepth,
  shownMode,
} from '../../utils/hidden.ts'
import { stripSlash } from '../../utils/slash.ts'
import {
  type CommandsBlock,
  type CompiledProfile,
  type MountCommandsBlock,
  type PathsBlock,
  type ProfileMount,
  type ProfilePolicySpec,
  type SessionProfile,
  type VarsBlock,
} from '../../policy/profile.ts'
import { DEFAULT_PROFILE } from './constants.ts'
import { varsFromEnv, type Session } from './session.ts'
import { setCwd } from './shell_dirs.ts'

/**
 * The profile a session is created from. A name is looked up as written; a
 * profile object is itself; null picks `profiles.default` when the
 * workspace defines one and leaves the session unrestricted otherwise.
 * There is no inheritance chain: a profile is the whole document, so
 * nothing is assembled from somewhere else before it is read. Throws
 * PolicyError on a name the workspace does not define.
 */
export function resolveProfile(
  profiles: Readonly<Record<string, SessionProfile>>,
  profile: string | SessionProfile | null | undefined,
): SessionProfile | null {
  if (profile === null || profile === undefined) return profiles[DEFAULT_PROFILE] ?? null
  if (typeof profile !== 'string') return profile
  const found = profiles[profile]
  if (found === undefined) throw new PolicyError(`unknown profile ${JSON.stringify(profile)}`)
  return found
}

/** Every entry of both blocks, first spelling wins, order kept. */
function unionHide(
  a: PathsBlock | VarsBlock | null | undefined,
  b: PathsBlock | VarsBlock | null | undefined,
): string[] {
  const out: string[] = []
  for (const block of [a, b]) {
    for (const entry of block?.hide ?? []) if (!out.includes(entry)) out.push(entry)
  }
  return out
}

/** One verb's rules in a mount section's commands block, empty when unstated. */
function rulesOf(
  block: MountCommandsBlock | null | undefined,
  verb: 'ask' | 'deny',
): readonly CommandRule[] {
  return (verb === 'ask' ? block?.ask : block?.deny) ?? []
}

/**
 * The profile's commands block with the inline document's rules added. An
 * inline document may only restrict, so it carries ask and deny rules
 * and never an allow list: a list there would install a command the
 * profile does not have, which is the one thing a per-call document must
 * not do.
 */
/**
 * Refuse an allow list in an inline document.
 *
 * The refusal belongs to *where the document was written*, not to
 * whether a profile happened to resolve, so both paths into `withInline`
 * run it: a workspace with no default profile must not quietly accept a
 * list a workspace with one refuses.
 */
export function refuseAllow(inline: CommandsBlock | null | undefined): void {
  if (inline?.allow !== null && inline?.allow !== undefined) {
    throw new PolicyError('inline permissions may add ask and deny rules, not an allow list')
  }
}

/**
 * Refuse a show entry in an inline document.
 *
 * An inline document may only restrict: it adds ask and deny rules and
 * hides. A show re-opens a subtree or states a mode, which is the
 * profile's to say; same rule as `refuseAllow`, and it runs on both
 * paths into `withInline` for the same reason.
 */
export function refuseShow(inline: SessionProfile): void {
  const blocks = [inline.paths, ...[...(inline.mounts?.values() ?? [])].map((m) => m.paths)]
  if (blocks.some((block) => block != null && (block.show ?? []).length > 0)) {
    throw new PolicyError(
      'inline permissions may add ask and deny rules and hides, not show entries',
    )
  }
}

/** Both blocks' reason groups, the profile's first. */
function mergeReasons(
  a: PathsBlock | null | undefined,
  b: PathsBlock | null | undefined,
): HideReason[] {
  const out: HideReason[] = []
  for (const block of [a, b]) out.push(...(block?.reasons ?? []))
  return out
}

function addCommands(
  base: CommandsBlock | null | undefined,
  inline: CommandsBlock | null | undefined,
): CommandsBlock | null {
  if (inline === null || inline === undefined) return base ?? null
  refuseAllow(inline)
  if (base === null || base === undefined) return inline
  return {
    allow: base.allow ?? null,
    ask: [...(base.ask ?? []), ...(inline.ask ?? [])],
    deny: [...(base.deny ?? []), ...(inline.deny ?? [])],
  }
}

/**
 * One mount's entry with the inline document's added: the weaker mode,
 * both rule lists, both hide lists.
 */
function addMount(base: ProfileMount | undefined, inline: ProfileMount | undefined): ProfileMount {
  if (base === undefined) return inline ?? {}
  if (inline === undefined) return base
  let mode = base.mode ?? null
  if (inline.mode !== null && inline.mode !== undefined) {
    mode = mode === null ? inline.mode : weakerMode(mode, inline.mode)
  }
  const ask = [...rulesOf(base.commands, 'ask'), ...rulesOf(inline.commands, 'ask')]
  const deny = [...rulesOf(base.commands, 'deny'), ...rulesOf(inline.commands, 'deny')]
  const hide = unionHide(base.paths, inline.paths)
  const show = base.paths?.show ?? []
  const reasons = mergeReasons(base.paths, inline.paths)
  const out: { mode?: MountMode | null; commands?: MountCommandsBlock; paths?: PathsBlock } = {}
  if (mode !== null) out.mode = mode
  if (ask.length > 0 || deny.length > 0) out.commands = { ask, deny }
  if (hide.length > 0 || show.length > 0 || reasons.length > 0) {
    out.paths = {
      hide,
      ...(show.length > 0 ? { show } : {}),
      ...(reasons.length > 0 ? { reasons } : {}),
    }
  }
  return out
}

/**
 * A profile with the inline document of one `createSession` added.
 *
 * The one rule about combining two documents: an inline document may
 * add ask and deny rules and hides, never an allow list and never a
 * script, and that holds even when there is no profile to add to. Modes
 * take the weaker of the two, `cwd` and `env` are the inline document's
 * when it states them (they are session presets, not permissions).
 * Either side null returns the other unchanged; the profile's policy
 * survives the merge, since the inline document can only add rules
 * beside it.
 */
export function withInline(
  base: SessionProfile | null,
  inline: SessionProfile | null,
): SessionProfile | null {
  if (inline === null) return base
  refuseAllow(inline.commands)
  refuseShow(inline)
  if (inline.policy !== undefined && inline.policy !== null) {
    throw new PolicyError(
      'inline permissions may add ask and deny rules, not a policy; state one on the profile',
    )
  }
  if (base === null) return inline
  const hidePaths = unionHide(base.paths, inline.paths)
  const hideVars = unionHide(base.vars, inline.vars)
  const out: {
    cwd?: string | null
    env?: Readonly<Record<string, string>> | null
    mounts?: ReadonlyMap<string, ProfileMount> | null
    paths?: PathsBlock | null
    vars?: VarsBlock | null
    commands?: CommandsBlock | null
    policy?: ProfilePolicySpec | null
  } = {}
  out.cwd = inline.cwd ?? base.cwd ?? null
  if (base.env != null || inline.env != null) out.env = { ...base.env, ...inline.env }
  if (base.mounts != null || inline.mounts != null) {
    const prefixes = [...(base.mounts?.keys() ?? [])]
    for (const p of inline.mounts?.keys() ?? []) if (!prefixes.includes(p)) prefixes.push(p)
    out.mounts = new Map(
      prefixes.map((prefix): [string, ProfileMount] => [
        prefix,
        addMount(base.mounts?.get(prefix), inline.mounts?.get(prefix)),
      ]),
    )
  }
  if (base.paths != null || inline.paths != null) {
    const show = base.paths?.show ?? []
    const reasons = mergeReasons(base.paths, inline.paths)
    out.paths = {
      hide: hidePaths,
      ...(show.length > 0 ? { show } : {}),
      ...(reasons.length > 0 ? { reasons } : {}),
    }
  }
  if (base.vars != null || inline.vars != null) out.vars = { hide: hideVars }
  out.commands = addCommands(base.commands, inline.commands)
  if (base.policy != null) out.policy = base.policy
  return out
}

/** One spelling for a mount prefix: leading slash, no trailing one. */
function rootOf(prefix: string): string {
  return '/' + stripSlash(prefix)
}

/**
 * A mount section's path entries, anchored to the mount they are written
 * under.
 *
 * An absolute entry already names something inside the root (`underMount`
 * refuses one that does not) and is left as written. A name pattern
 * (`*.pem`, no slash) anchors nothing, and both places a mount section's
 * entries are read from have lost the section by then: the session's
 * hidden set is one list for every mount, and the op door matches a
 * rule's paths without consulting `rule.mount`. Left raw,
 * `mounts./repo.paths.hide: ["*.pem"]` hid `/other/key.pem` too, and a
 * path-only deny under `/repo` refused a read of it. The dialect's `*`
 * crosses `/`, so `/repo/*.pem` is every `.pem` at any depth below
 * `/repo` and nothing outside it; anchoring also gives the entry the
 * mount's own anchor depth, which is what it was always worth.
 */
function anchored(entries: readonly string[], root: string): string[] {
  const head = root === '/' ? '' : root
  return entries.map((e) => (e.startsWith('/') ? e : `${head}/${e}`))
}

/**
 * A mount section's rules, stamped with the mount they belong to and
 * anchored to it. The stamp is what makes the rule apply to a line that
 * *works inside* the mount, by cwd or by operand, which a path-scoped
 * rule cannot express. The anchor is for the entries the stamp cannot
 * reach: the op door reads a rule's paths alone (`anchored`).
 */
function scopeRules(rules: readonly CommandRule[], root: string): CommandRule[] {
  return rules.map((rule) =>
    rule.paths === undefined
      ? { ...rule, mount: root }
      : { ...rule, paths: anchored(rule.paths, root), mount: root },
  )
}

/**
 * A profile's admission rules: its own, plus every mount section's, in one
 * list; null when the profile states none. Mount rules come first so the
 * section closest to the data speaks first when several rules match at
 * the same anchor depth and only the message differs.
 */
export function compileCommands(profile: SessionProfile): AdmissionRules | null {
  const ask: CommandRule[] = []
  const deny: CommandRule[] = []
  for (const [prefix, entry] of profile.mounts ?? new Map<string, ProfileMount>()) {
    const root = rootOf(prefix)
    ask.push(...scopeRules(rulesOf(entry.commands, 'ask'), root))
    deny.push(...scopeRules(rulesOf(entry.commands, 'deny'), root))
  }
  const block = profile.commands
  const allow = block?.allow ?? null
  if (block != null) {
    ask.push(...(block.ask ?? []))
    deny.push(...(block.deny ?? []))
  }
  if (allow === null && ask.length === 0 && deny.length === 0) return null
  return { allow, ask, deny }
}

/**
 * Every path the profile hides: its own entries, and each mount section's
 * anchored to the mount it was written under, since the set is one list
 * for the whole session and nothing in it remembers which section an
 * entry came from (`anchored`).
 */
function hiddenOf(profile: SessionProfile): HiddenPaths | null {
  const entries = [...(profile.paths?.hide ?? [])]
  for (const [prefix, entry] of profile.mounts ?? new Map<string, ProfileMount>()) {
    entries.push(...anchored(entry.paths?.hide ?? [], rootOf(prefix)))
  }
  return classifyPaths(entries)
}

/**
 * Every show entry the profile states: its own and each mount
 * section's, one list, since a show entry is absolute wherever it is
 * written and the compiled axis has no sections.
 */
function shownOf(profile: SessionProfile): ShownPaths | null {
  const entries: ShowEntry[] = [...(profile.paths?.show ?? [])]
  for (const entry of profile.mounts?.values() ?? []) {
    entries.push(...(entry.paths?.show ?? []))
  }
  return classifyShows(entries)
}

/**
 * The operator's reasons for grouped hides, a mount section's anchored
 * to its mount exactly like the hide entries they describe, so the
 * side table names what the compiled spec matches.
 */
function hideReasonsOf(profile: SessionProfile): readonly HideReason[] {
  const groups: HideReason[] = [...(profile.paths?.reasons ?? [])]
  for (const [prefix, entry] of profile.mounts ?? new Map<string, ProfileMount>()) {
    const root = rootOf(prefix)
    groups.push(
      ...(entry.paths?.reasons ?? []).map(
        (g): HideReason => ({ patterns: anchored(g.patterns, root), reason: g.reason }),
      ),
    )
  }
  return groups
}

/**
 * The mode each mount section states, null when none does. A mount the
 * profile does not name is absent from the map and keeps the mode it
 * declares in the workspace's `mounts:`; the map only narrows, it never
 * grants.
 */
function modesOf(profile: SessionProfile): Map<string, MountMode> | null {
  const modes = new Map<string, MountMode>()
  for (const [prefix, entry] of profile.mounts ?? new Map<string, ProfileMount>()) {
    if (entry.mode !== null && entry.mode !== undefined) modes.set(prefix, entry.mode)
  }
  return modes.size > 0 ? modes : null
}

/**
 * The profile's policy program, compiled onto the session. `name` is
 * the profile's name, empty for a document passed without one; what the
 * policy reads as `ctx.profile`.
 *
 * @throws PolicyError - the policy is still a path, which means it
 * reached the workspace without passing the config door that loads one.
 */
export function compileScript(effective: SessionProfile, name: string): ProfileScript | null {
  const policy = effective.policy
  if (policy === undefined || policy === null) return null
  if (typeof policy.script === 'string') {
    throw new PolicyError(
      `profile '${name}' names a policy by path ('${policy.script}'); ` +
        `only the config door loads one, pass ScriptSource in code`,
    )
  }
  return { profile: name, script: policy.script, runtime: policy.runtime }
}

/** The session fields a profile compiles to. */
export function compileProfile(effective: SessionProfile | null, name = ''): CompiledProfile {
  if (effective === null) {
    return {
      mountModes: null,
      hiddenPaths: null,
      hiddenVars: null,
      env: null,
      cwd: null,
      commands: null,
      script: null,
      shownPaths: null,
      hideReasons: [],
      profile: name === '' ? null : name,
    }
  }
  const commands = compileCommands(effective)
  checkRules(commands)
  return {
    mountModes: modesOf(effective),
    hiddenPaths: hiddenOf(effective),
    hiddenVars: classifyVars(effective.vars?.hide ?? []),
    env: effective.env ?? null,
    cwd: effective.cwd ?? null,
    commands,
    script: compileScript(effective, name),
    shownPaths: shownOf(effective),
    hideReasons: hideReasonsOf(effective),
    profile: name === '' ? null : name,
  }
}

/**
 * Stamp a compiled profile's narrowing onto a session: the fields no
 * shell line can edit (the per-mount modes, hidden paths, show entries,
 * hidden variables, hide reasons, the admission rules, the profile's
 * script, the profile's name). Applied at creation and again
 * whenever a stored record could carry a stale copy (the default
 * session after hydration), so the document, not the store, is what an
 * agent runs under.
 */
export function narrow(session: Session, compiled: CompiledProfile): void {
  session.mountModes = compiled.mountModes === null ? null : new Map(compiled.mountModes)
  session.hiddenPaths = compiled.hiddenPaths
  session.shownPaths = compiled.shownPaths ?? null
  session.hiddenVars = compiled.hiddenVars
  session.hideReasons = compiled.hideReasons ?? []
  session.commands = compiled.commands
  session.script = compiled.script ?? null
  session.profile = compiled.profile ?? null
}

/**
 * A session's narrowing read back as a compiled profile.
 *
 * What `narrow` stamps, in the shape it stamps from, so a caller that
 * narrows a live session speculatively can put the session back with
 * `narrow(session, saved)`. A restore does exactly that: it joins each
 * table's profile onto the session before the `preSession` gate runs,
 * and a refusal there has to leave the workspace as it was. The
 * scratch halves of a profile (`env`, `cwd`) are not narrowing and are
 * not read.
 */
export function narrowingOf(session: Session): CompiledProfile {
  return {
    mountModes: session.mountModes === null ? null : new Map(session.mountModes),
    hiddenPaths: session.hiddenPaths,
    hiddenVars: session.hiddenVars,
    env: null,
    cwd: null,
    commands: session.commands,
    script: session.script,
    shownPaths: session.shownPaths,
    hideReasons: session.hideReasons,
    profile: session.profile,
  }
}

/**
 * Join a profile onto a session that is already running, never wider.
 *
 * `narrow` stamps a profile onto a session the host creates or resets;
 * this adds one to a live session, which is what a restore does to the
 * session a stored table lands on. A table names the profile its source
 * session ran under, and the target's document of that name is what
 * must govern the restored session — including its policy program,
 * which the table cannot carry and `narrowRestored` deliberately never
 * takes off it. The join is `narrowRestored`'s, for the same reason:
 * restrictions union, grants intersect, so a session that has
 * accumulated restrictions of its own keeps every one of them.
 *
 * The program is the profile's when the session runs none, and the
 * session's when it does: a checkout must not swap out a program the
 * host installed with `setSessionProfile`, which stays the host's
 * reset. The name travels with the program, so a session never reports
 * a group whose script it is not running.
 */
export function narrowProfile(session: Session, compiled: CompiledProfile): void {
  const modes = mergeModes(session.mountModes, compiled.mountModes)
  const hidden = mergeHiddenPaths(session.hiddenPaths, compiled.hiddenPaths)
  const shown = mergeShown(
    { caps: session.mountModes, hidden: session.hiddenPaths, shown: session.shownPaths },
    {
      caps: compiled.mountModes,
      hidden: compiled.hiddenPaths,
      shown: compiled.shownPaths ?? null,
    },
  )
  session.hiddenVars = mergeHiddenVars(session.hiddenVars, compiled.hiddenVars)
  session.hideReasons = mergeGroups(session.hideReasons, compiled.hideReasons ?? [])
  session.commands = mergeCommands(session.commands, compiled.commands)
  if (session.script === null) {
    session.script = compiled.script ?? null
    session.profile = compiled.profile ?? null
  }
  session.mountModes = modes
  session.hiddenPaths = hidden
  session.shownPaths = shown
}

/**
 * Narrow a fresh session and seed its scratch state from the profile.
 * A profile's env is a *process* environment, the same shape
 * `ws.env = {...}` speaks, so every name in it is exported: seeding
 * them plain left `$TOKEN` expanding while every command, CLI and
 * guest runtime in the profiled session saw nothing, since all three
 * read `envSnapshot` and that is the exported set. The cwd is where
 * the session starts; both are the agent's to change afterwards, which
 * is why hydration keeps the stored ones and re-stamps only `narrow`.
 */
export function applyProfile(session: Session, compiled: CompiledProfile): void {
  narrow(session, compiled)
  if (compiled.env != null) Object.assign(session.vars, varsFromEnv(compiled.env))
  if (compiled.cwd !== null) setCwd(session, compiled.cwd)
}

/** The entries in order, each spelling once. */
function dedupe(entries: readonly string[]): string[] {
  const out: string[] = []
  for (const entry of entries) if (!out.includes(entry)) out.push(entry)
  return out
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i])
}

function sameModes(a: ReadonlyMap<string, MountMode>, b: ReadonlyMap<string, MountMode>): boolean {
  if (a.size !== b.size) return false
  for (const [prefix, mode] of a) if (b.get(prefix) !== mode) return false
  return true
}

/**
 * The weaker mode per prefix over both maps, prefixes normalized; the
 * base map itself when the table narrows nothing.
 */
function mergeModes(
  base: ReadonlyMap<string, MountMode> | null,
  table: ReadonlyMap<string, MountMode> | null,
): ReadonlyMap<string, MountMode> | null {
  if (table === null) return base
  const merged = new Map<string, MountMode>()
  for (const [prefix, mode] of base ?? []) merged.set(rootOf(prefix), mode)
  for (const [prefix, mode] of table) {
    const root = rootOf(prefix)
    const have = merged.get(root)
    merged.set(root, have === undefined ? mode : weakerMode(have, mode))
  }
  return base !== null && sameModes(merged, base) ? base : merged
}

/**
 * Both hide sets in one, the session's entries first; the session's own
 * object when the table hides nothing new.
 */
function mergeHiddenPaths(base: HiddenPaths | null, table: HiddenPaths | null): HiddenPaths | null {
  if (table === null) return base
  if (base === null) return table
  const merged = classifyPaths(
    dedupe([
      ...(base.paths ?? []),
      ...(base.patterns ?? []),
      ...(table.paths ?? []),
      ...(table.patterns ?? []),
    ]),
  )
  if (
    merged !== null &&
    sameStrings(merged.paths ?? [], base.paths ?? []) &&
    sameStrings(merged.patterns ?? [], base.patterns ?? [])
  ) {
    return base
  }
  return merged
}

/**
 * Both hidden-variable sets in one, the session's first; the session's
 * own object when the table hides nothing new.
 */
function mergeHiddenVars(base: HiddenVars | null, table: HiddenVars | null): HiddenVars | null {
  if (table === null) return base
  if (base === null) return table
  const merged = classifyVars(
    dedupe([
      ...(base.names ?? []),
      ...(base.patterns ?? []),
      ...(table.names ?? []),
      ...(table.patterns ?? []),
    ]),
  )
  if (
    merged !== null &&
    sameStrings(merged.names ?? [], base.names ?? []) &&
    sameStrings(merged.patterns ?? [], base.patterns ?? [])
  ) {
    return base
  }
  return merged
}

function sameGroup(a: HideReason, b: HideReason): boolean {
  return a.reason === b.reason && sameStrings(a.patterns, b.patterns)
}

/** The session's reason groups, then the table's it lacks. */
function mergeGroups(
  base: readonly HideReason[],
  table: readonly HideReason[],
): readonly HideReason[] {
  const out = [...base]
  for (const group of table) if (!out.some((have) => sameGroup(have, group))) out.push(group)
  return out.length === base.length ? base : out
}

function sameRule(a: CommandRule, b: CommandRule): boolean {
  return (
    a.reason === b.reason &&
    sameStrings(a.commands ?? [], b.commands ?? []) &&
    sameStrings(a.paths ?? [], b.paths ?? []) &&
    (a.mount ?? '') === (b.mount ?? '')
  )
}

/** The session's rules, then the table's it lacks. */
function appendRules(
  base: readonly CommandRule[],
  table: readonly CommandRule[],
): readonly CommandRule[] {
  const out = [...base]
  for (const rule of table) if (!out.some((have) => sameRule(have, rule))) out.push(rule)
  return out.length === base.length ? base : out
}

/**
 * The allow list both sides grant. One side stating a list installs
 * only what it lists, so that list stands when the other states none;
 * two lists intersect pattern by pattern (`intersectPatterns`), which
 * can only remove. The session's own list stands when the table spells
 * the same set, so a table that adds nothing changes nothing.
 */
function mergeAllow(
  base: readonly string[] | null,
  table: readonly string[] | null,
): readonly string[] | null {
  if (table === null) return base
  if (base === null) return table
  const have = new Set(base)
  const want = new Set(table)
  if (have.size === want.size && [...have].every((pattern) => want.has(pattern))) return base
  return intersectPatterns(base, table)
}

/**
 * The mount both rules speak inside, spelled as the deeper was. An
 * empty mount is the whole session, so the other's stands; two mounts
 * share the deeper when one lies under the other, and nothing when
 * neither does, since no line's subject sits in both.
 */
function sharedMount(mine: string, other: string): string | null {
  if (mine === '' || other === '') return mine === '' ? other : mine
  const a = rootOf(mine)
  const b = rootOf(other)
  if (a === b || b === '/' || a.startsWith(`${b}/`)) return mine
  if (a === '/' || b.startsWith(`${a}/`)) return other
  return null
}

/**
 * The command patterns both rules speak about, null when no line can
 * match both. No pattern on a side means every command, so the other
 * side's list stands; two lists meet token by token
 * (`intersectPatterns`, so a `git` ask and a `git push` deny share
 * `git push`), and an empty meeting means the two rules never read the
 * same line.
 */
function sharedCommands(
  mine: readonly string[],
  other: readonly string[],
): readonly string[] | null {
  if (mine.length === 0 || other.length === 0) return mine.length === 0 ? other : mine
  const shared = intersectPatterns(mine, other)
  return shared.length === 0 ? null : shared
}

/**
 * How deep a deny reaches an ask's path entry from above it: the anchor
 * depth of its deepest entry covering the ask's from higher up (the
 * hide law's own covering test, since a rule's path entries are the
 * same grammar); 0 for a pathless deny, which every placed entry
 * outranks; null when the deny does not reach the entry, or reaches it
 * at the entry's own depth, where the verb tie-break already lets it
 * win.
 */
function reachAbove(deny: CommandRule, entry: string): number | null {
  const depth = anchorDepth(entry)
  const paths = deny.paths ?? []
  if (paths.length === 0) return depth > 0 ? 0 : null
  let best: number | null = null
  for (const path of paths) {
    const at = anchorDepth(path)
    if (at >= depth || hideDepth(classifyPaths([path]), entry) === null) continue
    if (best === null || at > best) best = at
  }
  return best
}

/**
 * Whether a side's own ask already outranks its deny at an entry, so
 * that side's answer there is a question and not a refusal. The ask has
 * to cover the entry from below the deny's reach (the entry's own depth
 * counts; a tie with the deny does not, since the deny wins it) and
 * speak about every command the two rules share, because a narrower
 * ask leaves the deny answering the rest. Its mount needs no check: a
 * rule's entries lie under its mount, so a line the entry names touches
 * it.
 */
function shields(
  ask: CommandRule,
  entry: string,
  floor: number,
  commands: readonly string[],
): boolean {
  const own = ask.commands ?? []
  const spellings = commands.length > 0 ? commands : [WILDCARD]
  if (
    own.length > 0 &&
    !spellings.every((spelling) => own.some((pat) => patternMatches(pat, splitPattern(spelling))))
  ) {
    return false
  }
  return (ask.paths ?? []).some(
    (path) => anchorDepth(path) > floor && hideDepth(classifyPaths([path]), entry) !== null,
  )
}

/**
 * The other side's denies, restated at one side's ask entries.
 *
 * The composition the join owes: where one side asks and the other
 * denies, the answer is the deny, since a deny is the stricter of the
 * two. `ruleAt` reads competing rules by anchor depth, deny before ask
 * only at equal depth, so a deeper ask would outrank the shallower deny
 * and turn the refusal into a prompt. Each such deny is restated at the
 * ask's own depth, in the scope the two rules share (the commands and
 * the mount both speak about), where the verb tie-break lets the
 * refusal win; the ask itself stays whole, so outside that scope it
 * still asks. A top-level `cat` ask meeting a deny written under one
 * mount is refused inside that mount, an all-command ask meeting a
 * `cat` deny is refused for `cat` and asked for the rest, and a `git`
 * ask meeting a `git push` deny is refused for the push alone. Nothing
 * is dropped, since dropping an entry would answer *allow* and lift the
 * question its own side asked; and nothing is refused that the deny did
 * not already refuse, since the restated rule reads a subset of its
 * lines.
 *
 * A deny the other side's own deeper ask already outranks at that entry
 * is not restated: that side's answer there was a question, not a
 * refusal, so there is nothing to keep. That is what makes joining a
 * rule set with itself a no-op, its carve-outs included.
 *
 * Returns the deny rules to add, each carrying the reason of the deny
 * it restates; empty when nothing would be lifted.
 */
function curbAsks(asks: readonly CommandRule[], other: AdmissionRules): readonly CommandRule[] {
  const copies: CommandRule[] = []
  for (const rule of asks) {
    for (const entry of rule.paths ?? []) {
      for (const deny of other.deny) {
        const commands = sharedCommands(rule.commands ?? [], deny.commands ?? [])
        const mount = sharedMount(rule.mount ?? '', deny.mount ?? '')
        if (commands === null || mount === null) continue
        const floor = reachAbove(deny, entry)
        if (floor === null || other.ask.some((ask) => shields(ask, entry, floor, commands))) {
          continue
        }
        const copy: CommandRule = {
          reason: deny.reason,
          ...(commands.length > 0 ? { commands } : {}),
          paths: [entry],
          ...(mount !== '' ? { mount } : {}),
        }
        if (!copies.some((have) => sameRule(have, copy))) copies.push(copy)
      }
    }
  }
  return copies
}

/**
 * Both rule sets as one: ask and deny rules union, the allow list
 * intersects; the session's own object when the table adds nothing.
 *
 * The union is not a concatenation. Two rule sets read together are
 * read by anchor depth, so an ask from one side can outrank a deny from
 * the other and answer a refusal with a prompt; `curbAsks` restates
 * each such deny at the ask's depth, in both directions, so a deny from
 * either side stays a deny.
 */
function mergeCommands(
  base: AdmissionRules | null,
  table: AdmissionRules | null,
): AdmissionRules | null {
  if (table === null) return base
  if (base === null) return table
  const allow = mergeAllow(base.allow, table.allow)
  const ask = appendRules(base.ask, table.ask)
  const deny = appendRules(
    appendRules(base.deny, table.deny),
    appendRules(curbAsks(base.ask, table), curbAsks(table.ask, base)),
  )
  if (allow === base.allow && ask === base.ask && deny === base.deny) return base
  return { allow, ask, deny }
}

/**
 * The per-mount cap in force at a path: the mode of the longest prefix
 * covering it, null when none does.
 */
function capOf(modes: ReadonlyMap<string, MountMode> | null, head: string): MountMode | null {
  let best: [number, MountMode] | null = null
  for (const [prefix, mode] of modes ?? []) {
    const root = rootOf(prefix)
    if (root === '/' || head === root || head.startsWith(`${root}/`)) {
      const depth = anchorDepth(root)
      if (best === null || depth > best[0]) best = [depth, mode]
    }
  }
  return best === null ? null : best[1]
}

/** One side of a show merge: its caps, its hides and its shows. */
interface Side {
  readonly caps: ReadonlyMap<string, MountMode> | null
  readonly hidden: HiddenPaths | null
  readonly shown: ShownPaths | null
}

/** Whether a hide set names anything at all. */
function hidesAnything(hidden: HiddenPaths | null): boolean {
  if (hidden === null) return false
  return (hidden.paths ?? []).length > 0 || (hidden.patterns ?? []).length > 0
}

/**
 * Whether one side leaves a path the other side shows accessible.
 *
 * The question a one-sided show turns on, and it is asked of the
 * *other* side, never of the merged hide set: a show exists to re-open
 * what a hide covers, so the side that states it has a hide over it by
 * construction, and testing the union would drop every show against
 * its own hide.
 *
 * It is the composition law's own rule (`pathVisible` without its road
 * clause, which only makes a hidden ancestor listable): the path is
 * granted when no hide covers it, or when a show covers it more deeply
 * than the deepest hide that does. Asking the shows and not only the
 * hides is what keeps a *nested* carve-out: one side's
 * `show /vault/public` grants the other side's narrower
 * `show /vault/public/docs`, and the narrower one is the intersection
 * of the two grants.
 *
 * A pattern that anchors nothing (`*.key`, no separator) re-opens by
 * name anywhere and no depth comparison bounds it, so it is granted
 * only where the other side hides nothing at all.
 *
 * One stated limit, and it is the grammar's rather than this
 * function's. An anchored pattern is asked the same question as a path,
 * so the other side *covering* it grants it (`/vault/*` grants
 * `/vault/a/*`, since the coverage test walks the entry's own
 * prefixes). Two patterns that merely *overlap* -- `/vault/*``/public`
 * beside `/vault/a/*` -- have no single entry that names their common
 * ground: `*` crosses separators here, as GNU `find -path` has it, so
 * the overlap is a family of paths and not a subtree. Neither grants
 * the other and both are dropped, which can hide a path both sides
 * allow. That is the narrowing direction, which is the one to fail in;
 * naming a wrong intersection would be the other.
 */
function grants(side: Side, path: string): boolean {
  if (isGlob(path) && !path.includes('/')) return !hidesAnything(side.hidden)
  const hide = hideDepth(side.hidden, path)
  if (hide === null) return true
  const show = showDepth(side.shown, path)
  return show !== null && show > hide
}

/**
 * The mode one side allows below a path, null when it states none.
 *
 * A show scores deeper than a per-mount cap, so a show mode covering
 * the path is the answer where there is one and the cap is the answer
 * otherwise -- the same order `pathMode` reads them in.
 */
function allowance(side: Side, path: string): MountMode | null {
  const stated = shownMode(side.shown, path)
  return stated !== null ? stated[1] : capOf(side.caps, path)
}

/** A mode one side states, held under what the other side allows. */
function held(mode: MountMode, allowed: MountMode | null): MountMode {
  return allowed === null ? mode : weakerMode(mode, allowed)
}

/**
 * One show entry as both sides allow it, or null to drop it.
 *
 * A show does two things, and each side has to have said it. It
 * re-opens what a hide covers, so an entry only one side states
 * survives exactly where the other side hides nothing over it
 * (`hidesShow`) — that side left the path open, so both allow it. It
 * states the mode below its anchor, and a show scores deeper than a
 * per-mount cap, so a mode only one side states is held under the other
 * side's cap there; two stated modes take the weaker; two list-form
 * entries stay list-form, since the merged caps already hold the weaker
 * mode below them. The entry itself is returned when nothing changed,
 * so an identical table leaves the session's objects in place.
 */
function mergeShow(
  mine: ShowEntry,
  other: ShowEntry | null,
  mySide: Side,
  otherSide: Side,
): ShowEntry | null {
  let mode: MountMode | null
  if (other === null) {
    if (!grants(otherSide, mine.path)) return null
    if (mine.mode === null) return mine
    mode = held(mine.mode, allowance(otherSide, mine.path))
  } else if (mine.mode === null && other.mode === null) {
    return mine
  } else if (mine.mode !== null && other.mode !== null) {
    mode = weakerMode(mine.mode, other.mode)
  } else if (mine.mode !== null) {
    mode = held(mine.mode, allowance(otherSide, mine.path))
  } else {
    mode = other.mode === null ? null : held(other.mode, allowance(mySide, mine.path))
  }
  return mode === mine.mode ? mine : { path: mine.path, mode }
}

/**
 * Both sides' show entries as both allow them (`mergeShow`), the
 * session's first; the session's own object when nothing changed.
 */
/**
 * One side's show entries, one per path, at its weakest mode.
 *
 * A session table keeps every entry it was given, and two entries for
 * one path do not mean the deeper mode: `shownMode` takes the weaker of
 * two at a depth, failing toward refusal. Matching by path against the
 * raw list would pair the other side against whichever spelling came
 * last and restore an `rwx` the source never had, so each side is
 * folded to what is actually in force before the two are compared. A
 * list-form entry (no mode) states visibility only and answers no mode
 * question, so a stated mode beside it stands.
 */
function folded(shown: ShownPaths | null): readonly ShowEntry[] {
  const out = new Map<string, ShowEntry>()
  for (const entry of shown?.entries ?? []) {
    const held = out.get(entry.path)
    if (held === undefined) {
      out.set(entry.path, entry)
    } else if (entry.mode !== null) {
      out.set(entry.path, {
        path: entry.path,
        mode: held.mode === null ? entry.mode : weakerMode(held.mode, entry.mode),
      })
    }
  }
  return [...out.values()]
}

function mergeShown(base: Side, table: Side): ShownPaths | null {
  if (base.shown === null && table.shown === null) return null
  const baseEntries = folded(base.shown)
  const tableEntries = folded(table.shown)
  const byTable = new Map(tableEntries.map((entry) => [entry.path, entry]))
  const byBase = new Set(baseEntries.map((entry) => entry.path))
  const out: ShowEntry[] = []
  for (const entry of baseEntries) {
    const merged = mergeShow(entry, byTable.get(entry.path) ?? null, base, table)
    if (merged !== null) out.push(merged)
  }
  for (const entry of tableEntries) {
    if (byBase.has(entry.path)) continue
    const merged = mergeShow(entry, null, table, base)
    if (merged !== null) out.push(merged)
  }
  const held2 = base.shown
  if (
    held2 !== null &&
    out.length === held2.entries.length &&
    out.every((entry, i) => entry === held2.entries[i])
  ) {
    return held2
  }
  return classifyShows(out)
}

/**
 * Land a stored session table on a session, never wider than either.
 *
 * The restore's counterpart of `narrow`. A snapshot carries a session's
 * narrowing as it stood in the source deployment; the session it lands
 * on already runs under the target's document (the profile of the same
 * name, or the live session's on a checkout). One rule joins the two:
 * restrictions union, grants intersect, the program is the target's.
 * Caps take the weaker mode per prefix, hides and hidden variables
 * union, hide reasons and ask and deny rules append what the session
 * lacks, the allow list is what both grant, a show survives only as
 * both sides allow it (`mergeShow`), and `script` and `profile` stay
 * the session's, since a policy program is deployment code and the gate
 * judged the table under the target's. Every field keeps the session's
 * own object when the table adds nothing, so a table taken from the
 * same document is the identity, and running this twice is running it
 * once, which a checkout that lands live tables back on themselves
 * relies on.
 *
 * Two consequences worth stating. On a running workspace a checkout can
 * only add restrictions to a live session, never lift one: a hide from
 * one version survives checking out another, and `setSessionProfile` is
 * the host's reset. And a show only one side states is dropped where
 * the *other* side hides its anchor, mode and all, so a mode it
 * restricted there reverts to the target's allowance; the show grammar
 * has no spelling for a mode without a re-open. Its own side's hide
 * never drops it: a show is always stated against a hide, so reading
 * the union would erase every show exception the other side simply
 * never mentioned. Mirrors the Python `narrow_restored`.
 */
export function narrowRestored(session: Session, table: Session): void {
  const modes = mergeModes(session.mountModes, table.mountModes)
  const hidden = mergeHiddenPaths(session.hiddenPaths, table.hiddenPaths)
  const shown = mergeShown(
    { caps: session.mountModes, hidden: session.hiddenPaths, shown: session.shownPaths },
    { caps: table.mountModes, hidden: table.hiddenPaths, shown: table.shownPaths },
  )
  session.hiddenVars = mergeHiddenVars(session.hiddenVars, table.hiddenVars)
  session.hideReasons = mergeGroups(session.hideReasons, table.hideReasons)
  session.commands = mergeCommands(session.commands, table.commands)
  session.mountModes = modes
  session.hiddenPaths = hidden
  session.shownPaths = shown
}
