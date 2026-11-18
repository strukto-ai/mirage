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

import { PolicyError } from '../../policy/errors.ts'
import { unreadNames } from '../../policy/match/grammar.ts'
import {
  compileProgram,
  type CompiledProfile,
  type PathsBlock,
  type ProfileMount,
  type SessionProfile,
} from '../../policy/profile.ts'
import type {
  AdmissionRules,
  Grammar,
  HideReason,
  ProfileScript,
  ProfileScripts,
  ScopedTree,
  ScriptMethod,
} from '../../policy/types.ts'
import {
  layerProcesses,
  restrictProcesses,
  type ProcessesBlock,
} from '../../execution/process/config.ts'
import { fromUnits, units } from '../../rs/document.ts'
import { StreamRefusal } from '../../rs/errors.ts'
import { admissionMatcher, visibilityFrom, type Wire } from '../../rs/policy.ts'
import type { MountMode } from '../../types.ts'
import { DEFAULT_VISIBILITY, weakerMode } from '../../types.ts'
import { DEFAULT_PROFILE } from './constants.ts'
import { varsFromEntries, type SessionState } from './session.ts'
import { setCwd } from './shell_dirs.ts'
import { normalizeTree } from './validate.ts'

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

interface ReasonReply {
  readonly patterns: number[][]
  readonly reason: number[]
}
interface PathsReply {
  readonly hide: number[][]
  readonly show: readonly { readonly path: number[]; readonly mode: MountMode | null }[]
  readonly reasons: readonly ReasonReply[]
}
interface ProfileReply {
  readonly paths: PathsReply | null
  readonly vars: number[][] | null
  readonly mounts:
    | readonly {
        readonly prefix: number[]
        readonly mode: MountMode | null
        readonly paths: PathsReply | null
      }[]
    | null
}
interface PlanReply {
  readonly visibility: Parameters<typeof visibilityFrom>[0]
  readonly mount_modes: readonly [number[], MountMode][]
  readonly hide_reasons: readonly ReasonReply[]
}
type ProfileFields = Pick<SessionProfile, 'paths' | 'vars' | 'mounts'>

function pathsWire(block: PathsBlock | null | undefined): Wire | null {
  if (block == null) return null
  return {
    hide: block.hide.map(units),
    show: (block.show ?? []).map((entry) => ({ path: units(entry.path), mode: entry.mode })),
    reasons: (block.reasons ?? []).map((group) => ({
      patterns: group.patterns.map(units),
      reason: units(group.reason),
    })),
  }
}

function profileWire(profile: SessionProfile): Wire {
  return {
    paths: pathsWire(profile.paths),
    vars: profile.vars == null ? null : profile.vars.hide.map(units),
    mounts:
      profile.mounts == null
        ? null
        : [...profile.mounts].map(([prefix, entry]) => ({
            prefix: units(prefix),
            mode: entry.mode ?? null,
            paths: pathsWire(entry.paths),
          })),
  }
}

function reasonFrom(value: ReasonReply): HideReason {
  return { patterns: value.patterns.map(fromUnits), reason: fromUnits(value.reason) }
}

function pathsFrom(value: PathsReply | null): PathsBlock | null {
  if (value === null) return null
  const show = value.show.map((entry) => ({ path: fromUnits(entry.path), mode: entry.mode }))
  const reasons = value.reasons.map(reasonFrom)
  return {
    hide: value.hide.map(fromUnits),
    ...(show.length === 0 ? {} : { show }),
    ...(reasons.length === 0 ? {} : { reasons }),
  }
}

function profileFields(value: ProfileReply, base: SessionProfile | null): ProfileFields {
  return {
    paths: pathsFrom(value.paths),
    vars: value.vars === null ? null : { hide: value.vars.map(fromUnits) },
    mounts:
      value.mounts === null
        ? null
        : new Map(
            value.mounts.map((mount): [string, ProfileMount] => {
              const prefix = fromUnits(mount.prefix)
              const commands = base?.mounts?.get(prefix)?.commands ?? null
              const paths = pathsFrom(mount.paths)
              return [
                prefix,
                {
                  ...(mount.mode === null ? {} : { mode: mount.mode }),
                  ...(commands === null ? {} : { commands }),
                  ...(paths === null ? {} : { paths }),
                },
              ]
            }),
          ),
  }
}

