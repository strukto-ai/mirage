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

import { runWithSession } from '@struktoai/mirage-core/context/session_context'
import type { Session } from '@struktoai/mirage-core/workspace/session/session'
// Type-only, so nothing circular survives compilation: mount.ts imports
// these functions at runtime, this side imports only the shape of the
// table they wrap. The wire arg and reply types live beside `start()`'s
// argument order in mount.ts rather than in types.ts, and moving the
// whole family here to satisfy one import would be a bigger change than
// the module split it serves.
import type { NFSDelegate } from './mount.ts'

/** What the manager needs of a delegate at teardown. */
export interface NFSFlushable {
  flushAll: () => Promise<void>
}

/**
 * Every entry point under one session's mount grants.
 *
 * The wrap is at the boundary the server calls, not at each op inside
 * the adapter: an adapter that binds twelve of thirteen entry points
 * still serves the thirteenth with the workspace's full reach, and
 * nothing about the missing one looks wrong at the call site. Mirrors
 * how `MirageFS` binds a session-scoped FUSE callback table, and
 * python's `SessionBoundNFS`, which this module is the twin of.
 */
export function bindSession(table: NFSDelegate, session: Session): NFSDelegate {
  const bound: Record<string, unknown> = {}
  for (const [name, fn] of Object.entries(table)) {
    const call = fn as (args: never) => Promise<unknown>
    // The reply is the return value here, unlike the FUSE table's
    // callbacks, so the promise is returned rather than voided.
    bound[name] = (args: never) => runWithSession(session, () => call(args))
  }
  return bound as unknown as NFSDelegate
}

/**
 * The teardown flush, scoped when the delegate is.
 *
 * It writes bytes this session's ops accepted, so it runs under the
 * same grants that accepted them.
 */
export function scopedFlush(fs: NFSFlushable, session?: Session | null): NFSFlushable {
  if (session === undefined || session === null) return fs
  return { flushAll: () => runWithSession(session, () => fs.flushAll()) }
}
