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

import type { SandboxConfig } from '@struktoai/mirage-core'

/** The Daytona machine config, mapped onto the create params. */
export interface DaytonaConfig extends SandboxConfig {
  /** Image built inline at create time. Mutually exclusive with template. */
  image?: string
  /**
   * Name of a prebaked Daytona snapshot. Prefer it for anything
   * heavy: an inline image build sits in the create path, a snapshot
   * boots in seconds.
   */
  template?: string
  /** CPU cores; sizing requires an image. */
  cpu?: number
  /** Memory in GiB. */
  memory?: number
  /** Disk in GiB. */
  disk?: number
  /** GPU count or type spec; truthy forces the sandbox ephemeral. */
  gpu?: number | string
  /**
   * Any other Daytona create option passed verbatim
   * (autoStopInterval, labels, volumes, ...), merged last so it can
   * override anything computed from the fields above.
   */
  params?: Record<string, unknown>
}

export const DAYTONA_CONFIG_KEYS: readonly string[] = [
  'env',
  'image',
  'template',
  'cpu',
  'memory',
  'disk',
  'gpu',
  'params',
]

/** Whether any per-sandbox sizing field is set. */
export function sizedConfig(config: DaytonaConfig): boolean {
  return (
    config.cpu !== undefined ||
    config.memory !== undefined ||
    config.disk !== undefined ||
    config.gpu !== undefined
  )
}