function restrictMatching(
  base: SessionProfile | null,
  inline: SessionProfile | null,
): ProfileFields | null {
  let value: ProfileReply | null
  try {
    value = admissionMatcher(null).ask('restrict', {
      base: base === null ? null : profileWire(base),
      inline: inline === null ? null : profileWire(inline),
    }) as ProfileReply | null
  } catch (error) {
    if (error instanceof StreamRefusal) throw new PolicyError(error.message)
    throw error
  }
  return value === null ? null : profileFields(value, base)
}

function compilePlan(profile: SessionProfile): PlanReply {
  return admissionMatcher(null).ask('compile', { profile: profileWire(profile) }) as PlanReply
}

/**
 * A profile with the inline document of one `createSession` added.
 *
 * The one rule about combining two documents: an inline document may
 * add command trees and hides, never a show entry and never a script,
 * and that holds even when there is no profile to add to. Modes take the
 * weaker of the two, `cwd` and `env` are the inline document's when it
 * states them (they are session presets, not permissions). Either side
 * null returns the other unchanged; the profile's policy survives the
 * merge, since the inline document can only add rules beside it. An
 * inline `processes` narrows the profile's over the workspace's
 * (`workspaceProcesses`).
 *
 * The result carries the base's command trees only. A tree cannot absorb
 * another without changing what it means, so the inline document's trees
 * are judged beside the base's (`commandRules` reads both documents).
 */
export function withInline(
  base: SessionProfile | null,
  inline: SessionProfile | null,
  workspaceProcesses: ProcessesBlock | null = null,
): SessionProfile | null {
  if (inline === null) return base
  const restriction = restrictMatching(base, inline)
  if (inline.commandLimits != null)
    throw new PolicyError('command_limits belong on the profile, not inline permissions')
  if (inline.network != null)
    throw new PolicyError('network belongs on the profile, not inline permissions')
  if (inline.policy !== undefined && inline.policy !== null) {
    throw new PolicyError(
      'inline permissions may add command rules and hides, not a policy; state one on the profile',
    )
  }
  const processes =
    inline.processes == null
      ? (base?.processes ?? null)
      : restrictProcesses(layerProcesses([base?.processes, workspaceProcesses]), inline.processes)
  if (base === null) return inline.processes == null ? inline : { ...inline, processes }
  return {
    ...restriction,
    ...(base.commands != null ? { commands: base.commands } : {}),
    commandLimits: base.commandLimits ?? null,
    processes,
    network: base.network ?? null,
    cwd: inline.cwd ?? base.cwd ?? null,
    ...(base.env != null || inline.env != null ? { env: { ...base.env, ...inline.env } } : {}),
    ...(base.policy != null ? { policy: base.policy } : {}),
  }
}

/**
 * The profile's policy programs by method, compiled onto the session.
 * `name` is the profile's name, empty for a document passed without one;
 * what a program reads as `ctx.profile`.
 *
 * @throws PolicyError - a program is still a path, which means it
 * reached the workspace without passing the config loader that loads one.
 */
