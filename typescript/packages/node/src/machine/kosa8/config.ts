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

import type { ConfigFields } from '@struktoai/mirage-core/runtime/config'
import { MachineConfig } from '@struktoai/mirage-core/machine/config'
import type { PauseAction } from '@struktoai/mirage-core/machine/types'
import { ON_PAUSE } from './constants.ts'

/** How to reach a kosa8 sandbox: yours, by its id, or one Mirage starts at the first run that needs it. */
export interface Kosa8Config extends MachineConfig {
  /**
   * Id of a sandbox you created (`kosa8 sandbox create`, the dashboard or
   * an SDK). Unset, Mirage starts one from `template` or `image`.
   */
  sandboxId?: string
  /** The kosa8 template Mirage starts a sandbox from; kosa8's `base` unset. */
  template?: string
  /** An OCI image Mirage starts the sandbox from instead of a template, booted cold. */
  image?: string
  /**
   * Seconds a sandbox Mirage started stays awake with nothing running before
   * kosa8 puts it to sleep; the next line wakes it. Unset is
   * `IDLE_TIMEOUT_SECONDS`.
   */
  idleTimeout?: number
  /**
   * False lets programs on the sandbox reach nothing, true anything; unset
   * leaves the sandbox's own policy unless a list below is set.
   */
  network?: boolean
  /**
   * The only hosts programs on the sandbox may reach: names, `*.domain`
   * wildcards, IPv4 addresses or ranges.
   */
  allowedDomains?: readonly string[]
  /** Hosts they may not reach, even where an allowed entry covers them. */
  deniedDomains?: readonly string[]
  /**
   * kosa8 secrets, by name, brokered to a sandbox Mirage starts: programs
   * there see a placeholder, and kosa8 puts the value in on the way to the
   * secret's host.
   */
  secrets?: readonly string[]
  /** kosa8 API key; Node falls back to KOSA8_API_KEY. */
  apiKey?: string
  /** kosa8 Cloud's address; unset reads KOSA8_CLOUD_URL, then `https://api.kosa8.com`. */
  apiUrl?: string
  /** `pause`: put a sandbox you brought to sleep when the workspace pauses; unset leaves it as it is. */
  onPause?: PauseAction
}

export const Kosa8Config = {
  ...MachineConfig,
  sandboxId: { type: 'string' },
  template: { type: 'string' },
  image: { type: 'string' },
  idleTimeout: { type: 'number' },
  network: { type: 'boolean' },
  allowedDomains: { type: 'list' },
  deniedDomains: { type: 'list' },
  secrets: { type: 'list' },
  apiKey: { type: 'string' },
  apiUrl: { type: 'string' },
  onPause: { type: 'string', options: ON_PAUSE },
} satisfies ConfigFields<Kosa8Config>

/**
 * The kosa8 egress policy the config's network settings make, null when
 * they set nothing and the sandbox keeps its own. Mirrors Python's
 * `egress_policy`.
 */
export function egressPolicy(
  config: Kosa8Config,
): { internet: boolean; allow?: string[]; deny?: string[] } | null {
  const allowed = config.allowedDomains ?? null
  const deny = [...(config.deniedDomains ?? [])]
  const network = config.network ?? null
  if (network === null && allowed === null && deny.length === 0) return null
  if (network === false || deny.includes('*')) return { internet: false }
  const policy: { internet: boolean; allow?: string[]; deny?: string[] } =
    allowed !== null && !allowed.includes('*')
      ? { internet: false, allow: [...allowed] }
      : { internet: true }
  if (deny.length > 0) policy.deny = deny
  return policy
}
