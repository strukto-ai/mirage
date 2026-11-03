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

import { createAsyncContext } from '../../utils/async_context.ts'

/** One incoming request a host answers, compared by identity. */
export type IncomingRequest = Readonly<Record<never, never>>

const requests = createAsyncContext<IncomingRequest>()

/**
 * Run `answer` as one incoming request. An edge runtime cancels a socket's
 * I/O once the request that opened it is answered, so a client holding one
 * opens it again for the next request; a host that never binds a request
 * keeps its sockets for as long as it likes.
 */
export function inRequest<T>(answer: () => Promise<T>): Promise<T> {
  return Promise.resolve(requests.run({}, answer))
}

/** The request being answered now, or null on a host that binds none. */
export function currentRequest(): IncomingRequest | null {
  return requests.getStore() ?? null
}
