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

import { PYTHON_ONLY_HINTS, VfsRuntime, type Runtime } from './runtime.ts'
import type { RuntimeOptions } from './runtime_types.ts'
import { MontyRuntime } from './python/runtimes/monty.ts'
import { PyodideRuntime } from './python/runtimes/pyodide.ts'
import { QuickJsRuntime } from './js/quickjs.ts'

// One source of truth, preference order. The command -> runtime mapping
// is derived from each class's captures, never hand-maintained.
export const RUNTIMES = [PyodideRuntime, MontyRuntime, QuickJsRuntime] as const

// Null prototype: runtime names come from config, and a name like
// `constructor` must miss instead of resolving an `Object.prototype`
// member as a runtime class.
const NAMED: Record<string, new (options?: RuntimeOptions<never>) => Runtime> = Object.assign(
  Object.create(null) as Record<string, new (options?: RuntimeOptions<never>) => Runtime>,
  {
    pyodide: PyodideRuntime,
    monty: MontyRuntime,
    quickjs: QuickJsRuntime,
    vfs: VfsRuntime,
  },
)

/** The runtime classes that capture a command, preference order. */
export function candidates(command: string): (typeof RUNTIMES)[number][] {
  return RUNTIMES.filter((cls) => cls.commands.includes(command))
}

// Every runtime is constructed the same way; config keys are checked
// inside each class (its config key list), so the entry level only
// knows the uniform options. Python gets this check for free
// (`**options` raises TypeError on an unknown kwarg); a TS object
// literal would silently swallow a typo key without it.
const ENTRY_KEYS: readonly string[] = ['captures', 'config', 'script']

/**
 * Register a runtime class under a config name. Runtime packages
 * extend the table with their own runtimes (e.g. `daytona` from
 * `@struktoai/mirage-node`), mirroring Python's NAMED dict; existing
 * entries are overwritten.
 */
export function registerRuntime(
  name: string,
  cls: new (options?: RuntimeOptions<never>) => Runtime,
): void {
  NAMED[name] = cls
}

/**
 * Construct a runtime by name, failing loud on unknown names (with a
 * cross-language hint for Python-only names) and on unknown options.
 */
export function buildRuntime(name: string, options: Record<string, unknown> = {}): Runtime {
  const cls = NAMED[name]
  if (cls === undefined) {
    const hint = PYTHON_ONLY_HINTS[name]
    if (hint !== undefined) throw new Error(hint)
    const known = Object.keys(NAMED)
      .map((n) => `'${n}'`)
      .join(', ')
    throw new Error(`unknown runtime: '${name}' (expected one of ${known})`)
  }
  for (const key of Object.keys(options)) {
    if (!ENTRY_KEYS.includes(key)) {
      const knownKeys = ENTRY_KEYS.map((k) => `'${k}'`).join(', ')
      throw new Error(`unknown ${name} runtime option '${key}' (expected: ${knownKeys})`)
    }
  }
  return new cls(options as RuntimeOptions<never>)
}
