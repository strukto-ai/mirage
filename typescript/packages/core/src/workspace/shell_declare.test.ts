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

describe('declare/typeset scoping', () => {
  it('assigns at top level', async () => {
    const { ws } = makeIntegrationWS()
    try {
      expect(await run(ws, 'declare zd1=5; echo $zd1')).toBe('5\n')
    } finally {
      await ws.close()
    }
  })

  it('is local inside a function', async () => {
    const { ws } = makeIntegrationWS()
    try {
      expect(await run(ws, 'zf1() { declare dz=in; echo $dz; }; zf1; echo ${dz:-unset}')).toBe(
        'in\nunset\n',
      )
    } finally {
      await ws.close()
    }
  })

  it('typeset is local inside a function', async () => {
    const { ws } = makeIntegrationWS()
    try {
      expect(await run(ws, 'zf2() { typeset tz=in; echo $tz; }; zf2; echo ${tz:-unset}')).toBe(
        'in\nunset\n',
      )
    } finally {
      await ws.close()
    }
  })

  it('shadows a global inside a function', async () => {
    const { ws } = makeIntegrationWS()
    try {
      expect(await run(ws, 'gv=g; zf3() { declare gv=l; echo $gv; }; zf3; echo $gv')).toBe('l\ng\n')
    } finally {
      await ws.close()
    }
  })
})
