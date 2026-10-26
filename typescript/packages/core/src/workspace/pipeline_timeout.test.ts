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
import { RAMVFS } from '../vfs/ram/ram.ts'
import { MountMode } from '../types.ts'
import { Workspace } from './workspace/workspace.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function* slowStdin(): AsyncGenerator<Uint8Array> {
  for (;;) {
    await new Promise((r) => setTimeout(r, 10))
    yield ENC.encode('x'.repeat(1024))
  }
}

function buildWs(): Workspace {
  const ram = new RAMVFS()
  return new Workspace({ '/data': ram }, { mode: MountMode.WRITE })
}

describe('pipeline timeout', () => {
  it('bounds a slow final stage', async () => {
    const ws = buildWs()
    ws.getSession(ws.defaultSessionId).pipelineTimeoutSeconds = 0.1
    try {
      const r = await ws.shell('cat | cat', { stdin: slowStdin() })
      expect(r.exitCode).toBe(124)
      expect(DEC.decode(r.stderr)).toContain('pipeline: timed out after 0.1s')
    } finally {
      await ws.close()
    }
  })

  it('is unbounded without a budget', async () => {
    const ws = buildWs()
    try {
      const r = await ws.shell('cat | cat', { stdin: ENC.encode('hi\n') })
      expect(r.exitCode).toBe(0)
      expect(DEC.decode(r.stdout)).toBe('hi\n')
    } finally {
      await ws.close()
    }
  })
})
