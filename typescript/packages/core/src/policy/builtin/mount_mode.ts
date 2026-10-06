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

import { requirePathsWritable } from '../../context/session_context.ts'
import type { Policy } from '../base.ts'
import type { Deny, OpsContext } from '../types.ts'
import { posixPhrase } from '../../errors/posix.ts'

/** The configured mode and session grants bound every mutation. An op
 * outside every mount carries an empty prefix and is governed by `/`, the
 * turf a profile's root mode is written under. */
export class MountModePolicy implements Policy {
  preOps(ctx: OpsContext): Deny | null {
    if (!ctx.write || ctx.mode === undefined) return null
    try {
      requirePathsWritable([ctx.path], ctx.prefix || '/', ctx.mode, ctx.subtree === true)
    } catch (error) {
      if (!(error instanceof Error)) throw error
      return { kind: 'deny', reason: posixPhrase('EROFS'), error }
    }
    return null
  }
}
