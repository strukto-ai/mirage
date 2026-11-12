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

/** What an exec starts with: the part of workerd's `ContainerExecOptions` this provider sets. */
export interface ExecOptions {
  env?: Record<string, string>
  stdin?: 'pipe'
  stdout?: 'pipe'
  stderr?: 'pipe'
}

/** A process an exec started: the part of workerd's `ExecProcess` this provider uses. */
export interface ExecProcess {
  readonly stdin: WritableStream<Uint8Array> | null
  readonly stdout: ReadableStream<Uint8Array> | null
  readonly stderr: ReadableStream<Uint8Array> | null
  readonly exitCode: Promise<number>
  kill(signal?: number): void
}

/**
 * A Durable Object's container: the part of workerd's `Container` this
 * provider drives, so `ctx.container` is one as it is.
 */
export interface Container {
  exec(cmd: string[], options?: ExecOptions): Promise<ExecProcess>
  /** Settles when the container exits, rejecting when it exits with an error. */
  monitor(): Promise<void>
}

/** What a client sends first on a relay socket: the token and, on an exec, its command. */
export interface RelayRequest {
  readonly token: string
  readonly argv?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
}

/**
 * What a relay sends as text. On an exec: `started` once the container
 * took it, or `stopped` when it refused; then `closed` as each output
 * stream ends and `exit` with the status. On a monitor: `exited` once the
 * container has, with its error or null. `refused` answers a bad token,
 * and `alive` keeps a quiet socket open.
 */
export type RelayEvent =
  | { readonly started: true }
  | { readonly stopped: string }
  | { readonly closed: 'stdout' | 'stderr' }
  | { readonly exit: number }
  | { readonly exited: string | null }
  | { readonly refused: string }
  | { readonly alive: true }

/** What a client sends as text after its request: the end of stdin, or a signal. */
export type RelayControl = { readonly eof: true } | { readonly kill: number }

/** The part of a WebSocket both ends of a relay use: a browser's, Node's or workerd's. */
export interface RelaySocket {
  send(data: string | Uint8Array<ArrayBuffer>): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void
  addEventListener(type: 'close' | 'error', listener: () => void): void
}
