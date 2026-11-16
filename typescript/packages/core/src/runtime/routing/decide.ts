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

import type { Runtime } from '../base.ts'
import { LanguageRuntime } from '../language.ts'
import { placement } from '../table.ts'

/**
 * The workspace entry that runs a script CLI.
 *
 * The first entry on a `machine` machine that speaks the script's
 * language wins, or the first that is the named `runtime`. There is no
 * any-language fallback: a python program cannot run on a js engine, so
 * no match means null and the caller reports the world's entries.
 * Mirrors Python's `runtime_for_script`.
 */
export function runtimeForScript(
  entries: readonly Runtime[],
  machine: string,
  runtime: string | null,
  language: string,
): LanguageRuntime | null {
  for (const entry of entries) {
    if (!(entry instanceof LanguageRuntime) || entry.language !== language) continue
    const [provider, name] = placement(entry)
    if (provider === machine && (runtime === null || runtime === name)) return entry
  }
  return null
}
