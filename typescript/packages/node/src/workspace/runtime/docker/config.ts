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

/**
 * The docker machine config, mapped onto the docker CLI.
 *
 * `disk` is deliberately not a field: the default storage driver has
 * no per-container limit. Templates and SDK params are not fields
 * either; docker boots images and is driven by CLI flags.
 */
export interface DockerConfig extends SandboxConfig {
  /** Image to boot, pulled on first use (python:3.12-slim when omitted). */
  image?: string
  /** CPU cores, mapped onto --cpus. */
  cpu?: number
  /** Memory in GiB, mapped onto --memory. */
  memory?: number
  /** GPU count or spec, mapped onto --gpus. */
  gpu?: number | string
  /** Extra `docker run` flags passed verbatim before the image. */
  args?: readonly string[]
}

export const DOCKER_CONFIG_KEYS: readonly string[] = [
  'env',
  'image',
  'cpu',
  'memory',
  'gpu',
  'args',
]
