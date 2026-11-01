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

import { stripSlash } from '../../utils/slash.ts'
import { encodedPath } from '../msgraph/client.ts'
import type { resolveMsGraphConfig } from '../msgraph/config.ts'
import { graphApi } from '../msgraph/config.ts'

/**
 * A drive item's Graph URL.
 *
 * Takes the config, not just the drive id, because the service root is a
 * per-mount setting (national cloud, private endpoint, test server) rather
 * than a constant.
 *
 * Args:
 *   config: mount config carrying the service root.
 *   driveId: drive holding the item.
 *   path: drive-relative item path.
 *   action: optional trailing Graph action, e.g. `/content`.
 */
export function itemUrl(
  config: ReturnType<typeof resolveMsGraphConfig>,
  driveId: string,
  path: string,
  action = '',
): string {
  const base = `${graphApi(config)}/drives/${encodeURIComponent(driveId)}`
  const stripped = stripSlash(path)
  if (stripped === '') return `${base}/root${action}`
  const stem = `${base}/root:/${encodedPath(stripped)}`
  return action !== '' ? `${stem}:${action}` : stem
}

export function driveRefPath(driveId: string, folder = ''): string {
  const base = `/drives/${driveId}`
  const stripped = stripSlash(folder)
  return stripped !== '' ? `${base}/root:/${encodedPath(stripped)}` : `${base}/root:`
}
