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

import type { Accessor } from '../../accessor/base.ts'
import type { CLI } from '../../commands/cli/types.ts'
import { BUILTIN_SPECS } from '../../commands/spec/builtins.ts'
import { errorSummary } from '../../secrets/summary.ts'
import { snakeToCamel } from '../../utils/normalize.ts'
import { JOB_BUILTINS, KEYWORDS, NAMESPACE_COMMANDS, SHELL_NAMES } from '../lookup/constants.ts'
import { z } from 'zod'

import { ABORT_JOIN_MS, abortable } from '../../utils/abort.ts'
import { Activity } from '../../utils/activity.ts'
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
  private readonly retiring = new Map<CLIInstall, Promise<void>>()
  private shutdown = new AbortController()

  /** @param peers the mounts' accessors, which an install may share an account with. */
  constructor(private readonly peers: () => readonly Accessor[] = () => []) {}

  /**
   * Install a CLI under a head word. The name must be a single word and
   * must not collide with another installed CLI, a shell builtin, or a
   * general command (a runtime capture of the same name is fine: the
   * policy steers per line).
   */
  install(name: string, spec: CLI, config: Record<string, unknown> | null = null): CLIInstall {
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
    const validated = this.validateConfig(name, spec, config)
    const accessor = spec.accessor(validated)
    accessor.join?.([...this.peers(), ...[...this.installs.values()].map((i) => i.accessor)])
    const install: CLIInstall = {
      name,
      cli: spec,
      config: validated,
      accessor,
      activity: new Activity(),
    }
    this.installs.set(name, install)
    return install
  }

  private validateConfig(name: string, spec: CLI, config: Record<string, unknown> | null): unknown {
    // A config that is not an object is refused by type, rather than having
    // its entries read as unknown keys. One the schema already parsed is
    // still an object with the schema's own keys, so it installs as given,
    // which is what the python arm does with an instance of its model.
    if (config !== null && (typeof config !== 'object' || Array.isArray(config))) {
      const kind = Array.isArray(config) ? 'array' : typeof config
      throw new Error(`CLI '${name}': config must be an object, got ${kind}`)
    }
    if (spec.script !== null) {
      // A script spec has no configModel: the mapping passes through
      // as-is for the program to consume.
      return config !== null && Object.keys(config).length > 0 ? { ...config } : null
    }
    if (spec.configModel === null) {
      if (config !== null && Object.keys(config).length > 0) {
        throw new Error(
          `CLI '${name}': config given but '${spec.spec.name}' declares no configModel`,
        )
      }
      return null
    }
    const model = spec.configModel
    if (model instanceof z.ZodObject) {
      // The same snake_case YAML config block serves Python and TS alike
      // (the VFS registries already promise this), and the pydantic
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

  /**
   * Remove an installed CLI now and close its accessor once the lines running
   * on it and their output streams are done; its head word stops resolving
   * (127) at once.
   */
  async uninstall(name: string): Promise<void> {
    const install = this.installs.get(name)
    if (install === undefined) {
      throw new Error(`CLI name '${name}' is not installed`)
    }
    this.installs.delete(name)
    await this.track(install, retire(install, this.shutdown.signal))
  }

  /**
   * Close every install's accessor, including the ones still being removed,
   * as the workspace closes; one failed close does not skip the rest.
   *
   * The workspace aborts its lines before this runs, so a leaf still on an
   * install is unwinding (or ignoring its abort): it gets `ABORT_JOIN_MS` to
   * settle before its accessor goes, rather than meeting a closed client
   * mid-request, and no longer, so one that never settles cannot hold the
   * workspace open. Each close is tracked, as a removal is, so a second close
   * waits for the clients the first is still closing.
   */
  async close(): Promise<void> {
    const shutdown = this.shutdown
    this.shutdown = new AbortController()
    shutdown.abort()
    const installs = [...this.installs.values()]
    this.installs.clear()
    for (const install of installs) void this.track(install, closeAfterGrace(install))
    const results = await Promise.allSettled([...this.retiring.values()])
    const failures = results.flatMap((r) => (r.status === 'rejected' ? [r.reason as unknown] : []))
    if (failures.length > 0)
      throw failures.length === 1 ? failures[0] : new AggregateError(failures, 'CLI close failed')
  }

  /** Keep `closing` in `retiring` until it settles, so `close` waits for it. */
  private track(install: CLIInstall, closing: Promise<void>): Promise<void> {
    const tracked = closing.finally(() => {
      this.retiring.delete(install)
    })
    this.retiring.set(install, tracked)
    return tracked
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

async function retire(install: CLIInstall, shutdown: AbortSignal): Promise<void> {
  try {
    await abortable(install.activity.wait(), shutdown)
  } catch (error) {
    if (!shutdown.aborted) throw error
    await closeAfterGrace(install)
    return
  }
  await install.accessor.close?.()
}

async function closeAfterGrace(install: CLIInstall): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      install.activity.wait(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ABORT_JOIN_MS)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
  await install.accessor.close?.()
}
