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

import { DEFAULT_ASK_REASON, DEFAULT_DENY_REASON } from './constants.ts'
import type { CommandRule, AdmissionRules, ProfileScript } from './types.ts'
import { ScriptSource } from '../runtime/routing/types.ts'
import type { HiddenPaths, HiddenVars, ShowEntry, ShownPaths } from '../types.ts'
import { type MountMode, parseMountMode } from '../types.ts'
import type { HideReason } from './types.ts'
import { isGlob } from '../utils/hidden.ts'
import { stripSlash } from '../utils/slash.ts'

/**
 * `paths:` of a profile, or of one of its mount sections. `hide` entries
 * use the document's one grammar: an entry with `*`, `?` or `[` is a
 * pattern, anything else an exact path and its subtree
 * (`utils/hidden.classifyPaths`); every entry holds a token and is
 * absolute or a name pattern, wherever the block is written. A hide
 * entry may also be a group `{patterns: [...], reason: ...}`: the
 * patterns join the flat list like any other entry and the reason lands
 * in `reasons`, the operator-only side table (`HideReason`).
 *
 * `show` is the other half of the path axis: a mapping of path to mode
 * (`{"/repo/docs": "r"}`), or a plain list whose entries inherit the
 * mount's mode. Every entry is absolute, a subtree or an anchored
 * pattern, because a show anchors to a place and a name pattern names
 * none. An entry re-opens its subtree inside a hidden region when its
 * anchor is deeper than the hide's, and states the mode in force below
 * its anchor when it carries one; both on the one anchor-depth rule.
 */
export interface PathsBlock {
  readonly hide: readonly string[]
  readonly show?: readonly ShowEntry[]
  readonly reasons?: readonly HideReason[]
}

/** `vars:` of a profile: names or globs over names the session reads as unset. */
export interface VarsBlock {
  readonly hide: readonly string[]
}

/**
 * `commands:` at the top level of a profile. `allow` lists the command
 * patterns the profile installs; a name none of them starts with is not a
 * command for the session (127, absent from `type` / `which` / `man`),
 * a line no pattern covers is refused. Shell builtins are subjects like
 * everything else: a list stating only `cat` leaves no `echo` and no
 * `cd`. The agent's own functions are the one exemption, safe because
 * every line of a body passes the gate itself. `ask` rules are admitted
 * only with a host approval; `deny` rules refuse with a reason. A bare
 * string in either is one command pattern with the default reason.
 * `allow` null or absent (unstated) installs everything.
 */
export interface CommandsBlock {
  readonly allow?: readonly string[] | null
  readonly ask?: readonly CommandRule[]
  readonly deny?: readonly CommandRule[]
}

/**
 * `commands:` of one mount section: `ask` and `deny` only. A mount rule
 * applies to a line that works inside the mount (its cwd or one of its
 * paths lies under the root); its `paths` are absolute, like every other
 * path in the document, and must name something under that root. There
 * is no `allow` here: what a session can see is a property of the
 * session, and an operand cannot make a command "not found".
 */
export interface MountCommandsBlock {
  readonly ask?: readonly CommandRule[]
  readonly deny?: readonly CommandRule[]
}

/**
 * One mount's entry in a profile: what this profile may do there. Every field
 * is optional, and an omitted mount is not a refusal: the mount is
 * reachable at the mode it declares in the workspace's `mounts:`, which
 * a profile can only weaken (`weakerMode`), never raise. A profile that must
 * not touch a mount hides it, so the mount reads as nonexistent rather
 * than as a permission error naming something the profile cannot see.
 *
 * `commands` here carries ask and deny only: an allow list installs a
 * command for the whole session, and visibility is answered before any
 * operand exists, so it cannot be per mount. Rules written here apply to
 * a line that works inside this mount, by cwd or by operand, which is
 * what a path-scoped rule cannot express (`cd /repo && git commit` names
 * no path).
 */
export interface ProfileMount {
  readonly mode?: MountMode | null
  readonly commands?: MountCommandsBlock | null
  readonly paths?: PathsBlock | null
}

