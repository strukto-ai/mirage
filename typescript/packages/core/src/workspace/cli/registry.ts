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

import type { CLISpec } from '../../commands/cli/types.ts'
import { BUILTIN_SPECS } from '../../commands/spec/builtins.ts'
import { errorSummary } from '../../secrets/summary.ts'
import { snakeToCamel } from '../../utils/normalize.ts'
import { JOB_BUILTINS, KEYWORDS, NAMESPACE_COMMANDS, SHELL_NAMES } from '../lookup/constants.ts'
import { z } from 'zod'

import type { CLIInstall } from './types.ts'
import { compareCodePoints } from '../../utils/sort.ts'

/**
 * Installed CLIs, keyed by head word.
 *
 * Fully separate from the mount registry: a CLI exists because it was
 * installed (YAML `clis:` section or registerCli), never because
 * storage was mounted. Install is fail-loud: a bad name, a colliding
 * name, or a config the spec's configModel rejects throws at install
 * time, so a workspace that loads has only valid entries.
 *
 * The lifecycle is host-side only, and must stay that way: install and
 * uninstall are called by the program embedding mirage, never by a line
 * the agent types, so an agent cannot take away the tools it was given.
 * Do not add an `install`/`uninstall` shell builtin. What an agent can
 * do is shadow a head word with a shell function, which is bash's own
 * rule, reversible with `unset -f`, bypassable with `command <name>`,
 * and visible through `type -a`. Pinning a head word against that
 * belongs in the policy layer's `preCommand`, since it is a
 * per-deployment call rather than a property of the registry.
 */
export class CLIRegistry {
  private readonly installs = new Map<string, CLIInstall>()

  /**
   * Install a CLI under a head word. The name must be a single word and
   * must not collide with another installed CLI, a shell builtin, or a
   * general command (a runtime capture of the same name is fine: the
   * policy steers per line).
   */
  install(name: string, spec: CLISpec, config: Record<string, unknown> | null = null): CLIInstall {
    if (name === '' || /\s/.test(name)) {
      throw new Error(`CLI name '${name}' must be a single word`)
    }
    if (this.installs.has(name)) {
      throw new Error(`CLI name '${name}' is already installed`)
    }
    if (SHELL_NAMES.has(name) || JOB_BUILTINS.has(name)) {
      throw new Error(`CLI name '${name}' collides with a shell builtin`)
    }
    // A reserved word never reaches dispatch (the parser consumes it), so
    // an install under one would be unreachable rather than wrong.
    if (KEYWORDS.has(name)) {
      throw new Error(`CLI name '${name}' is a shell keyword`)
    }
    if (NAMESPACE_COMMANDS.has(name) || name in BUILTIN_SPECS) {
      throw new Error(`CLI name '${name}' collides with a general command`)
    }
    const install: CLIInstall = {
      name,
      spec,
      config: this.validateConfig(name, spec, config),
    }
    this.installs.set(name, install)
    return install
  }

  private validateConfig(
    name: string,
    spec: CLISpec,
    config: Record<string, unknown> | null,
  ): unknown {
    if (spec.script !== null) {
      // A script spec has no configModel: the mapping passes through
      // as-is for the program to consume.
      return config !== null && Object.keys(config).length > 0 ? { ...config } : null
    }
    if (spec.configModel === null) {
      if (config !== null && Object.keys(config).length > 0) {
        throw new Error(`CLI '${name}': config given but '${spec.name}' declares no configModel`)
      }
      return null
    }
    const model = spec.configModel
    if (model instanceof z.ZodObject) {
      // The same snake_case YAML config block serves Python and TS alike
      // (the resource registries already promise this), and the pydantic
      // arm is snake_case-native, so a key that camelizes onto a declared
      // field is delivered there. Keys that resolve to no field keep the
      // caller's spelling: an unknown key is then reported as typed, and
      // a loose schema's passthrough data stays verbatim like pydantic
      // extra="allow". hasOwn, not `in`: the shape is a plain object, so
      // `in` would read 'constructor'/'toString' off Object.prototype as
      // declared fields, and fromEntries keeps a '__proto__' key an own
      // property instead of silently reassigning the prototype.
      const pairs: [string, unknown][] = []
      const taken = new Set<string>()
      for (const [key, value] of Object.entries(config ?? {})) {
        const camel = snakeToCamel(key)
        const target = Object.hasOwn(model.shape, camel) ? camel : key
        // Both spellings of one field is ambiguous, and pydantic already
        // rejects it (the camelCase one is an unknown key there), so the
        // zod arm must not silently keep whichever came last.
        if (taken.has(target)) {
          throw new Error(`CLI '${name}': config key '${key}' duplicates field '${target}'`)
        }
        taken.add(target)
        pairs.push([target, value])
      }
      const norm = Object.fromEntries(pairs)
      // Unknown keys fail loud (a typo'd YAML key must not be silently
      // ignored), mirroring the Python pydantic arm; a schema that
      // declares its own extra-key policy (strict/passthrough/catchall)
      // enforces it through parse instead, like pydantic extra="allow".
      if (model.def.catchall === undefined) {
        const unknown = [...taken].filter((k) => !Object.hasOwn(model.shape, k))
        if (unknown.length > 0) {
          throw new Error(
            `CLI '${name}': unknown config keys: ${unknown.sort(compareCodePoints).join(', ')}`,
          )
        }
      }
      try {
        return model.parse(norm)
      } catch (err) {
        // An account CLI's config is where a fetched credential lands, the
        // same as a mount's: field and code only, never zod's rendering of
        // the refused value. Mirrors the python registry's `error_summary`.
        if (err instanceof z.ZodError) throw new Error(`CLI '${name}': ${errorSummary(err)}`)
        throw err
      }
    }
    const result = model(config ?? {})
    // The snapshot stores the normalized config and replays it through
    // the normalizer, so the output must be a JSON-shaped mapping (or
    // null), matching the Python side's model-instance contract.
    if (result !== null && (typeof result !== 'object' || Array.isArray(result))) {
      throw new Error(`CLI '${name}': configModel must return an object or null`)
    }
    return result
  }

  /** Remove an installed CLI; its head word stops resolving (127). */
  uninstall(name: string): void {
    if (!this.installs.has(name)) {
      throw new Error(`CLI name '${name}' is not installed`)
    }
    this.installs.delete(name)
  }

  /** Look up an installation by head word. */
  get(name: string): CLIInstall | null {
    return this.installs.get(name) ?? null
  }

  /** Snapshot of the installed CLIs keyed by head word. */
  items(): Map<string, CLIInstall> {
    return new Map(this.installs)
  }

  /** The installed head words. */
  names(): ReadonlySet<string> {
    return new Set(this.installs.keys())
  }
}
