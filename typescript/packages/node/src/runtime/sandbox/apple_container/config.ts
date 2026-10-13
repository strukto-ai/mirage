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

import { nonblank, type SandboxConfig } from '@struktoai/mirage-core/runtime/sandbox/config'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'

/** How to reach the user's running containers. */
export interface AppleContainerConfig extends SandboxConfig {
  /** Id of the running container for a session with none of its own in `containers`. */
  container?: string
  /** Session id to container id, one container per agent. */
  containers?: Record<string, string>
}

export const APPLE_CONTAINER_CONFIG_KEYS: readonly string[] = ['env', 'container', 'containers']

/** Validate container ids before any session can use the runtime. */
export function validateAppleContainerConfig(config: AppleContainerConfig): void {
  const { container, containers = {} } = config
  if (container === undefined && Object.keys(containers).length === 0) {
    throw new Error('apple_container config needs container or containers')
  }
  if (container !== undefined && !nonblank(container)) {
    throw new Error('apple_container container must be a nonblank id')
  }
  const blank = Object.entries(containers)
    .filter(([, id]) => !nonblank(id))
    .map(([session]) => session)
    .sort(compareCodePoints)
  if (blank.length > 0) {
    throw new Error(
      `apple_container containers must map each session to a nonblank id: ${blank.join(', ')}`,
    )
  }
}
