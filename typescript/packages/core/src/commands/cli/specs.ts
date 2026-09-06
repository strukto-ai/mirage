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

import type { CLISpec } from './types.ts'
import { DISCORD } from './builtin/discord/index.ts'
import { GH } from './builtin/gh/index.ts'
import { GIT } from './builtin/git/index.ts'
import { GWS } from './builtin/gws/index.ts'
import { LINEAR } from './builtin/linear/index.ts'
import { NTN } from './builtin/ntn/index.ts'
import { SLACK } from './builtin/slack/index.ts'
import { compareCodePoints } from '../../utils/sort.ts'

// Named CLISpec trees the YAML `clis:` section resolves against
// (`cli: slack` looks up "slack" here). The bundled programs are seeded
// here rather than self-registering from their own modules: a side
// effect only fires if something imported that module, so which CLIs
// existed depended on what the caller happened to pull in. Runtime
// packages add theirs through registerCliSpec from their entry point,
// and user programs do the same before the workspace loads.
const BUILTIN_CLI_SPECS: ReadonlyMap<string, CLISpec> = new Map(
  [DISCORD, GH, GIT, GWS, LINEAR, NTN, SLACK].map((spec) => [spec.name, spec]),
)
const CLI_SPECS = new Map(BUILTIN_CLI_SPECS)

/** Resolve a bundled tree without consulting user registrations. */
export function builtinSpecFor(name: string): CLISpec | null {
  return BUILTIN_CLI_SPECS.get(name) ?? null
}

/** Make a CLISpec resolvable by name from YAML; its root name is the key. */
export function registerCliSpec(spec: CLISpec): void {
  if (CLI_SPECS.has(spec.name)) {
    throw new Error(`CLI spec '${spec.name}' is already registered`)
  }
  CLI_SPECS.set(spec.name, spec)
}

/** Remove a named CLISpec from the YAML lookup. */
export function unregisterCliSpec(name: string): void {
  if (!CLI_SPECS.has(name)) {
    throw new Error(`CLI spec '${name}' is not registered`)
  }
  CLI_SPECS.delete(name)
}

/** Resolve a YAML `cli:` key to its registered tree, fail loud. */
export function cliSpecFor(name: string): CLISpec {
  const spec = CLI_SPECS.get(name)
  if (spec === undefined) {
    const known = [...CLI_SPECS.keys()].sort(compareCodePoints).join(', ') || 'none registered'
    throw new Error(`unknown cli '${name}' (known: ${known})`)
  }
  return spec
}
