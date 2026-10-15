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

import type { PathSpec } from '@struktoai/mirage-core/types'
import { eacces } from '@struktoai/mirage-core/errors/fs'
import { HfHubError } from './client.ts'
import { ABSENT_STATUSES } from './constants.ts'

/**
 * Report a repository the Hub will not show as permission denied.
 *
 * A 401, 403 or 404 for the repository or revision is the Hub declining to
 * show the listing, so the path answers the way a directory the caller may not
 * open does: every file tool already reports that and steps past it, where a
 * raw Hub error would stop a walk across other mounts. It is never absence,
 * which reconcile would turn into a delete.
 */
export async function refusalsDenied<T>(
  pathSpec: PathSpec,
  run: () => Promise<T>,
  statuses: ReadonlySet<number> = ABSENT_STATUSES,
): Promise<T> {
  try {
    return await run()
  } catch (err) {
    throw asRefusal(pathSpec, err, statuses)
  }
}

/** The error to rethrow for `err`: EACCES for a refusal, `err` itself otherwise. */
export function asRefusal(
  pathSpec: PathSpec,
  err: unknown,
  statuses: ReadonlySet<number> = ABSENT_STATUSES,
): unknown {
  return err instanceof HfHubError && statuses.has(err.status) ? eacces(pathSpec) : err
}
