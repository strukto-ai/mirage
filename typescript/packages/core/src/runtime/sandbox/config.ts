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

import type { RuntimeConfig } from '../config.ts'
import type { MountType } from '../types.ts'
import { MOUNT_TYPES } from './constants.ts'

/**
 * How to reach the sandbox: the fields every provider has.
 *
 * This base carries only what all providers support; each provider
 * extends it with its own fields (DockerConfig, DaytonaConfig,
 * E2BConfig) and its own key list, so an option a provider cannot
 * honor fails loud at construction. In yaml this is the runtime
 * entry's `config` block, mirroring a mount's.
 */
export interface SandboxConfig extends RuntimeConfig {
  /** Environment set in the sandbox. */
  env?: Record<string, string>
}

/** A provider config with the shared collection fields always present. */
export type NormalizedSandboxConfig<C extends SandboxConfig = SandboxConfig> = C &
  Required<Pick<SandboxConfig, 'env'>>

export const BASE_CONFIG_KEYS: readonly string[] = ['env']

/** Fail loud on a `mountType` other than ssh, fuse or both; unset serves nothing. */
export function checkMountType(runtime: string, mountType: unknown): MountType | null {
  if (mountType === undefined || mountType === null) return null
  if (!MOUNT_TYPES.includes(mountType as MountType)) {
    throw new Error(
      `${runtime} mountType must be one of ${MOUNT_TYPES.join(', ')}, not ${JSON.stringify(mountType)}`,
    )
  }
  return mountType as MountType
}

/** Whether a configured id is a string with something in it. Mirrors Python's `nonblank`. */
export function nonblank(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * Fail loud on a required id that is unset or blank, which would otherwise
 * reach the provider as an empty name. Mirrors Python's `require_id`.
 */
export function requireId(runtime: string, name: string, value: unknown): void {
  if (!nonblank(value)) throw new Error(`${runtime} config needs a nonblank ${name}`)
}
