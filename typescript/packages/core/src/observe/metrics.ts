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

import { metrics, type Meter } from '@opentelemetry/api'
import { DURATION_BUCKETS, METER_NAME } from './constants.ts'
import type { OpRecord } from './record.ts'
import type { Instruments } from './types.ts'

let held: Instruments | null = null

/**
 * Count a typed line that ended (`exitCode`, `durationMs` in milliseconds) in
 * `mirage.shell.duration`, under its exit code.
 */
export function lineEnded(exitCode: number, durationMs: number): void {
  instruments().shellDuration.record(durationMs / 1000, { 'mirage.exit_code': exitCode })
}

/**
 * Count a call made to a mount, in or out of a line: its length in
 * `mirage.vfs.duration` and the bytes it moved in `mirage.vfs.io`, under the
 * call and the backend that served it.
 */
export function callMade(rec: OpRecord): void {
  const attributes = { 'mirage.vfs.op': rec.op, 'mirage.vfs.source': rec.source }
  const made = instruments()
  made.vfsDuration.record(rec.durationMs / 1000, attributes)
  if (rec.bytes > 0) made.vfsIo.add(rec.bytes, attributes)
}

/**
 * The observer's instruments, made once on the global meter provider: a no-op
 * until the process registers an OpenTelemetry SDK before the first line,
 * whose exporter picks the backend.
 */
function instruments(): Instruments {
  held ??= create(metrics.getMeter(METER_NAME))
  return held
}

/** Make the observer's instruments on `meter`. */
function create(meter: Meter): Instruments {
  return {
    shellDuration: meter.createHistogram('mirage.shell.duration', {
      unit: 's',
      description: 'How long typed lines ran, by exit code.',
      advice: { explicitBucketBoundaries: [...DURATION_BUCKETS] },
    }),
    vfsDuration: meter.createHistogram('mirage.vfs.duration', {
      unit: 's',
      description: 'How long calls to mounts took, by call and backend.',
      advice: { explicitBucketBoundaries: [...DURATION_BUCKETS] },
    }),
    vfsIo: meter.createCounter('mirage.vfs.io', {
      unit: 'By',
      description: 'Bytes calls to mounts moved, by call and backend.',
    }),
  }
}
