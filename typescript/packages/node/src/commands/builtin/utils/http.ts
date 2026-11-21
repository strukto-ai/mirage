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

import { registerHostFetch } from '@struktoai/mirage-core/commands/builtin/utils/http'
import { Agent, type Dispatcher, fetch as undiciFetch, getGlobalDispatcher } from 'undici'
import { poolOwner, rulePool } from '../../../io/network.ts'

// curl's -k. Node's fetch takes an undici dispatcher, and an agent built with
// `rejectUnauthorized: false` connects without verifying the server's
// certificate, host name included, as curl -k does. undici's own fetch
// carries the agent, so the dispatcher always matches the fetch whatever
// undici this Node bundles. Built on first use, one per pool owner
// (`poolOwner`), so a pooled socket never carries a request past the rule it
// was opened under or around the policies that judge it.
const INSECURE: Agent.Options = { connect: { rejectUnauthorized: false } }
let agent: Agent | null = null

// The headers fetch adds to every request on its own, which curl and wget
// send only when the line names them.
const ADDED: ReadonlySet<string> = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'sec-fetch-mode',
  'user-agent',
])

function insecureAgent(): Agent {
  const owner = poolOwner()
  return owner === null ? (agent ??= new Agent(INSECURE)) : rulePool(owner, true)
}

/** Drop the headers fetch added that the caller did not name. */
function onlyNamed(named: ReadonlySet<string>): Dispatcher.DispatcherComposeInterceptor {
  return (dispatch) => (options, handler) => {
    const given = options.headers
    if (given === null || given === undefined || Array.isArray(given) || Symbol.iterator in given)
      return dispatch(options, handler)
    const headers = Object.fromEntries(
      Object.entries(given).filter(([name]) => {
        const key = name.toLowerCase()
        return !ADDED.has(key) || named.has(key)
      }),
    )
    return dispatch({ ...options, headers }, handler)
  }
}

registerHostFetch((url, init, verify) => {
  const named = new Set(
    Object.keys((init.headers ?? {}) as Record<string, string>).map((name) => name.toLowerCase()),
  )
  // The process's own dispatcher when verifying, which carries the pool a
  // network rule picks (`watchNetwork`) and whatever the application set.
  const base = verify ? getGlobalDispatcher() : insecureAgent()
  return undiciFetch(url, {
    ...(init as unknown as Parameters<typeof undiciFetch>[1]),
    dispatcher: base.compose(onlyNamed(named)),
  }) as unknown as Promise<Response>
})