/**
 * One profile: the whole permission document a session runs under.
 *
 * A session is created from exactly one of these, and it is the only
 * place permissions are written. There is no workspace-wide block and
 * no mount-owned block above it, so reading this object is reading
 * everything the profile may do; what a profile does not say, it does not
 * restrict. Configuration, not enforcement: the resolver compiles it
 * onto the session's narrowing fields and the doors keep enforcing.
 * Deliberately not named a View, which per the view convention is a
 * door-scoped handle an agent holds, while a profile is what the
 * embedder uses to *define* one. Immutable by type, so two agents with
 * the same profile share one object and neither can bend the other's view.
 *
 * Two rules decide a line against it, and they are the whole law. A
 * rule naming no path is read by verb (deny before ask before allow),
 * wherever it is written. A rule carrying paths, and every hide, is
 * read by anchor depth: the deeper entry wins, ties break by verb.
 *
 * `mounts` is keyed by prefix; a bare mode string is sugar for the
 * section that carries only a mode. `parseProfileMounts` normalizes
 * every spelling and the resolver reads only the normalized form.
 */
export interface SessionProfile {
  readonly cwd?: string | null
  readonly env?: Readonly<Record<string, string>> | null
  readonly mounts?: ReadonlyMap<string, ProfileMount> | null
  readonly paths?: PathsBlock | null
  readonly vars?: VarsBlock | null
  readonly commands?: CommandsBlock | null
  /**
   * The profile's policy: a program defining the admission hooks it
   * answers at, the way a coded Policy defines only the hooks it cares
   * about: `preCommand(ctx)` per command, `preOps(ctx)` per VFS op,
   * `preSession(ctx)` per env write (`pre_command`, `pre_ops`,
   * `pre_session` in python). Each is handed the door's facts as `ctx`
   * and answers with `return`: null or 'allow' for no opinion, 'deny' /
   * {deny: reason}, and at the command gate 'ask' / {ask: reason}. A block
   * naming the program and the engine it runs on, the shape a `clis`
   * entry has. The document is optional beside it: a profile stating
   * only a policy hides nothing, and the policy is its whole admission
   * policy.
   */
  readonly policy?: ProfilePolicySpec | null
}

/**
 * A profile's policy as the document states it: the program, and the
 * engine that runs it.
 *
 * `script` is the path form the config door accepts and loads; code
 * passes the loaded ScriptSource, so a path still spelled as a string
 * when the workspace reads it means the config layer never saw it.
 * `runtime` is required: there is no default engine, because an engine
 * the operator never chose should not be the one their policy runs on.
 */
export interface ProfilePolicySpec {
  readonly script: ScriptSource | string
  readonly runtime: string
}

/**
 * The session fields a profile compiles to. `commands` is the profile's
 * admission rules, its own and its mount sections' in one list;
 * `script` is its policy program, which `ScriptPolicy` calls at the
 * admission gate.
 */
export interface CompiledProfile {
  readonly mountModes: ReadonlyMap<string, MountMode> | null
  readonly hiddenPaths: HiddenPaths | null
  readonly hiddenVars: HiddenVars | null
  readonly env: Readonly<Record<string, string>> | null
  readonly cwd: string | null
  readonly commands: AdmissionRules | null
  readonly script?: ProfileScript | null
  /** Every show entry the profile states, its own and its mount sections'. */
  readonly shownPaths?: ShownPaths | null
  /** The operator's reasons for grouped hides, never rendered to the agent. */
  readonly hideReasons?: readonly HideReason[]
  /** The profile's name, null for a document passed without one; the session's group. */
  readonly profile?: string | null
}

const RULE_FIELDS = ['reason', 'commands', 'paths'] as const
const PATHS_FIELDS = ['hide', 'show', 'reasons'] as const
const VARS_FIELDS = ['hide'] as const
const COMMANDS_FIELDS = ['allow', 'ask', 'deny'] as const
const MOUNT_COMMANDS_FIELDS = ['ask', 'deny'] as const
const PROFILE_MOUNT_FIELDS = ['mode', 'commands', 'paths'] as const
const PROFILE_FIELDS = ['cwd', 'env', 'mounts', 'paths', 'vars', 'commands', 'policy'] as const
const POLICY_FIELDS = ['script', 'runtime'] as const

// A document mapping, not merely "an object": a Set, a Date or any class
// instance has no own enumerable string keys, so Object.entries would read
// one as an empty mapping and a `mounts` Set would compile to a session
// granting nothing at all. Python refuses the same values loudly.
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return false
  const proto: unknown = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function rejectUnknownKeys(
  block: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): void {
  for (const key of Object.keys(block)) {
    if (!allowed.includes(key)) {
      throw new Error(`${where}: unknown field \`${key}\` (allowed: ${allowed.join(', ')})`)
    }
  }
}

