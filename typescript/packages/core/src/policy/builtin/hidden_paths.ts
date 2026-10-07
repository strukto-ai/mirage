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

import { hiddenRefusal, sessionVisibility } from '../../context/session_context.ts'
import { pathVisible } from '../../utils/hidden.ts'
import type { Hide, VfsContext } from '../types.ts'

/**
 * Hidden paths answer as absent, including at subtree boundaries. The
 * built-in that answers `Hide` at the op boundary, before any policy:
 * not a `Policy`, because no coded hook returns a Hide.
 */
export class HiddenPathsPolicy {
  /** Hide the op's path when the bound session cannot see it. */
  preVfs(ctx: VfsContext): Promise<Hide | null> {
    const vis = sessionVisibility()
    if (pathVisible(vis, ctx.path)) return Promise.resolve(null)
    return Promise.resolve({
      kind: 'hide',
      error: hiddenRefusal(vis, ctx.path, ctx.create === true),
    })
  }
}
