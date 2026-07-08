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

import type { ByteSource, IOResult } from '../../../../io/types.ts'
import type { PathSpec } from '../../../../types.ts'

// How a cross-mount command combines per-mount work.
//
// STREAM: `cmd files...` is equivalent to `cat files... | cmd`, so each
// operand's raw bytes come from a native flagless `cat` on its owning mount
// and one native run of the real command consumes the merged stream.
// FANOUT: output is per-operand (filename-keyed lines or blocks), so the
// command runs natively once per operand on its owning mount and the outputs
// combine in operand order.
// RELAY: data from several mounts must colocate (copy targets, diff sides),
// so per-file primitives relay through the dispatcher and the shared generic
// does the work.
export enum Strategy {
  STREAM = 'stream',
  FANOUT = 'fanout',
  RELAY = 'relay',
}

export type DispatchFn = (
  op: string,
  path: PathSpec,
  args?: readonly unknown[],
  kwargs?: Record<string, unknown>,
) => Promise<[unknown, IOResult]>

export type CrossResult = [ByteSource | null, IOResult]

export interface RunSingleOpts {
  stdin?: ByteSource | null
  resolveHint?: PathSpec | null
}

export type RunSingle = (
  cmdName: string,
  paths: PathSpec[],
  texts: string[],
  flagKwargs: Record<string, string | boolean | string[]>,
  opts?: RunSingleOpts,
) => Promise<CrossResult>

export interface OperandRun {
  scope: PathSpec
  data: Uint8Array
  io: IOResult
}
