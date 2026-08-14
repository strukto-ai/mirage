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

import { drain } from '../io/stream.ts'
import type { ByteSource, IOResult } from '../io/types.ts'
import { materialize } from '../io/types.ts'

export const BarrierPolicy = Object.freeze({
  STREAM: 'stream',
  STATUS: 'status',
  VALUE: 'value',
} as const)

export type BarrierPolicy = (typeof BarrierPolicy)[keyof typeof BarrierPolicy]

export async function applyBarrier(
  stdout: ByteSource | null,
  io: IOResult,
  policy: BarrierPolicy,
): Promise<ByteSource | null> {
  if (policy === BarrierPolicy.STREAM) return stdout
  if (policy === BarrierPolicy.STATUS) {
    await drain(stdout)
    return null
  }
  return materialize(stdout)
}
