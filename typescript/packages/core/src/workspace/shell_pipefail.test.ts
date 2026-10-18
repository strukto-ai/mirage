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
import { makeIntegrationWS, run } from '../../tests/workspace/fixtures/integration_fixture.ts'

describe('set -o pipefail', () => {
  it('off by default', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      expect(await run(ws, 'false | true; echo $?')).toBe('0\n')
    } finally {
      await ws.close()
    }
  })

  it('propagates failure when on', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      expect(await run(ws, 'set -o pipefail; false | true; echo $?')).toBe('1\n')
    } finally {
      await ws.close()
    }
  })

  it('zero when all pass', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      expect(await run(ws, 'set -o pipefail; true | true; echo $?')).toBe('0\n')
    } finally {
      await ws.close()
    }
  })

  it('disabled via +o', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      expect(await run(ws, 'set -o pipefail; set +o pipefail; false | true; echo $?')).toBe('0\n')
    } finally {
      await ws.close()
    }
  })

  it('rightmost failure wins', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      expect(await run(ws, 'set -o pipefail; false | false | true; echo $?')).toBe('1\n')
    } finally {
      await ws.close()
    }
  })
})
