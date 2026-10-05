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

import { hiddenRefusal, pathAllowed } from '../../context/session_context.ts'
import type { Policy } from '../base.ts'
import type { Deny, OpsContext } from '../types.ts'

/** Hidden paths answer as absent, including at subtree boundaries. */
export class HiddenPathsPolicy implements Policy {
  preOps(ctx: OpsContext): Deny | null {
    if (pathAllowed(ctx.path.virtual)) return null
    const error = hiddenRefusal(ctx.path.virtual, ctx.create === true)
    return { kind: 'deny', reason: error.message, error }
  }
}
