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
import {
  makeIntegrationWS,
  run,
  runExit,
} from '../../tests/workspace/fixtures/integration_fixture.ts'

describe('readonly', () => {
  it('blocks reassignment', async () => {
    const { ws } = makeIntegrationWS()
    try {
      // A bare assignment to a readonly variable is fatal in
      // non-interactive bash: the rest of the line is abandoned.
      const code = await runExit(ws, 'readonly X=1; X=2; echo $X')
      expect(code).toBe(1)
      expect(await run(ws, 'echo $X')).toBe('1\n')
    } finally {
      await ws.close()
    }
  })

  it('blocks unset', async () => {
    const { ws } = makeIntegrationWS()
    try {
      expect(await run(ws, 'readonly X=5; unset X; echo $X')).toBe('5\n')
    } finally {
      await ws.close()
    }
  })

  it('declare -r blocks reassignment', async () => {
    const { ws } = makeIntegrationWS()
    try {
      const code = await runExit(ws, 'declare -r Y=5; Y=10; echo $Y')
      expect(code).toBe(1)
      expect(await run(ws, 'echo $Y')).toBe('5\n')
    } finally {
      await ws.close()
    }
  })

  it('emits non-zero exit on reassignment', async () => {
    const { ws } = makeIntegrationWS()
    try {
      const code = await runExit(ws, 'readonly X=1; X=2')
      expect(code).not.toBe(0)
    } finally {
      await ws.close()
    }
  })

  it('first assignment succeeds', async () => {
    const { ws } = makeIntegrationWS()
    try {
      expect(await run(ws, 'readonly X=hello; echo $X')).toBe('hello\n')
    } finally {
      await ws.close()
    }
  })
})
