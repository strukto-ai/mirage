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

import type { ErrnoCodes, FSHost } from './fs/types.ts'

type SockOp = (...args: never[]) => unknown

interface SockOps {
  createPeer: SockOp
  listen: SockOp
}

export interface NetworkHost {
  SOCKFS?: { websocket_sock_ops?: SockOps }
}

/**
 * Make Emscripten's socket layer refuse instead of opening connections.
 *
 * Emscripten's SOCKFS turns a guest `connect`, `sendto` and `listen` into
 * a real WebSocket client or server: `ws://host:port` through the `ws`
 * package under Node, the page's `WebSocket` in a browser. So
 * `socket.create_connection` or `urllib.request.urlopen` would put a
 * handshake on a host port and leave the guest a socket that looks
 * connected and then times out. The two sock ops that build those
 * objects now refuse, so ordinary socket and urllib code fails fast
 * instead of opening a host connection: `connect` and `sendto` raise
 * ENETUNREACH ("Network unreachable"), and `listen` raises ENETDOWN
 * ("Network is down"), as do a UDP `bind` and `socket.socketpair()`,
 * which listen underneath. `socket()`, a TCP `bind`, `getaddrinfo`
 * (Emscripten's offline resolver) and socket options keep working,
 * since none of them builds a WebSocket. An initializer that calls
 * `useNodeSockFS()` replaces SOCKFS's socket factory and so installs
 * real sockets, as it makes the runtime's reach 'process'.
 *
 * @param host The Emscripten module (`pyodide._module`).
 * @param fs The module's FS, whose ErrnoError the sock ops throw.
 * @param codes The module's errno table.
 */
export function sealNetwork(host: NetworkHost, fs: FSHost, codes: ErrnoCodes): void {
  const ops = host.SOCKFS?.websocket_sock_ops
  if (ops === undefined) {
    throw new Error('pyodide: SOCKFS not found; cannot seal the guest sockets')
  }
  const unreachable = codes.ENETUNREACH
  const down = codes.ENETDOWN
  if (unreachable === undefined || down === undefined) {
    throw new Error('pyodide: ERRNO_CODES lacks ENETUNREACH/ENETDOWN')
  }
  ops.createPeer = () => {
    throw new fs.ErrnoError(unreachable)
  }
  ops.listen = () => {
    throw new fs.ErrnoError(down)
  }
}
