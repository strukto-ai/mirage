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

import type { FlagValue } from '../../spec/types.ts'
import type { IOResult } from '../../../io/types.ts'
import type { JsonValue, PathSpec } from '../../../types.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { tabsConfig, tabsGeneric } from './expand.ts'

/** unexpand's engine config: `tabsConfig` over `-t`, `-a` and `--first-only`.
 * Mirrors Python's `unexpand_config`. */
export function unexpandConfig(
  bag: Record<string, FlagValue>,
): Record<string, JsonValue> | IOResult {
  return tabsConfig('unexpand', ['tabs', 'all', 'first_only'], bag)
}

/** Run unexpand over resolved operands with `unexpandConfig`'s config.
 * Mirrors Python's `unexpand_generic`. */
export function unexpandGeneric(
  config: Record<string, JsonValue>,
  paths: PathSpec[],
  ctx: Context,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): CommandFnResult {
  return tabsGeneric('unexpand', config, paths, ctx, stream)
}
