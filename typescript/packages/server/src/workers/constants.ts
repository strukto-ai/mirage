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

// How long a worker has to answer its health check once started.
export const READY_SECONDS = 60
// How long a stopped worker has to exit before it is killed, past the
// graceful timeout it drains for.
export const EXIT_SECONDS = 10
// A path no route serves, so it costs a worker nothing and names no
// workspace a limit counts: a worker answers it 404 when the caller may go
// on, and refuses it as any request otherwise.
export const AUTH_PROBE = '/v1/-'
// What a request gets when no worker can answer it.
export const UNAVAILABLE = { detail: 'worker unavailable' }
// Headers that belong to one connection, which are not passed on.
export const HOP_BY_HOP: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])
