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
 * hosts and ranges it may and may not reach and where a connection goes
 * instead, `{ allowed_domains: [...], denied_domains: [...], routes: {...} }`.
 * Mirrors Python's `NetworkSetting`.
 */
export type NetworkSetting =
  | boolean
  | {
      readonly allowed_domains?: readonly string[]
      readonly denied_domains?: readonly string[]
      readonly routes?: Readonly<Record<string, string>>
    }

// Each list a `network` object takes, and the rule layer it fills.
const LISTS: Record<string, string> = { allowed_domains: 'allow', denied_domains: 'deny' }

const SHAPE = '{allowed_domains: [...], denied_domains: [...], routes: {...}}'

// A route's end: a bracketed address or a name, and a port.
const ENDPOINT = /^(?:\[([^\]]+)\]|([^:\s/[\]]+)):(\d+)$/

/**
 * A route's end, `host:port` (an IPv6 address bracketed), as the host and
 * the port a connection names them: the host in lower case, without its
 * brackets or a trailing dot. Throws for anything else.
 */
function endpoint(text: string): readonly [string, number] {
  const match = ENDPOINT.exec(text)
  const port = Number(match?.[3])
  if (match === null || !(port > 0 && port < 65536)) {
    throw new Error(`network: route ${JSON.stringify(text)} is not host:port`)
  }
  const host = (match[1] ?? match[2] ?? '').toLowerCase()
  return [host.endsWith('.') ? host.slice(0, -1) : host, port]
}

function key(host: string, port: number): string {
  return `${host}\0${String(port)}`
}

/**
 * Whether a workspace may open one connection: its `network` setting, the
 * process's ceiling and the metadata block, each a layer mirage-rs compiles
 * once and every connection must clear. Throws when an entry is not an
 * address, a range or a host name. Mirrors Python's `NetworkRule`.
 */
export class NetworkRule {
  private readonly stream: MovableStream
  private readonly targets = new Map<string, readonly [string, number]>()

  constructor(
    // What it was built from, which a narrower rule builds on.
    readonly layers: readonly Record<string, JsonValue>[],
    readonly metadata = false,
    // Where a connection to `host:port` goes instead, judged there.
    readonly routes: Readonly<Record<string, string>> = {},
  ) {
    try {
      this.stream = new MovableStream('network', { layers: [...layers], metadata })
    } catch (error) {
      if (error instanceof StreamRefusal) throw new Error(error.message)
      throw error
    }
    for (const [from, to] of Object.entries(routes)) {
      this.targets.set(key(...endpoint(from)), endpoint(to))
    }
    for (const [from, to] of Object.entries(routes)) {
      if (this.targets.has(key(...endpoint(to)))) {
        throw new Error(`network: route ${from} goes to ${to}, which is routed too`)
      }
    }
  }

  /**
   * Where a connection to `host` on `port` goes instead: the host and the
   * port its route names, null for none.
   */
  route(host: string, port: number): readonly [string, number] | null {
    const name = host.toLowerCase()
    const bare = name.startsWith('[') && name.endsWith(']') ? name.slice(1, -1) : name
    return this.targets.get(key(bare.endsWith('.') ? bare.slice(0, -1) : bare, port)) ?? null
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

function field(key: string, value: unknown): boolean {
  if (key === 'routes') {
    return (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Object.values(value).every((target) => typeof target === 'string')
    )
  }
  return key in LISTS && Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

/**
 * The layer a `network` setting adds: none for true or routes alone, one
 * that lets nothing for false, and its allowed and denied lists for an
 * object. Throws for anything else. Mirrors Python's `network_layer`.
 */
export function networkLayer(setting: unknown): Record<string, JsonValue> | null {
  if (setting === true) return null
  if (setting === false) return { allow: [] }
  if (typeof setting === 'object' && setting !== null && !Array.isArray(setting)) {
    const fields = Object.entries(setting)
    if (fields.length > 0 && fields.every(([key, value]) => field(key, value))) {
      const lists = fields.filter(([key]) => key in LISTS)
      if (lists.length === 0) return null
      const layer: Record<string, JsonValue> = {}
      for (const [key, entries] of lists) layer[LISTS[key] ?? key] = [...(entries as string[])]
      return layer
    }
  }
  throw new Error(`network is true, false or ${SHAPE}, not ${JSON.stringify(setting)}`)
}

/**
 * The routes a `network` setting names, `{ "host:port": "host:port" }`;
 * none for true or false. Mirrors Python's `network_routes`.
 */
export function networkRoutes(setting: NetworkSetting): Readonly<Record<string, string>> {
  return typeof setting === 'object' ? { ...setting.routes } : {}
}

/**
 * Whether two settings hold the same rule: their allowed and denied lists
 * name the same entries as written, in any order, `false` being an empty
 * allowed list and an empty denied list none at all, since it refuses
 * nothing, and their routes go from and to the same ends. An entry is
 * compared as written, since one spelling can be an address and another a
 * host name.
 */
export function sameNetwork(a: NetworkSetting, b: NetworkSetting): boolean {
  const [left, right] = [a, b].map((setting) => {
    const layer = networkLayer(setting)
    const sorted = (entries: JsonValue | undefined): string[] | null =>
      entries === undefined ? null : [...new Set(entries as string[])].sort(compareCodePoints)
    const denied = sorted(layer?.deny)
    const routes = Object.entries(networkRoutes(setting))
      .map(([from, to]) => [key(...endpoint(from)), key(...endpoint(to))])
      .sort(([a], [b]) => compareCodePoints(a ?? '', b ?? ''))
    return JSON.stringify([sorted(layer?.allow), denied?.length === 0 ? null : denied, routes])
  })
  return left === right
}

/**
 * The rule a workspace's connections are judged by: its `network`, with the
 * cloud metadata addresses refused when `metadata` is set; null when nothing
 * limits or routes it. Mirrors Python's `network_rule`.
 */
export function networkRule(setting: NetworkSetting = true, metadata = false): NetworkRule | null {
  const layer = networkLayer(setting)
  const layers = layer === null ? [] : [layer]
  const routes = networkRoutes(setting)
  if (layers.length === 0 && !metadata && Object.keys(routes).length === 0) return null
  return new NetworkRule(layers, metadata, routes)
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
 * Where the workspace a call runs for sends a connection to `host` on
 * `port` instead, null for nowhere else. A browser answers by the newest
 * live rule. Mirrors Python's `network_route`.
 */
export function networkRoute(host: string, port: number): readonly [string, number] | null {
  return networkBound()?.route(host, port) ?? null
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
