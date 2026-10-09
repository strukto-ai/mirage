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

import { scriptStringError } from '../../runtime/base.ts'
import type { RoutePolicy, RouteScript } from '../../runtime/routing/types.ts'

/**
 * Guard the code API: script source strings belong to config.
 *
 * In code, scripts and policies are functions; a plain string is almost
 * always a script that should live next to the workspace yaml and be
 * referenced there (`script:` on an entry, `route_policy:` on the workspace),
 * where the loader wraps it as a ScriptSource.
 *
 * Twin of python's `workspace/workspace/guard.py`. The message itself
 * stays in `runtime/base.ts`, which raises it for a RuntimeEntry built
 * with a string script -- a runtime-layer check that must not reach up
 * into the workspace layer for its wording.
 *
 * @param kind what carried the string, for the error message
 * @param value the suspect script value
 */
export function rejectConfigScript(
  kind: string,
  value: RoutePolicy | RouteScript | string | null | undefined,
): void {
  if (typeof value === 'string') throw scriptStringError(kind)
}
