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

// Named CLISpec trees the YAML `clis:` section resolves against
// (`cli: slack` looks up "slack" here). Bundled programs register at
// import time; user programs register through registerCliSpec before
// the workspace loads.
const CLI_SPECS = new Map<string, CLISpec>()

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
    const known = [...CLI_SPECS.keys()].sort().join(', ') || 'none registered'
    throw new Error(`unknown cli '${name}' (known: ${known})`)
  }
  return spec
}
