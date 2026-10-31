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

import { type Egress, liveEgress, opened } from '@struktoai/mirage-core/io/gateway'
import { networkRoute } from '@struktoai/mirage-core/io/network'
import { PolicyDenied } from '@struktoai/mirage-core/policy/errors'
import type { Policy } from '@struktoai/mirage-core/policy/base'
import {
  type Policies,
  postNetworkGate,
  preNetworkGate,
} from '@struktoai/mirage-core/policy/policies'
import type { NetworkContext, NetworkEnd } from '@struktoai/mirage-core/policy/types'
import type { Limit } from '@struktoai/mirage-core/types'
import { runLanding } from '@struktoai/mirage-core/context/session_context'
import { runDetached } from '@struktoai/mirage-core/utils/async_context'
import { AsyncResource } from 'node:async_hooks'
import dns from 'node:dns/promises'
import net from 'node:net'
import { type ConnectOptions, relayAt, watchNetwork } from './network.ts'

// The loopback address the gateway listens on.
const LOOPBACK = '127.0.0.1'

// A connection on its way through the gateway: where it was going, what
// judges it, and a call back into the context that opened it.
interface Ticket {
  readonly host: string
  readonly port: number
  readonly egress: Egress
  // The lookup the program's connect named, which a private name may need.
  readonly lookup: net.LookupFunction | null
  readonly run: <T>(fn: () => Promise<T>) => Promise<T>
}

/** Abort a socket so its peer reads a reset, never a clean end. */
function reset(socket: net.Socket): void {
  if (!socket.destroyed) socket.resetAndDestroy()
}

/**
 * Copy both ways until both sides end, counting each, and cut the
 * connection with a reset once it passes `limit`'s bytes or the deadline
 * its seconds set as the attempt began. Mirrors Python's `_relay`.
 */
function relay(
  client: net.Socket,
  server: net.Socket,
  limit: Limit | null,
  counts: [number, number],
  deadline: number | null,
): Promise<NetworkEnd> {
  const cap = limit?.maxBytes ?? null
  return new Promise((resolve) => {
    let ended = 0
    let settled = false
    const timer =
      deadline === null
        ? null
        : setTimeout(
            () => {
              finish('limit')
            },
            Math.max(deadline - Date.now(), 0),
          )
    const finish = (how: NetworkEnd): void => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      if (how === 'closed') {
        client.end()
        server.end()
      } else {
        reset(client)
        reset(server)
      }
      resolve(how)
    }
    const pump = (src: net.Socket, dst: net.Socket, side: 0 | 1): void => {
      src.on('data', (chunk: Buffer) => {
        if (cap !== null && counts[0] + counts[1] + chunk.length > cap) {
          const left = Math.max(cap - counts[0] - counts[1], 0)
          counts[side] += left
          dst.write(chunk.subarray(0, left))
          finish('limit')
          return
        }
        counts[side] += chunk.length
        if (!dst.write(chunk)) {
          src.pause()
          dst.once('drain', () => src.resume())
        }
      })
      src.on('end', () => {
        dst.end()
        ended += 1
        if (ended === 2) finish('closed')
      })
      src.on('error', () => {
        finish('error')
      })
      src.on('close', () => {
        finish(ended === 0 ? 'error' : 'closed')
      })
    }
    pump(client, server, 0)
    pump(server, client, 1)
  })
}

/**
 * The one relay each judged connection of the process passes: a loopback
 * listener, started apart from any line so its own connections carry no
 * egress. A connection is matched to its ticket by the port it comes from.
 * Mirrors Python's `_Gateway`.
 */
class Gateway {
  // The listener on its way up, which every connection before it waits for.
  static starting: Promise<Gateway> | null = null
  readonly server: net.Server
  port = 0
  private readonly tickets = new Map<number, Ticket>()
  private readonly waiting = new Map<number, (ticket: Ticket) => void>()

  constructor() {
    this.server = net.createServer((socket) => {
      void this.serve(socket)
    })
    this.server.unref()
  }

