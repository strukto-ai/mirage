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
  runResult,
} from '../../tests/workspace/fixtures/integration_fixture.ts'

const SELECT_CMD = 'select x in aa bb; do echo got:$x; break; done'

describe('select', () => {
  it('picks the choice read from stdin', async () => {
    const { ws } = makeIntegrationWS()
    try {
      const [code, out, err] = await runResult(ws, `printf '2\\n' | ${SELECT_CMD}`)
      expect(code).toBe(0)
      expect(out).toBe('got:bb\n')
      expect(err).toBe('1) aa\n2) bb\n#? ')
    } finally {
      await ws.close()
    }
  })

  it('sets the variable empty for an invalid choice', async () => {
    const { ws } = makeIntegrationWS()
    try {
      expect(
        await run(ws, "printf '9\\n' | select x in aa bb; do echo got:${x:-none}; break; done"),
      ).toBe('got:none\n')
    } finally {
      await ws.close()
    }
  })

  it('keeps the raw reply in REPLY', async () => {
    const { ws } = makeIntegrationWS()
    try {
      expect(
        await run(ws, "printf 'zz\\n' | select x in aa bb; do echo r:$REPLY; break; done"),
      ).toBe('r:zz\n')
    } finally {
      await ws.close()
    }
  })

  it('redisplays the menu on an empty line', async () => {
    const { ws } = makeIntegrationWS()
    try {
      const [, out, err] = await runResult(ws, `printf '\\n2\\n' | ${SELECT_CMD}`)
      expect(out).toBe('got:bb\n')
      expect(err).toBe('1) aa\n2) bb\n#? 1) aa\n2) bb\n#? ')
    } finally {
      await ws.close()
    }
  })

  it('ends the loop at EOF', async () => {
    const { ws } = makeIntegrationWS()
    try {
      // bash terminates the prompt line with a newline at EOF.
      const [code, out, err] = await runResult(
        ws,
        "printf '' | select x in aa bb; do echo body; done; echo after",
      )
      expect(code).toBe(0)
      expect(out).toBe('\nafter\n')
      expect(err).toBe('1) aa\n2) bb\n#? ')
    } finally {
      await ws.close()
    }
  })

  it('loops until break', async () => {
    const { ws } = makeIntegrationWS()
    try {
      expect(
        await run(
          ws,
          "printf '1\\n2\\n' | select x in aa bb; do echo got:$x; " +
            'if [ $x = bb ]; then break; fi; done',
        ),
      ).toBe('got:aa\ngot:bb\n')
    } finally {
      await ws.close()
    }
  })
})