function asObject(raw: unknown, where: string): Record<string, unknown> {
  if (!isPlainObject(raw)) throw new Error(`${where} must be a mapping`)
  return raw
}

/** A document list, refused before a scalar can be iterated (python's `_list`). */
function asList(raw: unknown, where: string, expected = 'a list'): readonly unknown[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new Error(`${where} must be ${expected}`)
  return raw as readonly unknown[]
}

// An entry that names something must hold a token: a blank command
// pattern is a prefix of every line, so a stray "" would allow, ask about
// or deny every command, and a blank path entry is the root, so it would
// hide or deny the whole tree. `names` says what an entry names ("a
// command", "a path"); omitted, blank entries pass.
function stringList(raw: unknown, where: string, names?: string): readonly string[] {
  return asList(raw, where, 'a list of strings').map((entry, i) => {
    if (typeof entry !== 'string') throw new Error(`${where}[${String(i)}] must be a string`)
    if (names !== undefined && entry.trim() === '')
      throw new Error(`${where}[${String(i)}] must name ${names}`)
    return entry
  })
}

/**
 * Refuse a relative path entry. Every path in the document is absolute:
 * an entry is either an absolute path or a name pattern (`*.pem`, no
 * slash, matching a path component anywhere). A plain `xxx` or an
 * anchored `secrets/*` would otherwise be read from the root (`/xxx`,
 * `/secrets/*`), which is never what a relative spelling meant. There is
 * no relative spelling anywhere: a mount section spells its paths in
 * full and they are checked against the mount root (`requireUnderMount`),
 * which is what a rebase used to do silently and wrongly (`/repo/secret`
 * under `/repo` became `/repo/repo/secret`).
 */
function requireAbsolute(entries: readonly string[], where: string): void {
  entries.forEach((entry, i) => {
    if (entry.startsWith('/') || (isGlob(entry) && !entry.includes('/'))) return
    throw new Error(
      `${where}[${String(i)}] must be an absolute path or a name pattern: ` +
        `${JSON.stringify(entry)} is relative`,
    )
  })
}

/**
 * Refuse a path entry in a mount's section that leaves the mount. A
 * mount's rules are about that mount, so a path under `mounts./repo`
 * names something inside `/repo`. A name pattern carries no anchor and
 * is left alone; it means the same thing here as anywhere else.
 *
 * The root mount contains everything, and has to be spelled out:
 * `root + '/'` is `'//'` there, which no path starts with, so a
 * workspace mounted at `/` could write a section for its one mount and
 * then name nothing inside it.
 */
function requireUnderMount(entries: readonly string[], root: string, where: string): void {
  if (root === '/') return
  entries.forEach((entry, i) => {
    if (!entry.startsWith('/')) return
    if (entry === root || entry.startsWith(root + '/')) return
    throw new Error(
      `${where}[${String(i)}] is outside the mount it is written under: ` +
        `${JSON.stringify(entry)} is not below ${JSON.stringify(root)}`,
    )
  })
}

function normPrefix(prefix: string): string {
  return '/' + stripSlash(prefix)
}

/**
 * The rules of a `commands` mapping: each command on its own paths, one
 * rule per entry, so the document never states a command beside a path
 * it was not meant for (`{rm: ['/repo/*'], mv: ['/shared/*']}` scopes
 * `rm` to the repo and `mv` to the share, nothing else).
 */
function scopedRules(
  commands: Record<string, unknown>,
  reason: string,
  where: string,
): CommandRule[] {
  const entries = Object.entries(commands)
  if (entries.length === 0) throw new Error(`${where}.commands must name at least one command`)
  return entries.map(([pattern, paths]) => {
    if (pattern.trim() === '') throw new Error(`${where}.commands keys must name a command`)
    const entries = stringList(paths, `${where}.commands[${pattern}]`, 'a path')
    if (entries.length === 0) {
      throw new Error(`${where}.commands[${pattern}] must list at least one path`)
    }
    return { reason, commands: [pattern], paths: entries }
  })
}

