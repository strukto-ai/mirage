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

import { IOResult } from '../../../../../io/types.ts'
import type { PathSpec } from '../../../../../types.ts'
import { cpGeneric } from '../../cp.ts'
import type { CrossResult, DispatchFn } from '../types.ts'
import { flatten, readBytesOp, readdirOp, statOp } from '../utils.ts'

// Copy operands that span mounts via the shared generic cp. Pure wiring: the
// generic runs in its primitive (no native copy) mode, reading from the
// source mount and writing to the destination mount through dispatch-relayed
// primitives.
export async function runCp(
  scopes: PathSpec[],
  flagKwargs: Record<string, string | boolean | string[]>,
  dispatch: DispatchFn,
): Promise<CrossResult> {
  const flat = flatten(scopes)
  const stat = statOp(dispatch)
  const readBytes = readBytesOp(dispatch)
  const readdir = readdirOp(dispatch)
  const noClobber = flagKwargs.n === true
  const verbose = flagKwargs.v === true
  const write = async (p: PathSpec, data: Uint8Array): Promise<void> => {
    await dispatch('write', p, [data])
  }
  const mkdir = async (p: PathSpec): Promise<void> => {
    await dispatch('mkdir', p)
  }
  const recursive = flagKwargs.r === true || flagKwargs.R === true || flagKwargs.a === true
  // Sources stream through the client here, so record them as reads:
  // apply_io then populates the file cache (a cp is also a full read).
  const reads: Record<string, Uint8Array> = {}
  const recordingRead = async (p: PathSpec): Promise<Uint8Array> => {
    const data = await readBytes(p)
    reads[p.virtual] = data
    return data
  }
  const result = await cpGeneric(
    flat,
    stat,
    { readBytes: recordingRead, write, mkdir, readdir },
    recursive,
    noClobber,
    verbose,
  )
  const [out, io] = result ?? [null, new IOResult()]
  io.reads = { ...io.reads, ...reads }
  io.cache = [...io.cache, ...Object.keys(reads)]
  return [out, io]
}
