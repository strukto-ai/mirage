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

export const REQUESTS_PATH = '/_kit/requests'

// One request as GET and DELETE report it. `route` is the path a route
// DECLARES (`/2.0/folders/:folder_id/items`), the name a fault plan uses, so
// a caller counts every request a route served without knowing the ids;
// `path` is the one the client sent, with the run prefix stripped and no
// query. A type rather than an interface so it is a JsonValue as it is.
export type RequestReport = {
  method: string
  route: string
  path: string
}

// The requests one TENANT made, in the order they arrived, kept only between
// a start and a stop: a battery makes thousands a run and nothing reads them,
// so a tenant that never asked keeps none. They live in TenantState beside
// the fault plans for the reason those do: one host's requests must not show
// up in another's count, and a /reset of a tenant forgets them with the rest
// of its world. A faulted request is kept too, since the client did make it.
export class Requests {
  private recording = false
  private readonly kept: RequestReport[] = []

  // Starting again empties what an earlier start kept.
  start(): void {
    this.recording = true
    this.kept.length = 0
  }

  note(method: string, route: string, path: string): void {
    if (this.recording) this.kept.push({ method, route, path })
  }

  report(): RequestReport[] {
    return this.kept.map((request) => ({ ...request }))
  }

  stop(): void {
    this.recording = false
    this.kept.length = 0
  }
}