/**
 * Coerce one `deny` or `ask` entry to its rules. A bare string is one
 * command pattern over the whole line, with the arm's default reason. A
 * mapping carries `reason` (defaulting) and exactly one of: `commands`
 * as a list, a whole-line rule on each pattern; `commands` as a mapping,
 * each command pattern on its own paths (one command to many paths, one
 * rule per command); `paths` alone, a path rule on every command. A list
 * of commands beside a list of paths is refused, because it does not say
 * which command the paths belong to, and a rule naming neither is
 * refused rather than read as "every command".
 */
function parseRule(raw: unknown, where: string, defaultReason: string): CommandRule[] {
  if (typeof raw === 'string') {
    return [
      { reason: defaultReason, commands: stringList([raw], `${where}.commands`, 'a command') },
    ]
  }
  if (!isPlainObject(raw)) throw new Error(`${where} must be a command pattern or a mapping`)
  rejectUnknownKeys(raw, RULE_FIELDS, where)
  const reason = raw.reason ?? defaultReason
  if (typeof reason !== 'string') throw new Error(`${where}.reason must be a string`)
  const { commands, paths } = raw
  if (isPlainObject(commands)) {
    if (paths !== undefined && paths !== null) {
      throw new Error(`${where} maps each command to its paths, so it takes no paths of its own`)
    }
    return scopedRules(commands, reason, where)
  }
  const hasCommands = commands !== undefined && commands !== null
  const hasPaths = paths !== undefined && paths !== null
  if (hasCommands && hasPaths) {
    throw new Error(`${where} lists commands beside paths; map each command to its paths instead`)
  }
  if (!hasCommands && !hasPaths) throw new Error(`${where} names no command and no path`)
  return [
    {
      reason,
      commands: stringList(commands, `${where}.commands`, 'a command'),
      paths: stringList(paths, `${where}.paths`, 'a path'),
    },
  ]
}

function parseRules(raw: unknown, where: string, arm: 'ask' | 'deny'): readonly CommandRule[] {
  const fallback = arm === 'ask' ? DEFAULT_ASK_REASON : DEFAULT_DENY_REASON
  return asList(raw, `${where}.${arm}`, 'a list of rules').flatMap((entry, i) =>
    parseRule(entry, `${where}.${arm}[${String(i)}]`, fallback),
  )
}

function parseAllow(raw: unknown, where: string): readonly string[] | null {
  if (raw === undefined || raw === null) return null
  return stringList(raw, `${where}.allow`, 'a command')
}

function parseHideGroup(entry: Record<string, unknown>, where: string): HideReason {
  rejectUnknownKeys(entry, ['patterns', 'reason'], where)
  const patterns = stringList(entry.patterns, `${where} patterns`, 'a path')
  if (patterns.length === 0) throw new Error(`${where} must list at least one pattern`)
  const reason = entry.reason
  if (typeof reason !== 'string' || reason.trim() === '')
    throw new Error(`${where} reason must be a non-empty string`)
  return { patterns, reason }
}

function parseShowEntries(raw: unknown, where: string): readonly ShowEntry[] {
  if (raw === undefined || raw === null) return []
  let pairs: [unknown, unknown][]
  if (Array.isArray(raw)) {
    pairs = raw.map((entry) => [entry, null])
  } else if (isPlainObject(raw)) {
    pairs = Object.entries(raw)
  } else {
    throw new Error(`${where} must be a mapping of path to mode or a list of paths`)
  }
  return pairs.map(([path, mode]) => {
    if (typeof path !== 'string' || path.trim() === '')
      throw new Error(`${where} entries must name a path`)
    if (!path.startsWith('/'))
      throw new Error(`${where} entries anchor to a place, so each is absolute: '${path}' is not`)
    let parsed: MountMode | null = null
    if (mode !== null && mode !== undefined) {
      if (typeof mode !== 'string') throw new Error(`${where} modes must be a mode name or alias`)
      parsed = parseMountMode(mode)
    }
    return { path, mode: parsed }
  })
}

