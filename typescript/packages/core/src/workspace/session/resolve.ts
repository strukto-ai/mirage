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

import {
  DEFAULT_PROCESS_PERMISSIONS,
  parseProcessPermissions,
  restrictProcesses,
} from '../../process/config.ts'
import { checkRules } from './validate.ts'
import { PolicyError } from '../../policy/errors.ts'
import type {
  AdmissionRules,
  ProfileScript,
  ProfileScripts,
  ScriptMethod,
} from '../../policy/types.ts'
import type { MountMode } from '../../types.ts'
import { DEFAULT_VISIBILITY, weakerMode } from '../../types.ts'
import { compilePolicy, restrictPolicy } from '../../rs/policy.ts'
import { compileProgram, type CompiledProfile, type SessionProfile } from '../../policy/profile.ts'
import { DEFAULT_PROFILE } from './constants.ts'
import { varsFromEntries, type SessionState } from './session.ts'
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

function restrictMatching(
  base: SessionProfile | null,
  inline: SessionProfile | null,
): ReturnType<typeof restrictPolicy> {
  try {
    return restrictPolicy(base, inline)
  } catch (error) {
    throw new PolicyError(error instanceof Error ? error.message : String(error))
  }
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
  const restriction = restrictMatching(base, inline)
  if (inline.commandLimits != null)
    throw new PolicyError('command_limits belong on the profile, not inline permissions')
  if (inline.policy !== undefined && inline.policy !== null) {
    throw new PolicyError(
      'inline permissions may add ask and deny rules, not a policy; state one on the profile',
    )
  }
  const own =
    base?.processes == null ? DEFAULT_PROCESS_PERMISSIONS : parseProcessPermissions(base.processes)
  const processes =
    inline.processes == null
      ? own
      : restrictProcesses(own, parseProcessPermissions(inline.processes))
  if (base === null) return inline.processes == null ? inline : { ...inline, processes }
  return {
    ...restriction,
    commandLimits: base.commandLimits ?? null,
    processes,
    cwd: inline.cwd ?? base.cwd ?? null,
    ...(base.env != null || inline.env != null ? { env: { ...base.env, ...inline.env } } : {}),
    ...(base.policy != null ? { policy: base.policy } : {}),
  }
}

export function compileCommands(profile: SessionProfile): AdmissionRules | null {
  return compilePolicy(profile).commands
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

/** The session fields a profile compiles to. */
export function compileProfile(effective: SessionProfile | null, name = ''): CompiledProfile {
  const profile = name === '' ? null : name
  if (effective === null) {
    return {
      setup: { env: null, cwd: null },
      visibility: DEFAULT_VISIBILITY,
      policies: {
        mountModes: null,
        commands: null,
        scripts: {},
        commandLimits: null,
        processes: DEFAULT_PROCESS_PERMISSIONS,
      },
      hideReasons: [],
      profile,
    }
  }
  const plan = compilePolicy(effective)
  const commands = plan.commands
  checkRules(commands)
  const processes =
    effective.processes == null
      ? DEFAULT_PROCESS_PERMISSIONS
      : parseProcessPermissions(effective.processes)
  return {
    setup: { env: effective.env ?? null, cwd: effective.cwd ?? null },
    visibility: {
      ...plan.visibility,
      processes: processes.list,
    },
    policies: {
      mountModes: plan.mountModes,
      commands,
      scripts: compileScripts(effective, name),
      commandLimits: effective.commandLimits ?? null,
      processes,
    },
    hideReasons: plan.hideReasons,
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
  if (compiled.setup.env != null) Object.assign(session.vars, varsFromEntries(compiled.setup.env))
  if (compiled.setup.cwd !== null) setCwd(session, compiled.setup.cwd)
}
