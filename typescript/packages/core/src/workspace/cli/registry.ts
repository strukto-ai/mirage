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
import { JOB_BUILTINS, NAMESPACE_COMMANDS, SHELL_NAMES } from '../route/constants.ts'
import { z } from 'zod'

import type { CLIInstall } from './types.ts'

/**
 * Installed CLIs, keyed by head word.
 *
 * Fully separate from the mount registry: a CLI exists because it was
 * installed (YAML `clis:` section or registerCli), never because
 * storage was mounted. Install is fail-loud: a bad name, a colliding
 * name, or a config the spec's configModel rejects throws at install
 * time, so a workspace that loads has only valid entries.
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
    if (spec.configModel === null) {
      if (config !== null && Object.keys(config).length > 0) {
        throw new Error(`CLI '${name}': config given but '${spec.name}' declares no configModel`)
      }
      return null
    }
    const model = spec.configModel
    if (model instanceof z.ZodObject) {
      // Unknown keys fail loud (a typo'd YAML key must not be silently
      // ignored), mirroring the Python pydantic arm.
      const unknown = Object.keys(config ?? {}).filter((k) => !(k in model.shape))
      if (unknown.length > 0) {
        throw new Error(`CLI '${name}': unknown config keys: ${unknown.sort().join(', ')}`)
      }
      return model.parse(config ?? {})
    }
    return model(config ?? {})
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
