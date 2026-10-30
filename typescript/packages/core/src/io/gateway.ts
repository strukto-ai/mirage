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
import type { IOResult } from './types.ts'
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
 * step, and a connection opened first waits for it. Mirrors Python's
 * `Egress`.
 */
export class Egress {
  listening: boolean | null = null
  readonly hooked: Promise<boolean>

  constructor(
    readonly rule: NetworkRule | null,
    readonly policies: Policies | null,
    hooked: Promise<boolean>,
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
 * session's connections. Mirrors Python's `run_with_egress`.
 */
export function runWithEgress<T>(
  rule: NetworkRule | null,
  policies: Policies | null,
  fn: () => Promise<T>,
): Promise<T> {
  const outer = egress.getStore()
  const hooked = outer?.policies === policies ? outer.hooked : listens(policies)
  return runWithNetwork(rule, () =>
    Promise.resolve(egress.run(new Egress(rule, policies, hooked), fn)),
  )
}

/**
 * `it` pulled and closed under `bound`: a stream a file op returned opens
 * each later connection, whoever pulls it and however late, under the
 * workspace's rule and policies, as `withCaller` keeps its caller. Mirrors
 * Python's `with_egress`.
 */
export async function* withEgress<T>(it: AsyncIterable<T>, bound: Egress): AsyncGenerator<T> {
  const under = <R>(fn: () => Promise<R>): Promise<R> =>
    runWithNetwork(bound.rule, () => Promise.resolve(egress.run(bound, fn)))
  const iterator = it[Symbol.asyncIterator]()
  try {
    for (;;) {
      const step = await under(() => iterator.next())
      if (step.done === true) return
      yield step.value
    }
  } finally {
    await under(async () => {
      await iterator.return?.()
    })
  }
}

/**
 * `work`'s answer, a stream in it kept under the egress bound here, so a
 * file op's stream pulled after the op returned still opens its connections
 * under the workspace's rule and policies. Nothing is wrapped where neither
 * limits anything. Mirrors Python's `keep_egress`.
 */
export async function keepEgress(work: Promise<[unknown, IOResult]>): Promise<[unknown, IOResult]> {
  const [result, io] = await work
  const bound = egress.getStore()
  if (
    bound !== undefined &&
    (bound.rule !== null || (bound.policies !== null && bound.listening !== false)) &&
    typeof result === 'object' &&
    result !== null &&
    Symbol.asyncIterator in result
  ) {
    return [withEgress(result as AsyncIterable<unknown>, bound), io]
  }
  return [result, io]
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
