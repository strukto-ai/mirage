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

import type { CommandFnResult } from '../../../config.ts'
import { IOResult } from '../../../../io/types.ts'
import { NotionAPIError } from '../../../../core/notion/_client.ts'
import type { CLIInvocation, CLIVerbFn } from '../../types.ts'

const ENC = new TextEncoder()

const FAILED = 'error: Public API request failed'
// 401 is the one status upstream does not itemize: it drops the parenthesis
// entirely and answers with an actionable hint and its own exit code, because a
// token problem is the user's to fix and naming `unauthorized` twice would not
// help them do it.
const UNAUTHORIZED_HINT =
  '  hint: Set NOTION_API_TOKEN, or run `ntn login` to reuse a saved workspace token.\n'
const API_ERROR_EXIT = 5
const UNAUTHORIZED_EXIT = 4
const UNAUTHORIZED = 401

// Upstream is a Rust program and renders the reason phrase from its http
// crate's full table, but only the statuses Notion itself documents can reach a
// caller, so those are the ones pinned here (probed one by one against ntn
// 0.21.9). An unlisted status keeps the number and drops the phrase rather than
// inventing one. Spelled out instead of read from node:http because core runs
// in the browser too.
const HTTP_REASON: Record<number, string> = {
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
}

// An API failure a verb has its own second line for. Upstream pairs some
// refusals with a `  hint:` line naming what the operand could have been, which
// is the verb's knowledge rather than the transport's, so it is attached here
// instead of in the client.
export class HintedAPIError extends NotionAPIError {
  constructor(
    base: NotionAPIError,
    public readonly hint: string,
  ) {
    super(base.message, base.status, base.code)
    this.name = 'HintedAPIError'
  }
}

// Upstream's hint for an operand that was neither kind of id.
export function sourceHint(ref: string): string {
  return (
    `  hint: Could not find a data source or database with ID \`${ref}\`. ` +
    `Check that the ID or URL points to a data source or database shared with ` +
    `your integration.\n`
  )
}

// Render an API failure the way the real ntn binary renders it.
export function apiFailure(err: NotionAPIError): [string, number] {
  const hint = err instanceof HintedAPIError ? err.hint : ''
  if (err.status === UNAUTHORIZED) {
    return [`${FAILED}: ${err.message}\n${UNAUTHORIZED_HINT}`, UNAUTHORIZED_EXIT]
  }
  const named: string[] = []
  if (err.status !== null) {
    named.push(String(err.status))
    const reason = HTTP_REASON[err.status]
    if (reason !== undefined) named.push(reason)
  }
  if (err.code !== null) named.push(err.code)
  const detail = named.length > 0 ? ` (${named.join(' ')})` : ''
  return [`${FAILED}${detail}: ${err.message}\n${hint}`, API_ERROR_EXIT]
}

// Stamped on the wrapper so the invariant below is checkable rather than
// inferred: python reads it off `partial.func`, and a wrapper closure has no
// equivalent to read, so it carries the fact instead.
export const GUARDED = Symbol.for('ntn.guarded')

// Run one ntn verb, answering an API failure in upstream's voice. Every leaf is
// wrapped with this in the tree, because the executor's own fallback prints
// `ntn <verb>: <message>` and exits 1 (the GNU shape it owes every other CLI),
// which drops the status, the reason phrase and Notion's machine-readable code:
// exactly the three fields a caller branches on. failure.test.ts fails if a
// leaf is left unwrapped.
export function guarded(fn: CLIVerbFn): CLIVerbFn {
  const wrapped = async (inv: CLIInvocation): Promise<CommandFnResult> => {
    try {
      return await fn(inv)
    } catch (err) {
      if (!(err instanceof NotionAPIError)) throw err
      const [stderr, exitCode] = apiFailure(err)
      return [null, new IOResult({ stderr: ENC.encode(stderr), exitCode })]
    }
  }
  return Object.assign(wrapped, { [GUARDED]: true })
}
