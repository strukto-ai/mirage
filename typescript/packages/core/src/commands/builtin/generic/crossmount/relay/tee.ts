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

import { IOResult, type ByteSource } from '../../../../../io/types.ts'
import type { PathSpec } from '../../../../../types.ts'
import type { FlagValue } from '../../../../spec/types.ts'
import { teeGeneric } from '../../tee.ts'
import type { CrossResult, DispatchFn } from '../types.ts'
import { crossOpts, flatten, statOp, streamOp } from '../utils.ts'

// Copy stdin to outputs on several mounts with one tee. One run sees every
// output, so --output-error=exit checks that each can be opened before any
// is written, as GNU opens them all first. Each output is written on the
// mount that owns it, through the dispatcher, which also drops its cached
// copy; -a goes through the append op, which a mount answers natively or by
// rewriting the file. Mirrors Python's run_tee.
export async function runTee(
  scopes: PathSpec[],
  flagKwargs: Record<string, FlagValue>,
  dispatch: DispatchFn,
  stdin: ByteSource | null,
): Promise<CrossResult> {
  const write = async (path: PathSpec, data: Uint8Array): Promise<void> => {
    await dispatch('write', path, [data])
  }
  const append = async (path: PathSpec, data: Uint8Array): Promise<void> => {
    await dispatch('append', path, [data])
  }
  const [out, io] = (await teeGeneric(
    flatten(scopes),
    [],
    { ...crossOpts(flagKwargs), stdin },
    streamOp(dispatch),
    write,
    append,
    statOp(dispatch),
  )) ?? [null, new IOResult()]
  // Relay writes are keyed by the dispatcher; keyed here they would be
  // prefixed onto one mount.
  return [out, new IOResult({ exitCode: io.exitCode, stderr: io.stderr })]
}
