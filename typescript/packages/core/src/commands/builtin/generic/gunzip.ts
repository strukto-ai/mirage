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

import type { ByteSource } from '../../../io/types.ts'
import type { FlagView } from '../../spec/flag_view.ts'
import { LineFacts, type PathSpec, type ReaddirFn, type StatFn } from '../../../types.ts'
import type { CommandFnResult, Context } from '../../config.ts'
import type { SetAttrsFn } from './decompress.ts'
import { gzipGeneric } from './gzip.ts'

/** Run gunzip, which is `gzip -d`, over resolved operands. Mirrors Python's
 * gunzip_generic. */
export async function gunzipGeneric(
  paths: PathSpec[],
  ctx: Context,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  write: (p: PathSpec, data: ByteSource) => Promise<void>,
  unlink: (p: PathSpec) => Promise<void>,
  stat?: StatFn,
  readdir?: ReaddirFn,
  setAttrs?: SetAttrsFn,
): Promise<CommandFnResult> {
  return gzipGeneric(paths, ctx, stream, write, unlink, stat, readdir, setAttrs, 'gunzip')
}

/** A gunzip line replaces its file operands unless `-c`, `-t` or `-l`.
 * Mirrors Python's `facts`. */
export function facts(fl: FlagView, operands: readonly (string | PathSpec)[]): LineFacts {
  return new LineFacts({
    writes: operands.length > 0 && !['stdout', 'test', 'list'].some((n) => fl.asBool(n)),
    readsSubtree: fl.asBool('recursive'),
  })
}
