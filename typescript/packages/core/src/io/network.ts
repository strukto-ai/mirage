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
import { compareCodePoints } from '../utils/sort.ts'

const ENC = new TextEncoder()

/**
 * A workspace's `network`: true for no limit, false for none at all, or the
 * hosts and ranges it may and may not reach,
 * `{ allowed_domains: [...], denied_domains: [...] }`. Mirrors Python's
 * `NetworkSetting`.
 */
export type NetworkSetting =
  | boolean
  | { readonly allowed_domains?: readonly string[]; readonly denied_domains?: readonly string[] }

// Each list a `network` object takes, and the rule layer it fills.
const LISTS: Record<string, string> = { allowed_domains: 'allow', denied_domains: 'deny' }

/**
 * Whether a workspace may open one connection: its `network` setting, the
 * process's ceiling and the metadata block, each a layer mirage-rs compiles
 * once and every connection must clear. Throws when an entry is not an
 * address, a range or a host name. Mirrors Python's `NetworkRule`.
 */
export class NetworkRule {
  private readonly stream: MovableStream

  constructor(
    // What it was built from, which a narrower rule builds on.
    readonly layers: readonly Record<string, JsonValue>[],
    readonly metadata = false,
  ) {
    try {
      this.stream = new MovableStream('network', { layers: [...layers], metadata })
    } catch (error) {
      if (error instanceof StreamRefusal) throw new Error(error.message)
      throw error
    }
  }

  /**
   * Whether a connection to `address`, resolved for `host`, opens on `port`;
   * either name is empty and the port undefined when unknown.
   */
  lets(host: string, address: string, port?: number): boolean {
    return this.stream.live.test(
      ENC.encode(`${host}\0${address}\0${port === undefined ? '' : String(port)}`),
    )
  }
}

/**
 * The layer a `network` setting adds: none for true, one that lets nothing
 * for false, and its allowed and denied lists for an object. Throws for
 * anything else. Mirrors Python's `network_layer`.
 */
export function networkLayer(setting: unknown): Record<string, JsonValue> | null {
  if (setting === true) return null
  if (setting === false) return { allow: [] }
  if (typeof setting === 'object' && setting !== null && !Array.isArray(setting)) {
    const lists = Object.entries(setting)
    if (
      lists.length > 0 &&
      lists.every(
        ([key, entries]) =>
          key in LISTS &&
          Array.isArray(entries) &&
          entries.every((entry) => typeof entry === 'string'),
      )
    ) {
      const layer: Record<string, JsonValue> = {}
      for (const [key, entries] of lists) layer[LISTS[key] ?? key] = [...(entries as string[])]
      return layer
    }
  }
  throw new Error(
    `network is true, false or {allowed_domains: [...], denied_domains: [...]}, not ${JSON.stringify(setting)}`,
  )
}

/**
 * Whether two settings hold the same rule: their allowed and denied lists
 * name the same entries as written, in any order, `false` being an empty
 * allowed list. An entry is compared as written, since one spelling can be
 * an address and another a host name.
 */
export function sameNetwork(a: NetworkSetting, b: NetworkSetting): boolean {
  const [left, right] = [a, b].map((setting) => {
    const layer = networkLayer(setting)
    if (layer === null) return null
    const sorted = (entries: JsonValue | undefined): string[] | null =>
      entries === undefined ? null : [...new Set(entries as string[])].sort(compareCodePoints)
    return JSON.stringify([sorted(layer.allow), sorted(layer.deny)])
  })
  return left === right
}

/**
 * The rule a workspace's connections are judged by: its own setting and the
 * ceiling of the server that built it, each a layer, with the cloud metadata
 * addresses refused when `metadata` is set; null when nothing limits it.
 * Mirrors Python's `network_rule`.
 */
export function networkRule(
  setting: NetworkSetting = true,
  ceiling: NetworkSetting = true,
  metadata = false,
): NetworkRule | null {
  const layers = [networkLayer(ceiling), networkLayer(setting)].filter(
    (layer): layer is Record<string, JsonValue> => layer !== null,
  )
  if (layers.length === 0 && !metadata) return null
  return new NetworkRule(layers, metadata)
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
 * resolved for `host`, on `port`. A browser cannot tell one task's binding
 * from another's, so there every live workspace's rule must let it. Mirrors
 * Python's `network_lets`.
 */
export function networkLets(host: string, address: string, port?: number): boolean {
  for (const live of rule.liveStores()) {
    if (live !== null && !live.lets(host, address, port)) return false
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
