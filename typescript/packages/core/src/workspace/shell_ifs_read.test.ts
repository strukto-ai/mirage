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

describe('IFS / read interaction and inline VAR=val cmd prefix', () => {
  it('IFS=, splits read', async () => {
    const { ws } = makeIntegrationWS()
    try {
      expect(await run(ws, 'IFS=, read a b c <<< "1,2,3"; echo "$a:$b:$c"')).toBe('1:2:3\n')
    } finally {
      await ws.close()
    }
  })

  it('IFS default whitespace', async () => {
    const { ws } = makeIntegrationWS()
    try {
      expect(await run(ws, 'echo "1 2 3" | { read a b c; echo "$a:$b:$c"; }')).toBe('1:2:3\n')
    } finally {
      await ws.close()
    }
  })

  it('IFS prefix does not persist', async () => {
    const { ws } = makeIntegrationWS()
    try {
      const out = await run(ws, 'IFS=, read a b c <<< "1,2,3"; echo "${IFS-default}"')
      expect(out).not.toContain(',')
    } finally {
      await ws.close()
    }
  })

  it('env prefix to command', async () => {
    const { ws } = makeIntegrationWS()
    try {
      const out = await run(ws, "FOO=bar bash -c 'echo $FOO'")
      expect(out).toContain('bar')
    } finally {
      await ws.close()
    }
  })

  it('env prefix after word expansion', async () => {
    const { ws } = makeIntegrationWS()
    try {
      const out = await run(ws, 'FOO=bar bash -c "echo [$FOO]"')
      expect(out).toBe('[]\n')
    } finally {
      await ws.close()
    }
  })

  it('IFS=: splits read', async () => {
    const { ws } = makeIntegrationWS()
    try {
      expect(await run(ws, 'IFS=: read a b c <<< "x:y:z"; echo "$a-$b-$c"')).toBe('x-y-z\n')
    } finally {
      await ws.close()
    }
  })

  it('read trims trailing default-IFS whitespace', async () => {
    const { ws } = makeIntegrationWS()
    try {
      expect(await run(ws, 'read a b <<< "  x  y  "; echo "[$b]"')).toBe('[y]\n')
    } finally {
      await ws.close()
    }
  })

  it('read single var keeps inner whitespace', async () => {
    const { ws } = makeIntegrationWS()
    try {
      expect(await run(ws, 'read a <<< "  x  y  "; echo "[$a]"')).toBe('[x  y]\n')
    } finally {
      await ws.close()
    }
  })

  it('read keeps trailing non-whitespace IFS chars', async () => {
    const { ws } = makeIntegrationWS()
    try {
      expect(await run(ws, 'IFS=: read a b <<< "x:y:z:"; echo "[$b]"')).toBe('[y:z:]\n')
    } finally {
      await ws.close()
    }
  })

  it('read single var with non-whitespace IFS stays intact', async () => {
    const { ws } = makeIntegrationWS()
    try {
      expect(await run(ws, 'IFS=: read a <<< ":x:"; echo "[$a]"')).toBe('[:x:]\n')
    } finally {
      await ws.close()
    }
  })

  it('read rebinds stdin on the next line', async () => {
    const { ws } = makeIntegrationWS()
    try {
      await run(ws, 'read za <<< "first"')
      expect(await run(ws, 'read zb <<< "second"; echo "$zb"')).toBe('second\n')
    } finally {
      await ws.close()
    }
  })

  it('read from a pipe works after a previous line', async () => {
    const { ws } = makeIntegrationWS()
    try {
      await run(ws, "printf 'a\\n' | { read z1; echo $z1; }")
      expect(await run(ws, "printf 'b\\n' | { read z2; echo $z2; }")).toBe('b\n')
    } finally {
      await ws.close()
    }
  })
})
