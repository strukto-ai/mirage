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

import { SPECS as SPEC_TABLE } from './builtin_specs/index.ts'
import type { CommandSpec } from './types.ts'

export function specOf(name: string): CommandSpec {
  const spec = BUILTIN_SPECS[name]
  if (spec === undefined) throw new Error(`no builtin spec: ${name}`)
  return spec
}

// Null prototype: command names are script-controlled, so a name like
// `toString` must miss instead of resolving an `Object.prototype`
// member as a spec.
export const BUILTIN_SPECS: Readonly<Record<string, CommandSpec>> = Object.freeze(
  Object.setPrototypeOf(SPEC_TABLE, null) as Record<string, CommandSpec>,
)
