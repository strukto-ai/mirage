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
import type { CommandRule, AdmissionRules, HideReason, ProfileScript } from '../../policy/types.ts'
import type { HiddenPaths, MountMode, ShowEntry, ShownPaths } from '../../types.ts'
import { weakerMode } from '../../types.ts'
import { classifyPaths, classifyShows, classifyVars } from '../../utils/hidden.ts'
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
