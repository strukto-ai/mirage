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

import { StreamRefusal } from '../rs/errors.ts'
import { MovableStream } from '../rs/stream.ts'
import type { JsonValue } from '../types.ts'
import { createAsyncContext } from '../utils/async_context.ts'

const ENC = new TextEncoder()

/**
 * A workspace's `network`: true for no limit, false for none at all, or the
 * hosts and ranges it may reach, `{ allow: [...] }`. Mirrors Python's
 * `NetworkSetting`.
 */
export type NetworkSetting = boolean | { readonly allow: readonly string[] }

/**
 * Whether a workspace may open one connection: its `network` setting, the
 * process's ceiling and the metadata block, each a layer mirage-rs compiles
 * once and every connection must clear. Throws when an entry is not an
 * address, a range or a host name. Mirrors Python's `NetworkRule`.
 */
export class NetworkRule {
  private readonly stream: MovableStream

  constructor(layers: readonly Record<string, JsonValue>[], metadata = false) {
    try {
      this.stream = new MovableStream('network', { layers: [...layers], metadata })
    } catch (error) {
      if (error instanceof StreamRefusal) throw new Error(error.message)
      throw error
    }
  }

  /** Whether a connection to `address`, resolved for `host`, opens; either is empty when unknown. */
  lets(host: string, address: string): boolean {
    return this.stream.live.test(ENC.encode(`${host}\0${address}`))
  }
}

/**
 * The layer a `network` setting adds: none for true, one that lets nothing
 * for false, and its allow list for an object. Throws for anything else.
 * Mirrors Python's `network_layer`.
 */
export function networkLayer(setting: unknown): Record<string, JsonValue> | null {
  if (setting === true) return null
  if (setting === false) return { allow: [] }
  if (
    typeof setting === 'object' &&
    setting !== null &&
    Object.keys(setting).length === 1 &&
    'allow' in setting &&
    Array.isArray(setting.allow) &&
    setting.allow.every((entry) => typeof entry === 'string')
  ) {
    return { allow: [...setting.allow] }
  }
  throw new Error(
    `network is true, false or {allow: [hosts and ranges]}, not ${JSON.stringify(setting)}`,
  )
}

// What every workspace in this process is held to besides its own setting:
// a server's operator ceiling, and the metadata block.
let ceiling: Record<string, JsonValue>[] = []
let metadataBlocked = false

/**
 * Hold every workspace built in this process from now on to `setting` as
 * well as its own, and refuse the cloud metadata addresses for them when
 * `metadata` is set: what a server sets once as it starts. Mirrors Python's
 * `limit_network`.
 */
export function limitNetwork(setting: NetworkSetting, metadata = false): void {
  const layer = networkLayer(setting)
  new NetworkRule(layer === null ? [] : [layer], metadata)
  ceiling = layer === null ? [] : [layer]
  metadataBlocked = metadata
}

/**
 * The rule a workspace's connections are judged by: its own setting over the
 * process's ceiling, null when nothing limits it. Mirrors Python's
 * `network_rule`.
 */
export function networkRule(setting: NetworkSetting = true): NetworkRule | null {
  const own = networkLayer(setting)
  const layers = [...ceiling, ...(own === null ? [] : [own])]
  if (layers.length === 0 && !metadataBlocked) return null
  return new NetworkRule(layers, metadataBlocked)
}

// The rule of the workspace a line or an op runs for, null for no limit.
const rule = createAsyncContext<NetworkRule | null>()

/**
 * `fn` run under a workspace's network rule, which every connection it opens
 * must clear. Mirrors Python's `run_with_network`.
 */
export function runWithNetwork<T>(bound: NetworkRule | null, fn: () => Promise<T>): Promise<T> {
  return Promise.resolve(rule.run(bound, fn))
}

/**
 * Whether the workspace a call runs for may open a connection to `address`,
 * resolved for `host`. A browser cannot tell one task's binding from
 * another's, so there every live workspace's rule must let it. Mirrors
 * Python's `network_lets`.
 */
export function networkLets(host: string, address: string): boolean {
  for (const live of rule.liveStores()) {
    if (live !== null && !live.lets(host, address)) return false
  }
  return true
}

/**
 * The rule bound to the running call, null for none, which a watcher reads
 * to skip the rest and keys its pools by. A browser answers the newest live
 * one. Mirrors Python's `network_bound`.
 */
export function networkBound(): NetworkRule | null {
  return (
    rule
      .liveStores()
      .filter((live): live is NetworkRule => live !== null)
      .at(-1) ?? null
  )
}
