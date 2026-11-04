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

// The parts of the Workers runtime this package reaches past the web
// standard: a WebSocket a Worker accepts itself, answered with a 101 that
// carries the client end, and the TCP API the redis mount opens its socket
// with.
declare class WebSocketPair {
  0: WebSocket
  1: WebSocket
}

interface WebSocket {
  accept(): void
}

interface ResponseInit {
  webSocket?: WebSocket | null
}

declare module 'cloudflare:sockets' {
  export function connect(
    address: { hostname: string; port: number },
    options?: { secureTransport?: 'off' | 'on' | 'starttls'; allowHalfOpen?: boolean },
  ): {
    readonly readable: ReadableStream<Uint8Array>
    readonly writable: WritableStream<Uint8Array>
    readonly opened: Promise<unknown>
    readonly closed: Promise<void>
    close(): Promise<void>
  }
}