/** Validate a `paths:` block. Every entry is absolute or a name pattern. */
export function parsePathsBlock(raw: unknown, where = 'paths'): PathsBlock {
  const obj = asObject(raw, where)
  rejectUnknownKeys(obj, PATHS_FIELDS, where)
  // Reason groups are a spelling of `hide`, so they are split out
  // before the flat list is read.
  const flat: unknown[] = []
  const reasons: HideReason[] = []
  for (const [i, entry] of asList(obj.hide, `${where}.hide`).entries()) {
    if (isPlainObject(entry)) {
      const group = parseHideGroup(entry, `${where}.hide[${String(i)}] group`)
      flat.push(...group.patterns)
      reasons.push(group)
    } else {
      flat.push(entry)
    }
  }
  for (const entry of asList(obj.reasons, `${where}.reasons`, 'a list of groups')) {
    if (!isPlainObject(entry))
      throw new Error(`${where}.reasons entries must be groups of patterns and a reason`)
    reasons.push(parseHideGroup(entry, `${where}.reasons group`))
  }
  const hide = stringList(flat, `${where}.hide`, 'a path')
  requireAbsolute(hide, `${where}.hide`)
  const show = parseShowEntries(obj.show, `${where}.show`)
  // An unsaid field stays absent, so a `{hide: [...]}` literal reads
  // equal to its parsed form.
  return {
    hide,
    ...(show.length > 0 ? { show } : {}),
    ...(reasons.length > 0 ? { reasons } : {}),
  }
}

export function parseVarsBlock(raw: unknown, where = 'vars'): VarsBlock {
  const obj = asObject(raw, where)
  rejectUnknownKeys(obj, VARS_FIELDS, where)
  return { hide: stringList(obj.hide, `${where}.hide`) }
}

export function parseCommandsBlock(raw: unknown, where = 'commands'): CommandsBlock {
  const obj = asObject(raw, where)
  rejectUnknownKeys(obj, COMMANDS_FIELDS, where)
  const ask = parseRules(obj.ask, where, 'ask')
  const deny = parseRules(obj.deny, where, 'deny')
  // This block is the profile's own, never a mount section's, so a rule's
  // paths are virtual paths: absolute, or name patterns.
  for (const rule of ask) requireAbsolute(rule.paths ?? [], `${where}.ask rule paths`)
  for (const rule of deny) requireAbsolute(rule.paths ?? [], `${where}.deny rule paths`)
  return { allow: parseAllow(obj.allow, where), ask, deny }
}

/** Validate a mount section's `commands:` block (`ask` and `deny` only). */
export function parseMountCommandsBlock(raw: unknown, where = 'commands'): MountCommandsBlock {
  const obj = asObject(raw, where)
  rejectUnknownKeys(obj, MOUNT_COMMANDS_FIELDS, where)
  return { ask: parseRules(obj.ask, where, 'ask'), deny: parseRules(obj.deny, where, 'deny') }
}

/** Validate one `mounts.<prefix>` section of a profile. */
export function parseProfileMount(raw: unknown, root: string, where: string): ProfileMount {
  // A bare mode string is sugar for the section that carries only a mode.
  const obj = typeof raw === 'string' ? { mode: raw } : asObject(raw, where)
  rejectUnknownKeys(obj, PROFILE_MOUNT_FIELDS, where)
  const out: { mode?: MountMode | null; commands?: MountCommandsBlock; paths?: PathsBlock } = {}
  if (obj.mode !== undefined && obj.mode !== null) {
    if (typeof obj.mode !== 'string') throw new Error(`${where}.mode must be a mode name or alias`)
    out.mode = parseMountMode(obj.mode)
  }
  if (obj.paths !== undefined && obj.paths !== null) {
    const paths = parsePathsBlock(obj.paths, `${where}.paths`)
    requireUnderMount(paths.hide, root, `${where}.paths.hide`)
    requireUnderMount(
      (paths.show ?? []).map((e) => e.path),
      root,
      `${where}.paths.show`,
    )
    out.paths = paths
  }
  if (obj.commands !== undefined && obj.commands !== null) {
    const commands = parseMountCommandsBlock(obj.commands, `${where}.commands`)
    for (const rule of commands.ask ?? [])
      requireUnderMount(rule.paths ?? [], root, `${where}.commands.ask`)
    for (const rule of commands.deny ?? [])
      requireUnderMount(rule.paths ?? [], root, `${where}.commands.deny`)
    out.commands = commands
  }
  return out
}

/**
 * Normalize a profile's `mounts` mapping: prefix to its settings, with a
 * bare mode string as sugar for a section carrying only a mode. A bare
 * list used to mean "only these mounts" and now means nothing at all,
 * so it fails loudly rather than quietly dropping the confinement it
 * used to carry.
 */
