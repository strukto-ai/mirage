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
import { makeIntegrationWS, run, runExit, runResult } from './fixtures/integration_fixture.ts'

async function withWS(
  fn: (ws: Awaited<ReturnType<typeof makeIntegrationWS>>['ws']) => Promise<void>,
): Promise<void> {
  const { ws } = await makeIntegrationWS()
  try {
    await fn(ws)
  } finally {
    await ws.close()
  }
}

describe('exit builtin', () => {
  it('stops remaining statements', async () => {
    await withWS(async (ws) => {
      expect(await runResult(ws, 'exit 3; echo hi')).toEqual([3, '', ''])
    })
  })

  it('keeps output of earlier statements', async () => {
    await withWS(async (ws) => {
      expect(await runResult(ws, 'echo a; exit 3; echo b')).toEqual([3, 'a\n', ''])
    })
  })

  it('keeps left output across &&', async () => {
    await withWS(async (ws) => {
      expect(await runResult(ws, 'echo a && exit 3')).toEqual([3, 'a\n', ''])
    })
  })

  it('uses last exit code without an argument', async () => {
    await withWS(async (ws) => {
      expect(await runExit(ws, 'false; exit')).toBe(1)
    })
  })

  it('is contained by a subshell', async () => {
    await withWS(async (ws) => {
      expect(await runResult(ws, '(exit 3); echo after code=$?')).toEqual([0, 'after code=3\n', ''])
    })
  })

  it('is contained by a pipeline segment', async () => {
    await withWS(async (ws) => {
      expect(await runResult(ws, 'exit 3 | cat; echo after code=$?')).toEqual([
        0,
        'after code=0\n',
        '',
      ])
    })
  })

  it('exits the shell from inside a function', async () => {
    await withWS(async (ws) => {
      expect(await runResult(ws, 'f(){ exit 5; echo infn; }; f; echo no')).toEqual([5, '', ''])
    })
  })

  it('errors with 2 on a non-numeric argument', async () => {
    await withWS(async (ws) => {
      expect(await runResult(ws, 'exit abc; echo hi')).toEqual([
        2,
        '',
        'exit: abc: numeric argument required\n',
      ])
    })
  })

  it('refuses to exit with too many arguments', async () => {
    await withWS(async (ws) => {
      expect(await runResult(ws, 'exit 1 2; echo after code=$?')).toEqual([
        0,
        'after code=1\n',
        'exit: too many arguments\n',
      ])
    })
  })

  it('wraps the status mod 256', async () => {
    await withWS(async (ws) => {
      expect(await runExit(ws, 'exit 300')).toBe(44)
      expect(await runExit(ws, 'exit -1')).toBe(255)
    })
  })
})

describe('special pid variables', () => {
  it('$$ expands to a positive integer', async () => {
    await withWS(async (ws) => {
      const out = await run(ws, 'echo $$')
      expect(Number(out.trim())).toBeGreaterThan(0)
    })
  })

  it('$! is empty without a background job', async () => {
    await withWS(async (ws) => {
      expect(await run(ws, 'echo [$!]')).toBe('[]\n')
    })
  })

  it('$! is the last background job id', async () => {
    await withWS(async (ws) => {
      expect(await run(ws, 'sleep 0.05 & echo bg=$!')).toBe('bg=1\n')
    })
  })

  it('wait $! succeeds', async () => {
    await withWS(async (ws) => {
      expect(await runResult(ws, 'sleep 0.05 & wait $!; echo waited=$?')).toEqual([
        0,
        'waited=0\n',
        '[1]\n',
      ])
    })
  })
})

describe('unsupported constructs', () => {
  it('reports a graceful error for C-style for', async () => {
    await withWS(async (ws) => {
      expect(await runResult(ws, 'for ((i=0;i<3;i++)); do echo $i; done')).toEqual([
        2,
        '',
        'mirage: unsupported shell construct: c_style_for_statement\n',
      ])
    })
  })
})
