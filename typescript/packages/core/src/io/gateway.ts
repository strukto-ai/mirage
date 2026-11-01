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

import { currentCaller } from '../context/session_context.ts'
import type { Policies } from '../policy/policies.ts'
import { OutputStream } from './stream.ts'
import type { NetworkContext } from '../policy/types.ts'
import { createAsyncContext } from '../utils/async_context.ts'
import { rstripSlash } from '../utils/slash.ts'
import { type NetworkRule, runWithNetwork } from './network.ts'

/**
 * What judges the connections a line or a file op opens: the workspace's
 * `network` (null for no limit) and its policies, whose preNetwork and
 * postNetwork each connection answers to. `hooked` settles whether one of
 * them listens for the session's connections, so each goes through the
 * gateway, and `listening` holds the answer once it has: the binding starts
 * the line or the op at once, as a browser's storage must keep its frames in
 * step, and a connection opened first waits for it. `nested` is whether a
 * file op inside a line bound it. Mirrors Python's `Egress`.
 */
export class Egress {
  listening: boolean | null = null
  readonly hooked: Promise<boolean>

  constructor(
    readonly rule: NetworkRule | null,
    readonly policies: Policies | null,
    hooked: Promise<boolean>,
    readonly nested = false,
  ) {
    this.hooked = hooked.then((answer) => (this.listening = answer))
  }
}

const egress = createAsyncContext<Egress>()

async function listens(policies: Policies | null): Promise<boolean> {
  if (policies === null) return false
  const sessionId = currentCaller().session?.sessionId ?? ''
  for (const method of ['preNetwork', 'postNetwork'] as const) {
    if (policies.wants(method) && (await policies.wantsFor(method, sessionId))) return true
  }
  return false
}

/**
 * `fn` run as a line or a file op of a workspace: every connection it opens
 * clears `rule`, and passes the gateway when a policy listens for the
 * session's connections; `nested` when a file op inside a line binds
 * it. Mirrors
 * Python's `run_with_egress`.
 */
export function runWithEgress<T>(
  rule: NetworkRule | null,
  policies: Policies | null,
  fn: () => Promise<T>,
  nested = false,
): Promise<T> {
  const outer = egress.getStore()
  const hooked = outer?.policies === policies ? outer.hooked : listens(policies)
  return runWithNetwork(rule, () =>
    Promise.resolve(egress.run(new Egress(rule, policies, hooked, nested), fn)),
  )
}

/**
 * `it` pulled and closed under the egress bound where it was made: a mount's
 * stream opens each later connection, whoever pulls it and however late,
 * under the workspace's rule and policies, as `withCaller` keeps its caller.
 * Its close reaches the stream even before a first pull. Handed back as it
 * is where neither limits anything. `owner` names the egress outright where
 * a browser's storage, which answers its newest frame, could hand another
 * workspace's. Mirrors Python's `with_egress`.
 */
export function withEgress(
  it: AsyncIterable<Uint8Array>,
  owner: Egress | null = egress.getStore() ?? null,
): AsyncIterable<Uint8Array> {
  const bound = owner
  if (
    bound === null ||
    (bound.rule === null && (bound.policies === null || bound.listening === false))
  ) {
    return it
  }
  const under = <R>(fn: () => Promise<R>): Promise<R> =>
    runWithNetwork(bound.rule, () => Promise.resolve(egress.run(bound, fn)))
  const iterator = it[Symbol.asyncIterator]()
  async function* pulled(): AsyncGenerator<Uint8Array> {
    for (;;) {
      const step = await under(() => iterator.next())
      if (step.done === true) return
      yield step.value
    }
  }
  return new OutputStream(pulled(), async () => {
    await under(async () => {
      await iterator.return?.()
    })
  })
}

/**
 * The egress of every call live in this context: on an isolating runtime the
 * bound one alone, in a browser every concurrently bound one, since it cannot
 * tell whose call is opening the connection. Mirrors Python's `live_egress`.
 */
export function liveEgress(): readonly Egress[] {
  return egress.liveStores()
}

/**
 * The context a connection to `address` on `port`, opened for `host`,
 * reports: the command, the mount and the session of the call opening it.
 * Mirrors Python's `_opened`.
 */
export function opened(host: string, address: string, port: number): NetworkContext {
  const caller = currentCaller()
  const invocation = caller.invocation
  const mount = caller.vfsMount ?? ''
  return {
    host,
    address,
    port,
    command: caller.command ?? '',
    program: invocation?.program ?? [],
    words: invocation?.words ?? [],
    line: invocation?.line ?? '',
    mount: rstripSlash(mount) || mount,
    sessionId: caller.session?.sessionId ?? '',
  }
}
