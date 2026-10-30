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

import { liveEgress } from '@struktoai/mirage-core/io/gateway'
import { networkBound, networkLets } from '@struktoai/mirage-core/io/network'
import { AsyncResource } from 'node:async_hooks'
import dns, { type LookupAddress, type LookupOptions } from 'node:dns'
import net from 'node:net'
import { constants } from 'node:os'
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'

type Found = string | LookupAddress[]
type LookupDone = (err: NodeJS.ErrnoException | null, address: Found, family?: number) => void
type Lookup = (hostname: string, options: LookupOptions, callback: LookupDone) => void
export type ConnectOptions = net.TcpSocketConnectOpts & { path?: string }

const connect = Reflect.get(net.Socket.prototype, 'connect') as (
  this: net.Socket,
  ...args: unknown[]
) => net.Socket
let watching = false
// The listeners the gateway relays from, which a connect may always reach:
// the gateway judges what is behind them.
const relays = new Set<string>()

/**
 * Let connections to a gateway listener through the connect hook, which
 * judges each one behind it. Mirrors Python's `relay_at`.
 */
export function relayAt(host: string, port: number): void {
  relays.add(`${host}:${String(port)}`)
}

/** What a refused connection fails with, as Node's own connect errors read. */
function refusal(host: string, port: number): NodeJS.ErrnoException {
  return Object.assign(new Error(`connect EACCES ${host}:${String(port)}`), {
    code: 'EACCES',
    errno: -constants.errno.EACCES,
    syscall: 'connect',
    address: host,
    port,
  })
}

/**
 * `options` with a lookup that drops each address the rule refuses for the
 * name it was resolved for, and fails when none is left.
 */
function judged(options: ConnectOptions, lets: typeof networkLets): ConnectOptions {
  const lookup: Lookup = (options.lookup as Lookup | undefined) ?? (dns.lookup as Lookup)
  const port = options.port
  const judge: Lookup = (hostname, given, callback) => {
    lookup(hostname, given, (err, address, family) => {
      if (err !== null) {
        callback(err, address, family)
      } else if (Array.isArray(address)) {
        const left = address.filter((entry) => lets(hostname, entry.address, port))
        if (left.length === 0) callback(refusal(hostname, port), [])
        else callback(null, left)
      } else if (lets(hostname, address, port)) {
        callback(null, address, family)
      } else {
        callback(refusal(hostname, port), address, family)
      }
    })
  }
  return { ...options, lookup: judge as net.LookupFunction }
}

function connecting(this: net.Socket, ...args: unknown[]): net.Socket {
  if (networkBound() === null) return Reflect.apply(connect, this, args)
  // net.connect hands over [options, callback] already normalized; a
  // direct call passes (options, callback) or (port, host, callback).
  const normalized = Array.isArray(args[0]) ? (args[0] as unknown[]) : null
  const first = normalized !== null ? normalized[0] : args[0]
  let options: ConnectOptions
  if (typeof first === 'object' && first !== null) {
    options = first as ConnectOptions
  } else if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    options = { port: Number(first), ...(typeof args[1] === 'string' ? { host: args[1] } : {}) }
    args = [options, args.find((arg) => typeof arg === 'function')]
  } else {
    return Reflect.apply(connect, this, args)
  }
  if (options.path !== undefined) return Reflect.apply(connect, this, args)
  // Bound here, so a lookup a resolver answers on another context still
  // asks the rule of the call that opened the connection.
  const lets = AsyncResource.bind(networkLets)
  const host = options.host ?? 'localhost'
  if (relays.has(`${host}:${String(options.port)}`)) return Reflect.apply(connect, this, args)
  if (net.isIP(host) !== 0) {
    if (lets('', host, options.port)) return Reflect.apply(connect, this, args)
    process.nextTick(() => this.destroy(refusal(host, options.port)))
    return this
  }
  const replaced = judged(options, lets)
  if (normalized !== null) normalized[0] = replaced
  else args[0] = replaced
  return Reflect.apply(connect, this, args)
}

// The pools fetch keeps for each rule, and for each workspace whose policies
// listen for connections, verified and unverified (curl's -k), so a socket a
// workspace opened is never reused for a request another workspace's rule
// never let through or its policies never saw.
const pools = new WeakMap<object, { verified?: Agent; unverified?: Agent }>()

/**
 * The pool a fetch under `key` (a rule, or a workspace's policies) takes,
 * built on first use; `unverified` for curl's -k.
 */
export function rulePool(key: object, unverified = false): Agent {
  let held = pools.get(key)
  if (held === undefined) {
    held = {}
    pools.set(key, held)
  }
  if (unverified) return (held.unverified ??= new Agent({ connect: { rejectUnauthorized: false } }))
  return (held.verified ??= new Agent())
}

/**
 * What a fetch's pooled sockets are kept apart by: the rule of the call
 * making it, else the policies of a workspace that may judge its
 * connections, so no socket one workspace opened carries another's request
 * past its rule or its policies; null to share the process's pool.
 */
export function poolOwner(): object | null {
  const bound = liveEgress().at(-1)
  if (bound === undefined) return networkBound()
  if (bound.rule !== null) return bound.rule
  return bound.policies !== null && bound.listening !== false ? bound.policies : null
}

/** Close the pools a rule or a workspace's policies hold, as the workspace closes. */
export async function releaseNetwork(key: object): Promise<void> {
  const held = pools.get(key)
  pools.delete(key)
  await Promise.all([held?.verified?.close(), held?.unverified?.close()])
}

/**
 * Start judging every connection the process opens, once: each socket's
 * connect asks the rule of the workspace whose line or op opens it, and
 * fetch keeps one pool per rule. Called as the first workspace with a rule
 * is built; a connection with no rule bound goes on at once. Mirrors
 * Python's `watch_network`.
 */
export function watchNetwork(): void {
  if (watching) return
  watching = true
  net.Socket.prototype.connect = connecting as typeof net.Socket.prototype.connect
  setGlobalDispatcher(
    getGlobalDispatcher().compose((dispatch) => (options, handler) => {
      const key = poolOwner()
      if (key === null) return dispatch(options, handler)
      return rulePool(key).dispatch(options, handler)
    }),
  )
}