  listen(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(0, LOOPBACK, () => {
        this.port = (this.server.address() as net.AddressInfo).port
        relayAt(LOOPBACK, this.port)
        resolve()
      })
    })
  }

  expect(local: number, ticket: Ticket): void {
    const waiter = this.waiting.get(local)
    this.waiting.delete(local)
    if (waiter !== undefined) waiter(ticket)
    else this.tickets.set(local, ticket)
  }

  private claimed(peer: number): Promise<Ticket> {
    const ticket = this.tickets.get(peer)
    this.tickets.delete(peer)
    if (ticket !== undefined) return Promise.resolve(ticket)
    return new Promise((resolve) => this.waiting.set(peer, resolve))
  }

  private async serve(client: net.Socket): Promise<void> {
    client.pause()
    const ticket = await this.claimed(client.remotePort ?? 0)
    try {
      await this.pass(ticket, client)
    } catch (err) {
      console.debug('gateway: connection failed:', err)
      reset(client)
    }
  }

  /**
   * The addresses a connection to `host` may reach, in the order its lookup
   * (the program's own, else the system's) gives them, each the rule lets;
   * the address itself for a bare one.
   */
  private async reach(ticket: Ticket): Promise<[string, string[]]> {
    const { host, port, egress } = ticket
    const rule = egress.rule
    if (net.isIP(host) !== 0) return ['', rule === null || rule.lets('', host, port) ? [host] : []]
    const lookup = ticket.lookup
    const found: string[] =
      lookup === null
        ? (await dns.lookup(host, { all: true, verbatim: true })).map((entry) => entry.address)
        : await new Promise((resolve, reject) => {
            lookup(host, { all: true }, (err, address) => {
              if (err !== null) reject(err)
              else
                resolve(Array.isArray(address) ? address.map((entry) => entry.address) : [address])
            })
          })
    return [host, found.filter((address) => rule === null || rule.lets(host, address, port))]
  }

  /**
   * One address tried and, once it answers, relayed under `limit`, whose
   * seconds count from the attempt; postNetwork hears how it went either
   * way. Mirrors Python's `_Gateway._attempt`.
   */
  private async attempt(
    ticket: Ticket,
    policies: Policies,
    ctx: NetworkContext,
    passed: readonly Policy[] | null,
    limit: Limit | null,
    client: net.Socket,
  ): Promise<boolean> {
    const started = Date.now()
    const deadline = limit?.timeoutSeconds == null ? null : started + limit.timeoutSeconds * 1000
    const counts: [number, number] = [0, 0]
    let ended: NetworkEnd = 'error'
    let reached = false
    try {
      const server = net.connect({ host: ctx.address, port: ctx.port })
      const opened = await new Promise<'open' | 'late' | 'failed'>((resolve) => {
        const timer =
          deadline === null
            ? null
            : setTimeout(
                () => {
                  resolve('late')
                },
                Math.max(deadline - Date.now(), 0),
              )
        server.once('connect', () => {
          if (timer !== null) clearTimeout(timer)
          resolve('open')
        })
        server.once('error', () => {
          if (timer !== null) clearTimeout(timer)
          resolve('failed')
        })
      })
      if (opened !== 'open') {
        server.destroy()
        if (opened === 'late') {
          ended = 'limit'
          reached = true
          reset(client)
        }
        return reached
      }
      reached = true
      client.resume()
      ended = await relay(client, server, limit, counts, deadline)
    } finally {
      const [sent, received] = counts
      await ticket
        .run(() =>
          runLanding(() =>
            postNetworkGate(
              policies,
              {
                ...ctx,
                bytesSent: sent,
                bytesReceived: received,
                seconds: (Date.now() - started) / 1000,
                ended,
              },
              passed,
            ),
          ),
        )
        .catch((err: unknown) => {
          console.debug('gateway: postNetwork failed:', err)
        })
    }
    return reached
  }

  /**
   * Each address the connection may reach is a connection of its own:
   * judged before it is tried, and told how it went, the one reached or the
   * ones that failed on the way to it. Mirrors Python's `_Gateway._pass`.
   */
  private async pass(ticket: Ticket, client: net.Socket): Promise<void> {
    const policies = ticket.egress.policies
    if (policies === null) return
    const [host, addresses] = await this.reach(ticket)
    for (const address of addresses) {
      const ctx: NetworkContext = await ticket.run(() =>
        Promise.resolve(opened(host, address, ticket.port)),
      )
      let passed: Awaited<ReturnType<typeof preNetworkGate>>
      try {
        passed = await ticket.run(() => preNetworkGate(policies, ctx))
      } catch (err) {
        if (!(err instanceof PolicyDenied)) throw err
        console.debug(`gateway: ${address} refused:`, err.message)
        continue
      }
      if (await this.attempt(ticket, policies, ctx, passed[0], passed[1], client)) return
    }
    reset(client)
  }
}

