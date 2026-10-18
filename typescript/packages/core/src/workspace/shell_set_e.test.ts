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

describe('set -e (errexit)', () => {
  it('exits on failure', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      const out = await run(ws, 'set -e; false; echo unreached')
      expect(out).not.toContain('unreached')
    } finally {
      await ws.close()
    }
  })

  it('continues when command passes', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      expect(await run(ws, 'set -e; true; echo ok')).toBe('ok\n')
    } finally {
      await ws.close()
    }
  })

  it('allows || chain', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      expect(await run(ws, 'set -e; false || echo recovered; echo done')).toBe('recovered\ndone\n')
    } finally {
      await ws.close()
    }
  })

  it('allows && chain to skip', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      expect(await run(ws, 'set -e; false && echo skipped; echo done')).toBe('done\n')
    } finally {
      await ws.close()
    }
  })

  it('allows if condition', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      expect(await run(ws, 'set -e; if false; then echo a; else echo b; fi')).toBe('b\n')
    } finally {
      await ws.close()
    }
  })

  it('allows while condition', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      expect(
        await run(ws, 'set -e; X=0; while [ $X -lt 2 ]; do echo $X; X=$((X+1)); done; echo done'),
      ).toBe('0\n1\ndone\n')
    } finally {
      await ws.close()
    }
  })

  it('set +e disables', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      expect(await run(ws, 'set -e; set +e; false; echo ok')).toBe('ok\n')
    } finally {
      await ws.close()
    }
  })

  it('set -o errexit alias', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      const out = await run(ws, 'set -o errexit; false; echo unreached')
      expect(out).not.toContain('unreached')
    } finally {
      await ws.close()
    }
  })

  it('does not trip on pipeline failure (default)', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      expect(await run(ws, 'set -e; false | true; echo after')).toBe('after\n')
    } finally {
      await ws.close()
    }
  })
  it('exits on && list-tail failure', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      const out = await run(ws, 'set -e; true && false; echo unreached')
      expect(out).not.toContain('unreached')
    } finally {
      await ws.close()
    }
  })

  it('exits on || list-tail failure', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      const out = await run(ws, 'set -e; false || false; echo unreached')
      expect(out).not.toContain('unreached')
    } finally {
      await ws.close()
    }
  })

  it('negated command is immune', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      expect(await run(ws, 'set -e; ! true; echo ok')).toBe('ok\n')
    } finally {
      await ws.close()
    }
  })

  it('negated pipeline is immune', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      expect(await run(ws, 'set -e; ! true | true; echo ok')).toBe('ok\n')
    } finally {
      await ws.close()
    }
  })

  it('negated tail of an && list is immune', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      expect(await run(ws, 'set -e; true && ! true; echo ok')).toBe('ok\n')
    } finally {
      await ws.close()
    }
  })
})
