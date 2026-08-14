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

import { coerceRuntimeConfig, type RuntimeConfig } from './config.ts'
import { ScriptSource, type PolicyScript } from './policy/types.ts'
import type { RuntimeOptions } from './types.ts'

/**
 * An engine the workspace can route commands or whole lines to.
 *
 * A runtime is to its commands what the regex engine is to grep: the
 * machinery inside a handler, invisible to the dispatcher. Each runtime
 * declares the command names it captures; a command binds to the first
 * runtime in the workspace's ordered list that captures it.
 * Implementations own their engine lifecycle (lazy boot, reuse across
 * runs, teardown in close).
 *
 * The base holds only what every tier shares: the registry name, the
 * captured command names, the coerced config, and the per-line
 * admission script. What a runtime can DO is declared by its tier and
 * mixins, detected by type and never by probing: LanguageRuntime
 * interprets one command's code (run), LineExecutor takes whole lines
 * (runLine), Evaluator evaluates expressions (eval).
 *
 * Every runtime is constructed the same way (captures, config,
 * script); each subclass hands the base its class-default captures and
 * its config key list, so a config field the runtime does not have
 * fails loud (config_cls in Python).
 */
export abstract class Runtime {
  abstract readonly name: string
  readonly captures: readonly string[]
  /**
   * Whether every effect of code this runtime executes lands inside the
   * workspace. The bridged engines (monty, pyodide, quickjs) and the vfs
   * routing marker declare true: their I/O rides the VFS bridge or the
   * workspace executor itself. False by default and for anything that
   * executes elsewhere — the host `local` python, a RemoteSandbox — so a
   * custom runtime must declare confinement rather than inherit it.
   */
  readonly confined: boolean = false
  /** The runtime's coerced implementation knobs. */
  config: RuntimeConfig
  script?: PolicyScript

  constructor(
    options: RuntimeOptions<RuntimeConfig> = {},
    defaultCaptures: readonly string[] = [],
    configKeys: readonly string[] = [],
  ) {
    if (typeof options.script === 'string') throw scriptStringError()
    this.captures =
      options.captures !== undefined ? options.captures.slice() : defaultCaptures.slice()
    this.config = coerceRuntimeConfig(options.config, configKeys)
    if (typeof options.script === 'function' || options.script instanceof ScriptSource) {
      this.script = options.script
    }
  }

  /** Release engine resources. Default: nothing held. */
  close(): Promise<void> {
    return Promise.resolve()
  }
}

/** A workspace runtimes-list entry: an instance or a name shorthand. */
export type RuntimeEntry = Runtime | string

/** The code API takes functions; script source belongs to config. */
export function scriptStringError(kind = 'a script'): Error {
  return new Error(
    `${kind} in code must be a function taking the PolicyContext; config ` +
      `scripts reference a .py file (script:/policy: in the workspace yaml)`,
  )
}