export function parseProfileMounts(
  raw: unknown,
  where = 'mounts',
): ReadonlyMap<string, ProfileMount> | null {
  if (raw === undefined || raw === null) return null
  let entries: [unknown, unknown][]
  if (raw instanceof Map) entries = [...raw.entries()]
  else if (isPlainObject(raw)) entries = Object.entries(raw)
  else throw new Error(`${where} must be a mapping of prefix to its settings`)
  const sections = new Map<string, ProfileMount>()
  for (const [prefix, entry] of entries) {
    if (typeof prefix !== 'string') throw new Error(`${where} keys must be strings`)
    const root = normPrefix(prefix)
    sections.set(root, parseProfileMount(entry, root, `${where}[${root}]`))
  }
  return sections
}

/** Validate one profile (a `profiles.<name>` block, or an inline document). */
/**
 * Validate a profile's `policy` block: the program and the engine that
 * runs it, both required. A block, not a path: with no default engine
 * a path alone would name a program nothing could run.
 */
export function parseProfilePolicy(raw: unknown, where: string): ProfilePolicySpec {
  if (typeof raw === 'string' || raw instanceof ScriptSource) {
    throw new Error(
      `${where} names the program and the engine that runs it: ` +
        `{script: <file>, runtime: <engine>}`,
    )
  }
  const obj = asObject(raw, where)
  rejectUnknownKeys(obj, POLICY_FIELDS, where)
  if (obj.script === undefined || obj.script === null) {
    throw new Error(`${where}.script names the policy's program, and is required`)
  }
  if (!(obj.script instanceof ScriptSource) && typeof obj.script !== 'string') {
    throw new Error(`${where}.script must be a script path or source`)
  }
  if (obj.runtime === undefined || obj.runtime === null) {
    throw new Error(`${where}.runtime names the engine the policy runs on, and is required`)
  }
  if (typeof obj.runtime !== 'string') throw new Error(`${where}.runtime must be a string`)
  return { script: obj.script, runtime: obj.runtime }
}

/** Validate one profile (a `profiles.<name>` block, or an inline document). */
export function parseSessionProfile(raw: unknown, where = 'profile'): SessionProfile {
  const obj = asObject(raw, where)
  // The keys this was first shipped under, a `script` named for what
  // the file is rather than what it does and a `runtime` beside it
  // that read as the profile's own; refused with the new spelling
  // rather than as two more unknown keys.
  if (obj.script !== undefined || obj.runtime !== undefined) {
    throw new Error(
      `${where}: script and runtime are now one policy block, ` +
        `policy: {script: <file>, runtime: <engine>}; its program defines ` +
        `pre_command(ctx) and answers with return`,
    )
  }
  rejectUnknownKeys(obj, PROFILE_FIELDS, where)
  const out: {
    cwd?: string | null
    env?: Readonly<Record<string, string>> | null
    mounts?: ReadonlyMap<string, ProfileMount> | null
    paths?: PathsBlock | null
    vars?: VarsBlock | null
    commands?: CommandsBlock | null
    policy?: ProfilePolicySpec | null
  } = {}
  if (obj.policy !== undefined && obj.policy !== null) {
    out.policy = parseProfilePolicy(obj.policy, `${where}.policy`)
  }
  if (obj.cwd !== undefined && obj.cwd !== null) {
    if (typeof obj.cwd !== 'string') throw new Error(`${where}.cwd must be a string`)
    out.cwd = obj.cwd
  }
  if (obj.env !== undefined && obj.env !== null) {
    const env = asObject(obj.env, `${where}.env`)
    for (const [k, v] of Object.entries(env)) {
      if (typeof v !== 'string') throw new Error(`${where}.env.${k} must be a string`)
    }
    out.env = env as Record<string, string>
  }
  if (obj.mounts !== undefined && obj.mounts !== null) {
    out.mounts = parseProfileMounts(obj.mounts, `${where}.mounts`)
  }
  if (obj.paths !== undefined && obj.paths !== null)
    out.paths = parsePathsBlock(obj.paths, `${where}.paths`)
  if (obj.vars !== undefined && obj.vars !== null)
    out.vars = parseVarsBlock(obj.vars, `${where}.vars`)
  if (obj.commands !== undefined && obj.commands !== null)
    out.commands = parseCommandsBlock(obj.commands, `${where}.commands`)
  return out
}
