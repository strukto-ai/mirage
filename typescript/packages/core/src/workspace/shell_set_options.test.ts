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

describe('set -u (nounset)', () => {
  it('makes an unset variable fatal', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      const [code, out, err] = await runResult(ws, 'set -u; echo $zq1; echo after')
      expect(code).toBe(127)
      expect(out).toBe('')
      expect(err).toContain('zq1: unbound variable')
    } finally {
      await ws.close()
    }
  })

  it('makes a braced lookup fatal', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      const [code, , err] = await runResult(ws, 'set -u; echo ${zq2}')
      expect(code).toBe(127)
      expect(err).toContain('zq2: unbound variable')
    } finally {
      await ws.close()
    }
  })

  it('leaves the default operator safe', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      expect(await run(ws, 'set -u; echo ${zq3:-d}')).toBe('d\n')
    } finally {
      await ws.close()
    }
  })

  it('leaves an empty set variable safe', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      expect(await run(ws, 'set -u; ze1=; echo x${ze1}y')).toBe('xy\n')
    } finally {
      await ws.close()
    }
  })

  it('makes an unset positional fatal', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      const [code, , err] = await runResult(ws, 'set -u; echo $1')
      expect(code).toBe(127)
      expect(err).toContain('1: unbound variable')
    } finally {
      await ws.close()
    }
  })

  it('leaves specials safe', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      expect(await run(ws, 'set -u; echo ok $# $?')).toBe('ok 0 0\n')
    } finally {
      await ws.close()
    }
  })

  it('turns off with set +u', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      expect(await run(ws, 'set -u; set +u; echo x${zq4}y')).toBe('xy\n')
    } finally {
      await ws.close()
    }
  })
})

describe('set -f (noglob)', () => {
  it('keeps glob words literal', async () => {
    const { ws } = await makeIntegrationWS({ 'g1.txt': 'a\n' })
    try {
      expect(await run(ws, 'set -f; echo /data/*.txt')).toBe('/data/*.txt\n')
    } finally {
      await ws.close()
    }
  })

  it('restores globbing with set +f', async () => {
    const { ws } = await makeIntegrationWS({ 'g2.txt': 'a\n' })
    try {
      expect(await run(ws, 'set -f; set +f; echo /data/g2*.txt')).toBe('/data/g2.txt\n')
    } finally {
      await ws.close()
    }
  })

  it('keeps for-loop words literal', async () => {
    const { ws } = await makeIntegrationWS({ 'g3.txt': 'a\n' })
    try {
      expect(await run(ws, 'set -f; for f in /data/*.txt; do echo $f; done')).toBe('/data/*.txt\n')
    } finally {
      await ws.close()
    }
  })
})

describe('set -x (xtrace)', () => {
  it('traces commands to stderr', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      const [code, out, err] = await runResult(ws, 'set -x; echo hi')
      expect(code).toBe(0)
      expect(out).toBe('hi\n')
      expect(err).toBe('+ echo hi\n')
    } finally {
      await ws.close()
    }
  })

  it('shows expanded words and assignments', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      const [, out, err] = await runResult(ws, 'set -x; xv1=5; echo $xv1')
      expect(out).toBe('5\n')
      expect(err).toBe('+ xv1=5\n+ echo 5\n')
    } finally {
      await ws.close()
    }
  })

  it('quotes traced words with spaces', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      const [, , err] = await runResult(ws, "set -x; echo 'a b'")
      expect(err).toBe("+ echo 'a b'\n")
    } finally {
      await ws.close()
    }
  })

  it('does not trace the set itself', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      const [, , err] = await runResult(ws, 'set -x; set +x; echo hi')
      expect(err).toContain('+ set +x')
      expect(err).not.toContain('+ echo')
    } finally {
      await ws.close()
    }
  })
})
