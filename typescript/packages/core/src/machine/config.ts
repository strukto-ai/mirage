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

import type { ConfigFields, RuntimeConfig } from '../runtime/config.ts'
import type { MountType, PauseAction } from './types.ts'
import { MOUNT_TYPES } from './constants.ts'

/**
 * How to reach the machine: the fields every provider has.
 *
 * This base carries only what all providers support; each provider
 * extends it with its own fields (DockerConfig, DaytonaConfig,
 * E2BConfig) and its own key list, so an option a provider cannot
 * honor fails loud at construction. In yaml these are a `machines:`
 * entry's fields beside its `provider`.
 */
export interface MachineConfig extends RuntimeConfig {
  /** Environment set in the machine. */
  env?: Record<string, string>
  /**
   * How the machine sees the workspace: `ssh` serves every prefix the
   * session sees from the host over SFTP (the image needs sshfs), `fuse`
   * leaves them to a mirage in the machine, `both` serves from the host
   * what the machine does not mount itself. Unset serves nothing.
   */
  mountType?: MountType
  /**
   * The commands the machine runs, `@external` and `@line` among them;
   * unset for `@external`, the programs nothing in Mirage resolves.
   */
  captures?: readonly string[]
}

export const BASE_CONFIG_FIELDS: ConfigFields = {
  env: { type: 'map' },
  mountType: { type: 'string', options: MOUNT_TYPES },
  captures: { type: 'list' },
}

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

/**
 * Fail loud on an `onPause` other than the provider's own `options`; unset
 * leaves the machine alone. Mirrors Python's `check_on_pause`.
 */
export function checkOnPause(
  runtime: string,
  onPause: unknown,
  options: readonly PauseAction[],
): PauseAction | null {
  if (onPause === undefined || onPause === null) return null
  if (!options.includes(onPause as PauseAction)) {
    throw new Error(
      `${runtime} onPause must be one of ${options.join(', ')}, not ${JSON.stringify(onPause)}`,
    )
  }
  return onPause as PauseAction
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