export function compileScripts(effective: SessionProfile, name: string): ProfileScripts {
  const compiled: Partial<Record<ScriptMethod, readonly ProfileScript[]>> = {}
  for (const [method, programs] of Object.entries(effective.policy ?? {})) {
    const entries = programs.map((program): ProfileScript => {
      try {
        return compileProgram(program, name)
      } catch (err) {
        throw new PolicyError(
          `profile '${name}' ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    })
    if (entries.length > 0) compiled[method as ScriptMethod] = entries
  }
  return compiled
}

/**
 * A session's command trees: each document's top-level tree and each of
 * its mounts' trees, every name checked against its command's grammar
 * and held by its canonical name. null when no document states a tree.
 * `defer` keeps a command with no grammar as written, for a check made
 * before every CLI is registered. Throws `PolicyError` when a name does
 * not fit its command's grammar. Mirrors Python's `command_rules`.
 */
export function commandRules(
  base: SessionProfile | null,
  inline: SessionProfile | null,
  grammars: ReadonlyMap<string, Grammar>,
  defer = false,
): AdmissionRules | null {
  const trees: ScopedTree[] = []
  for (const [doc, stated] of [
    [base, false],
    [inline, true],
  ] as const) {
    if (doc === null) continue
    if (doc.commands != null)
      trees.push({
        tree: normalizeTree(doc.commands, grammars, 'commands', defer),
        mount: '',
        inline: stated,
      })
    for (const [prefix, entry] of doc.mounts ?? []) {
      if (entry.commands == null) continue
      const where = `mounts[${prefix}].commands`
      trees.push({
        tree: normalizeTree(entry.commands, grammars, where, defer),
        mount: prefix,
        inline: stated,
      })
    }
  }
  return trees.length > 0 ? { trees, unread: unreadNames(trees, grammars) } : null
}

/**
 * The session fields a profile compiles to; its `processes` over the
 * workspace's (`workspaceProcesses`), field by field. `name` is the
 * profile's name, empty for a document passed without one, null for no
 * profile at all; carried onto its programs for `ctx.profile` and onto the
 * session as the user it runs as. `commands` are the session's command
 * trees, read off the profile and the inline document (`commandRules`).
 */
export function compileProfile(
  effective: SessionProfile | null,
  name: string | null = null,
  workspaceProcesses: ProcessesBlock | null = null,
  commands: AdmissionRules | null = null,
): CompiledProfile {
  const profile = name
  const processes = Object.freeze(layerProcesses([effective?.processes, workspaceProcesses]))
  if (effective === null) {
    return {
      setup: { env: null, cwd: null },
      visibility: DEFAULT_VISIBILITY,
      policies: {
        mountModes: null,
        commands: null,
        scripts: {},
        commandLimits: null,
        processes,
        network: null,
      },
      hideReasons: [],
      profile,
    }
  }
  const plan = compilePlan(effective)
  return {
    setup: { env: effective.env ?? null, cwd: effective.cwd ?? null },
    visibility: visibilityFrom(plan.visibility, processes.list),
    policies: {
      mountModes:
        plan.mount_modes.length === 0
          ? null
          : new Map(plan.mount_modes.map(([prefix, mode]) => [fromUnits(prefix), mode])),
      commands,
      scripts: compileScripts(effective, name ?? ''),
      commandLimits: effective.commandLimits ?? null,
      processes,
      network: effective.network ?? null,
    },
    hideReasons: plan.hide_reasons.map(reasonFrom),
    profile,
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
export function narrow(session: SessionState, compiled: CompiledProfile): void {
  const policies = compiled.policies
  session.mountModes = policies.mountModes === null ? null : new Map(policies.mountModes)
  session.visibility = compiled.visibility
  session.hideReasons = compiled.hideReasons
  session.commands = policies.commands
  session.scripts = policies.scripts
  session.profile = compiled.profile
  session.commandLimits = { ...policies.commandLimits }
  session.processes = policies.processes
  session.network = policies.network
}

/**
 * The narrowing a session holds, as the compiled profile `narrow` stamps
 * back unchanged: how a recorded session's restrictions land on another,
 * the inline document and every later profile change kept. Mirrors
 * Python `narrowing_of`.
 */
export function narrowingOf(session: SessionState): CompiledProfile {
  return {
    setup: { env: null, cwd: null },
    visibility: session.visibility,
    policies: {
      mountModes: session.mountModes,
      commands: session.commands,
      scripts: session.scripts,
      commandLimits: session.commandLimits,
      processes: session.processes,
      network: session.network,
    },
    hideReasons: session.hideReasons,
    profile: session.profile,
  }
}

/**
 * Two sets of per-mount caps held at once: every prefix either one caps,
 * at the weaker mode, so the result is never wider than either. Mirrors
 * Python `stricter_modes`.
 */
export function stricterModes(
  a: ReadonlyMap<string, MountMode> | null,
  b: ReadonlyMap<string, MountMode> | null,
): ReadonlyMap<string, MountMode> | null {
  if (a === null || b === null) {
    const caps = a ?? b
    return caps === null ? null : new Map(caps)
  }
  const out = new Map(a)
  for (const [prefix, mode] of b) {
    const held = out.get(prefix)
    out.set(prefix, held === undefined ? mode : weakerMode(held, mode))
  }
  return out
}

/**
 * Narrow a fresh session and seed its scratch state from the profile.
 * A profile's env speaks the workspace `env` block's grammar, so a bare
 * string is exported: seeding it plain left `$TOKEN` expanding while
 * every command, CLI and guest runtime in the profiled session saw
 * nothing, since all three read `envSnapshot` and that is the exported
 * set. A managed entry lands as its pointer, fetched when a line names
 * it. The cwd is where the session starts; both are the agent's to
 * change afterwards, which is why hydration keeps the stored ones and
 * re-stamps only `narrow`.
 */
export function applyProfile(session: SessionState, compiled: CompiledProfile): void {
  narrow(session, compiled)
  if (compiled.setup.env != null) {
    for (const [name, v] of Object.entries(varsFromEntries(compiled.setup.env))) {
      session.vars.set(name, v)
    }
  }
  if (compiled.setup.cwd !== null) setCwd(session, compiled.setup.cwd)
}
