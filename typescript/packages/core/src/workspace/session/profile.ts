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

import type { HiddenPaths, HiddenVars } from '../../types.ts'

/**
 * One role's narrowing, bundled for `createSession(id, { profile })`.
 *
 * Configuration, not enforcement: the fields unpack onto the session's
 * own narrowing fields and the doors keep enforcing. Deliberately not
 * named a View — per the view convention a View is a door-scoped
 * handle an agent holds, while a profile is what the embedder uses to
 * *define* one. Immutable by type, so two agents with the same role
 * share one object and neither can bend the other's view.
 *
 * `mounts` takes the same spellings `createSession` accepts directly;
 * null/omitted leaves mounts unrestricted. `env` presets are seeded
 * into the session environment at creation.
 */
export interface SessionProfile {
  readonly mounts?:
    | ReadonlyMap<string, string>
    | Readonly<Record<string, string>>
    | readonly string[]
    | null
  readonly hiddenPaths?: HiddenPaths | null
  readonly hiddenVars?: HiddenVars | null
  readonly env?: Readonly<Record<string, string>> | null
}
