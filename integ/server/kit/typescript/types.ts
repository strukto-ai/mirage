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

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

export type TenantKind = 'none' | 'pk-column' | 'root-entity'

export type MintSharing = 'global' | 'per-kind'

export interface ResetRequest {
  run: string
  epoch?: string
  tenants: string[]
  fixture: string
  extras: Record<string, JsonValue>
}

export interface SeedReport {
  tenant: string
  rows: Record<string, number>
}

export interface ResetResponse {
  ok: boolean
  run: string
  epoch: string | null
  // Whether the named tenants were cleared in place rather than the whole run
  // file recreated. Reported because it is the difference between a server two
  // hosts may share and one they may not, and a caller that cannot see which it
  // got debugs the resulting cross-host flake blind.
  scoped: boolean
  tenants: string[]
  seeded: SeedReport[]
}

export interface Reply {
  status: number
  body?: JsonValue | Buffer
  // A list sends the header once per value, as Set-Cookie needs.
  headers?: Record<string, string | string[]>
}

export interface RouteMatch {
  params: Record<string, string>
  query: URLSearchParams
  body: Buffer
  run: string
  tenant: string
  // The `/_run/<id>` the request arrived under, or '' when it arrived
  // unscoped. Two different things are wanted from the path and conflating
  // them is what broke: a route lookup, an error message and a row key all
  // want the path WITHOUT it (which is what ctx.url.pathname now is), while a
  // URL the fake mints for the client to come BACK to needs it, or the client
  // follows the link into another run.
  runPrefix: string
}

export type Handler = (m: RouteMatch) => Promise<Reply> | Reply

export interface RouteSpec {
  method: string
  pattern: RegExp
  params: string[]
  handler: Handler
  write?: boolean
}

export interface Announce {
  token: string
  url: string
}
