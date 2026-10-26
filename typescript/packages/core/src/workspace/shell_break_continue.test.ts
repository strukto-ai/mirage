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

describe('break/continue levels', () => {
  it('break exits the inner loop only', async () => {
    const { ws } = makeIntegrationWS()
    try {
      expect(await run(ws, 'for i in 1 2; do for j in a b; do echo $i$j; break; done; done')).toBe(
        '1a\n2a\n',
      )
    } finally {
      await ws.close()
    }
  })

  it('break 2 exits both loops', async () => {
    const { ws } = makeIntegrationWS()
    try {
      expect(
        await run(ws, 'for i in 1 2; do for j in a b; do echo $i$j; break 2; done; done'),
      ).toBe('1a\n')
    } finally {
      await ws.close()
    }
  })

  it('break beyond the depth breaks all loops', async () => {
    const { ws } = makeIntegrationWS()
    try {
      expect(
        await run(ws, 'for i in 1 2; do for j in a b; do echo $i$j; break 9; done; done'),
      ).toBe('1a\n')
    } finally {
      await ws.close()
    }
  })

  it('continue 2 continues the outer loop', async () => {
    const { ws } = makeIntegrationWS()
    try {
      expect(
        await run(
          ws,
          'for i in 1 2; do for j in a b; do ' +
            'if [ $j = a ]; then continue 2; fi; echo $i$j; done; echo inner:$i; done',
        ),
      ).toBe('')
    } finally {
      await ws.close()
    }
  })

  it('plain continue skips one iteration', async () => {
    const { ws } = makeIntegrationWS()
    try {
      expect(
        await run(ws, 'for i in 1 2 3; do if [ $i = 2 ]; then continue; fi; echo $i; done'),
      ).toBe('1\n3\n')
    } finally {
      await ws.close()
    }
  })

  it('break 2 escapes a while inside a for', async () => {
    const { ws } = makeIntegrationWS()
    try {
      expect(
        await run(
          ws,
          'for i in 1 2; do n=0; while [ $n -lt 3 ]; do n=$((n+1)); echo $i:$n; break 2; done; done',
        ),
      ).toBe('1:1\n')
    } finally {
      await ws.close()
    }
  })
})
