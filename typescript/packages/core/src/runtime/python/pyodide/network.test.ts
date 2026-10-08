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

import { describe, expect, it } from 'vitest'
import { sealNetwork } from './network.ts'

class FakeErrnoError extends Error {
  constructor(readonly errno: number) {
    super(`errno ${String(errno)}`)
  }
}

const FS = { ErrnoError: FakeErrnoError }
const CODES = { ENETUNREACH: 40, ENETDOWN: 38 }

// What the guest reads through a running Pyodide is pinned by
// integ/runtime/pyodide/network.json.
describe('sealNetwork', () => {
  it('makes the peer and server factories refuse with ENETUNREACH and ENETDOWN', () => {
    const ops = { createPeer: () => 'peer', listen: () => 'server' }
    sealNetwork({ SOCKFS: { websocket_sock_ops: ops } }, FS, CODES)
    expect(() => ops.createPeer()).toThrow(expect.objectContaining({ errno: 40 }))
    expect(() => ops.listen()).toThrow(expect.objectContaining({ errno: 38 }))
  })

  it('fails loud when the module has no SOCKFS to seal', () => {
    expect(() => {
      sealNetwork({}, FS, CODES)
    }).toThrow(/SOCKFS not found/)
  })
})
