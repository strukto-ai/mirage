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
import type { NetworkRule } from '@struktoai/mirage-core/io/network'
import { PolicyDenied } from '@struktoai/mirage-core/policy/errors'
import { postNetworkGate, preNetworkGate } from '@struktoai/mirage-core/policy/policies'
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
  readonly started: number
  readonly run: <T>(fn: () => Promise<T>) => Promise<T>
}

/** Abort a socket so its peer reads a reset, never a clean end. */
function reset(socket: net.Socket): void {
  if (!socket.destroyed) socket.resetAndDestroy()
}

/**
 * The addresses a connection to `host` may reach, in the order a lookup
 * gives them, each the rule lets; the address itself for a bare one.
 * Mirrors Python's `_reach`, which the program's own lookup feeds.
 */
async function reach(
  host: string,
  port: number,
  rule: NetworkRule | null,
): Promise<[string, string[]]> {
  if (net.isIP(host) !== 0) {
    return ['', rule === null || rule.lets('', host, port) ? [host] : []]
  }
  const found = await dns.lookup(host, { all: true, verbatim: true })
  return [
    host,
    found
      .map((entry) => entry.address)
      .filter((address) => rule === null || rule.lets(host, address, port)),
  ]
}

/**
 * Copy both ways until both sides end, counting each, and cut the
 * connection with a reset once it passes `limit`. Mirrors Python's `_relay`.
 */
function relay(
  client: net.Socket,
  server: net.Socket,
  limit: Limit | null,
  counts: [number, number],
): Promise<NetworkEnd> {
  const cap = limit?.maxBytes ?? null
  const deadline = limit?.timeoutSeconds ?? null
  return new Promise((resolve) => {
    let ended = 0
    let settled = false
    const timer =
      deadline === null
        ? null
        : setTimeout(() => {
            finish('limit')
          }, deadline * 1000)
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

  private async upstream(addresses: readonly string[], port: number): Promise<net.Socket | null> {
    for (const address of addresses) {
      const socket = net.connect({ host: address, port })
      try {
        await new Promise<void>((resolve, reject) => {
          socket.once('connect', resolve)
          socket.once('error', reject)
        })
        return socket
      } catch {
        socket.destroy()
      }
    }
    return null
  }

  private async pass(ticket: Ticket, client: net.Socket): Promise<void> {
    const { egress } = ticket
    const policies = egress.policies
    if (policies === null) return
    const [host, addresses] = await reach(ticket.host, ticket.port, egress.rule)
    if (addresses.length === 0) {
      reset(client)
      return
    }
    const ctx: NetworkContext = await ticket.run(() =>
      Promise.resolve(opened(host, addresses[0] ?? '', ticket.port)),
    )
    let passed: Awaited<ReturnType<typeof preNetworkGate>>
    try {
      passed = await ticket.run(() => preNetworkGate(policies, ctx))
    } catch (err) {
      if (!(err instanceof PolicyDenied)) throw err
      reset(client)
      return
    }
    const counts: [number, number] = [0, 0]
    let ended: NetworkEnd = 'error'
    try {
      const server = await this.upstream(addresses, ticket.port)
      if (server === null) {
        reset(client)
        return
      }
      client.resume()
      ended = await relay(client, server, passed[1], counts)
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
                seconds: (Date.now() - ticket.started) / 1000,
                ended,
              },
              passed[0],
            ),
          ),
        )
        .catch((err: unknown) => {
          console.debug('gateway: postNetwork failed:', err)
        })
    }
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
  const normalized = Array.isArray(args[0]) ? (args[0] as unknown[]) : null
  const first = normalized !== null ? normalized[0] : args[0]
  if (typeof first !== 'object' || first === null) return Reflect.apply(connect, this, args)
  const options = first as ConnectOptions
  const egress = through(options)
  if (egress === null) return Reflect.apply(connect, this, args)
  const ticket: Ticket = {
    host: options.host ?? 'localhost',
    // undici hands the port over as text.
    port: Number(options.port as number | string),
    egress,
    started: Date.now(),
    run: AsyncResource.bind(<T>(fn: () => Promise<T>): Promise<T> => fn()),
  }
  const callback = normalized !== null ? normalized[1] : args[1]
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
