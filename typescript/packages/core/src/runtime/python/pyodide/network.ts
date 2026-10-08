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

type SockOps = Record<'createPeer' | 'listen', (...args: never[]) => unknown>

export interface NetworkHost {
  SOCKFS?: { websocket_sock_ops?: SockOps }
}

/**
 * Make Emscripten's socket layer refuse instead of opening connections.
 *
 * SOCKFS implements guest sockets with host WebSockets. Refuse its peer and
 * server factories so connect/sendto raise ENETUNREACH and listen/UDP bind/
 * socketpair raise ENETDOWN. Socket creation, TCP bind, the offline resolver
 * and socket options still work. A process runtime's useNodeSockFS() replaces
 * this factory with real sockets.
 *
 * @param host The Emscripten module (`pyodide._module`).
 * @param fs The module's FS, whose ErrnoError the sock ops throw.
 * @param codes The module's errno table.
 */
export function sealNetwork(
  host: NetworkHost,
  fs: Pick<FSHost, 'ErrnoError'>,
  codes: Pick<ErrnoCodes, 'ENETUNREACH' | 'ENETDOWN'>,
): void {
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
