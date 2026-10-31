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

import type { IncomingHttpHeaders } from 'node:http'

/** What a worker is: a process of its own, or a thread of the daemon's. */
export enum WorkerType {
  Process = 'process',
  Thread = 'thread',
}

export interface WorkerOptions {
  index: number
  /** The Unix socket it serves on. */
  socket: string
  /** The daemon's entry, which runs as the worker. */
  entry: string
  /**
   * Node's flags for the worker; undefined takes the daemon's. A thread
   * cannot take V8 flags such as `--max-old-space-size` here.
   */
  execArgv?: readonly string[] | undefined
  env: Record<string, string | undefined>
  /** A Host the worker accepts, for its health check. */
  host: string
}

export interface WorkerPoolOptions {
  count: number
  type: WorkerType
  /** The daemon's entry, which each worker runs. */
  entry: string
  /**
   * Node's flags for each worker; undefined takes the daemon's. A thread
   * cannot take V8 flags such as `--max-old-space-size` here.
   */
  execArgv?: readonly string[]
  env: Record<string, string | undefined>
  /** A Host the workers accept, for their health checks. */
  host: string
  /** How long a stopped worker drains its lines for. */
  gracefulTimeout: number
}

/** What a worker answered, whole. */
export interface Answer {
  status: number
  headers: IncomingHttpHeaders
  body: Buffer
}

/** A request's body as far as it was read, and whether more follows. */
export interface Peeked {
  head: Buffer
  more: boolean
  /** The workspace id the body names, if it names one. */
  id: string | undefined
  /** Whether the body passed `MAX_REQUEST_PART` before naming its id. */
  lost: boolean
  /** Whether a multipart load's `request` part comes twice in a row. */
  twice: boolean
}
