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

describe('audit regressions: subshell isolation, errexit propagation, prefix scoping', () => {
  it('subshell isolates readonly', async () => {
    const { ws } = makeIntegrationWS()
    try {
      expect(await run(ws, '(readonly X=1); X=2; echo $X')).toBe('2\n')
    } finally {
      await ws.close()
    }
  })

  it('subshell isolates arrays', async () => {
    const { ws } = makeIntegrationWS()
    try {
      expect(await run(ws, '(a=(1 2 3)); echo "${a[0]:-empty}"')).toBe('empty\n')
    } finally {
      await ws.close()
    }
  })

  it('subshell isolates shell options', async () => {
    const { ws } = makeIntegrationWS()
    try {
      expect(await run(ws, 'set -e; (set +e; true); echo continued')).toBe('continued\n')
    } finally {
      await ws.close()
    }
  })

  it('function prefix is restored after the call', async () => {
    const { ws } = makeIntegrationWS()
    try {
      const out = await run(ws, 'f() { echo "FOO=$FOO"; }; FOO=bar f; echo "after=$FOO"')
      expect(out).toBe('FOO=bar\nafter=\n')
    } finally {
      await ws.close()
    }
  })

  it('command prefix does not persist', async () => {
    const { ws } = makeIntegrationWS()
    try {
      const out = await run(ws, 'FOO=bar echo "FOO=$FOO"; echo "after=$FOO"')
      expect(out).toContain('after=\n')
    } finally {
      await ws.close()
    }
  })

  it('readonly blocks prefix assignment', async () => {
    const { ws } = makeIntegrationWS()
    try {
      const out = await run(ws, 'readonly X=1; X=2 echo done; echo $X')
      expect(out.endsWith('1\n')).toBe(true)
    } finally {
      await ws.close()
    }
  })

  it('array in mixed string preserves data', async () => {
    const { ws } = makeIntegrationWS()
    try {
      const out = await run(ws, 'a=(1 2 3); echo "x${a[@]}y"')
      expect(out).toContain('x')
      expect(out).toContain('y')
      expect(out).toContain('1')
      expect(out).toContain('3')
    } finally {
      await ws.close()
    }
  })

  it('array single element with prefix and suffix', async () => {
    const { ws } = makeIntegrationWS()
    try {
      expect(await run(ws, 'a=(only); echo "x${a[@]}y"')).toBe('xonlyy\n')
    } finally {
      await ws.close()
    }
  })

  it('errexit inside subshell body', async () => {
    const { ws } = makeIntegrationWS()
    try {
      const out = await run(ws, 'set -e; (false; echo unreached); echo after')
      expect(out).not.toContain('unreached')
    } finally {
      await ws.close()
    }
  })

  it('errexit inside function body', async () => {
    const { ws } = makeIntegrationWS()
    try {
      const out = await run(ws, 'set -e; f() { false; echo unreached; }; f; echo after')
      expect(out).not.toContain('unreached')
    } finally {
      await ws.close()
    }
  })

  it('errexit inside compound group', async () => {
    const { ws } = makeIntegrationWS()
    try {
      const out = await run(ws, 'set -e; { false; echo unreached; }; echo after')
      expect(out).not.toContain('unreached')
    } finally {
      await ws.close()
    }
  })
})
