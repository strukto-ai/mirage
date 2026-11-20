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

import type { SSHConfig } from './config.ts'

/** A running SSH endpoint, as the daemon holds it. */
export interface SSHListener {
  readonly port: number
  close(): Promise<void>
}

/** The daemon's SSH endpoint: its config, and the listener once it is open. */
export interface SSHEndpoint {
  readonly config: SSHConfig
  listener: SSHListener | null
}

export interface Endpoint {
  address: string
  port: number
}

/** What the server knows about one channel's login. */
export interface ChannelRequest {
  username: string
  /** The login key's `mirage-profile` values; empty when it has none. */
  profile: readonly string[]
  /** The login key's `mirage-account` values; empty when it has none. */
  account: readonly string[]
  command: string | null
  term: string | null
  /** The client's `TRACEPARENT` and `TRACESTATE`, as it set them. */
  env: Readonly<Record<string, string>>
  peer: Endpoint | null
  local: Endpoint | null
  /** Aborts when the connection closes, however its channels stand. */
  gone: AbortSignal
}

/** Who a login is: the workspace it names and its key's options. */
export type Login = Pick<ChannelRequest, 'username' | 'profile' | 'account'>
