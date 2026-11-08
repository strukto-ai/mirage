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

import type { FlagView } from '../../spec/flag_view.ts'
import { LineFacts, type PathSpec, type ReaddirFn, type StatFn } from '../../../types.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import { gzipGeneric } from './gzip.ts'

/** Run zcat, which is `gzip -cd`, over resolved operands. Mirrors Python's
 * zcat_generic. */
export async function zcatGeneric(
  paths: PathSpec[],
  ctx: Context,
  stream: (path: PathSpec) => AsyncIterable<Uint8Array>,
  stat?: StatFn,
  readdir?: ReaddirFn,
): Promise<CommandFnResult> {
  return gzipGeneric(paths, ctx, stream, undefined, undefined, stat, readdir, undefined, 'zcat')
}

/** A zcat line reads below its operands under -r. Mirrors Python's `facts`. */
export function facts(fl: FlagView, _operands: readonly (string | PathSpec)[]): LineFacts {
  return new LineFacts({ readsSubtree: fl.asBool('recursive') })
}
