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

import { LOGFIRE_KEY, LOGFIRE_REGIONS } from './constants.ts'

/**
 * Config for the monty runtime.
 *
 * Args:
 *   maxMemory: the heap one run may use, spelled as sandlock spells its
 *     own (`10M`, `1G`) or a count of bytes; a run that needs more raises
 *     `MemoryError`.
 *     Absent or null for no cap.
 *   url: a remote Monty server to run on instead of local workers
 *     (`provider: remote`); absent runs locally, or on the Logfire region
 *     `apiKey` names.
 *   apiKey: the server's bearer token; absent sends none.
 */
export interface MontyConfig {
  maxMemory?: string | number | null
  url?: string
  apiKey?: string
}

/**
 * The remote server a config runs on: its `url`, else the server of the
 * Logfire region its `apiKey` names; null for local workers. Mirrors
 * Python's `remote_url`.
 */
export function remoteUrl(config: MontyConfig): string | null {
  if (config.url !== undefined) return config.url
  const region = config.apiKey === undefined ? undefined : LOGFIRE_KEY.exec(config.apiKey)?.[1]
  return (region === undefined ? undefined : LOGFIRE_REGIONS[region]) ?? null
}