let gateway: Gateway | null = null

function started(): Promise<Gateway> {
  Gateway.starting ??= Promise.resolve(
    runDetached(async () => {
      const made = new Gateway()
      await made.listen()
      gateway = made
      return made
    }),
  )
  return Gateway.starting
}

/**
 * The egress a socket's connection answers to when a policy may listen for
 * it, null to connect as asked. Mirrors Python's `_through`.
 */
function through(options: ConnectOptions): Egress | null {
  if (options.path !== undefined) return null
  const egress = liveEgress().at(-1)
  if (egress?.policies == null || egress.listening === false) return null
  return egress
}

type Connect = (this: net.Socket, ...args: unknown[]) => net.Socket
// The connect the gateway hands a connection on to: the network rule's,
// taken as the gateway starts watching.
let connect = Reflect.get(net.Socket.prototype, 'connect') as Connect
let watching = false

function connecting(this: net.Socket, ...args: unknown[]): net.Socket {
  // net.connect hands over [options, callback] already normalized; a direct
  // call passes (options, callback) or (port, host, callback).
  const normalized = Array.isArray(args[0]) ? (args[0] as unknown[]) : null
  const first = normalized !== null ? normalized[0] : args[0]
  const callback = (normalized ?? args).find((arg) => typeof arg === 'function')
  let options: ConnectOptions
  if (typeof first === 'object' && first !== null) {
    options = first as ConnectOptions
  } else if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    options = { port: Number(first), ...(typeof args[1] === 'string' ? { host: args[1] } : {}) }
  } else {
    return Reflect.apply(connect, this, args)
  }
  const egress = through(options)
  if (egress === null) return Reflect.apply(connect, this, args)
  // undici hands the port over as text.
  const port = Number(options.port as number | string)
  // A routed connection goes, and is judged, where its route names, its end
  // looked up as the system looks it up.
  const routed = networkRoute(options.host ?? 'localhost', port)
  const ticket: Ticket = {
    host: routed?.[0] ?? options.host ?? 'localhost',
    port: routed?.[1] ?? port,
    egress,
    lookup: routed === null ? (options.lookup ?? null) : null,
    run: AsyncResource.bind(<T>(fn: () => Promise<T>): Promise<T> => fn()),
  }
  const redirect = (made: Gateway): net.Socket => {
    this.once('connect', () => {
      made.expect(this.localPort ?? 0, ticket)
    })
    const redirected: ConnectOptions = {
      ...options,
      host: LOOPBACK,
      port: made.port,
      family: 4,
      autoSelectFamily: false,
    }
    delete redirected.lookup
    return Reflect.apply(
      connect,
      this,
      typeof callback === 'function' ? [redirected, callback] : [redirected],
    )
  }
  if (gateway !== null && egress.listening === true) return redirect(gateway)
  // A connection opened before the gateway listens, or before the egress
  // knows whether a policy listens, waits for both; its writes queue as a
  // connecting socket's do.
  Reflect.set(this, 'connecting', true)
  void egress.hooked
    .then((hooked) => (hooked ? started().then(redirect) : Reflect.apply(connect, this, args)))
    .catch((err: unknown) => {
      this.destroy(err instanceof Error ? err : new Error(String(err)))
    })
  return this
}

/**
 * Send every connection the process opens through `through`, once; one with
 * no egress bound connects as asked. Mirrors Python's `_watch`.
 */
export function watch(): void {
  if (watching) return
  watching = true
  watchNetwork()
  connect = Reflect.get(net.Socket.prototype, 'connect') as Connect
  net.Socket.prototype.connect = connecting as typeof net.Socket.prototype.connect
}
