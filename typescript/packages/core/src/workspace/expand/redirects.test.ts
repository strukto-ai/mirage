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
import { makeIntegrationWS, run, runResult } from '../fixtures/integration_fixture.ts'

describe('heredoc body expansion', () => {
  it('expands braced vars and command substitutions', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      const out = await run(ws, 'v=mirage\ncat <<END\nval=$v\nbrace=${v}\nsub=$(echo inner)\nEND')
      expect(out).toBe('val=mirage\nbrace=mirage\nsub=inner\n')
    } finally {
      await ws.close()
    }
  })

  it('evaluates $((...)) parsed as cmdsub-of-subshell', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      expect(await run(ws, 'cat <<END\nmath=$((2 + 3))\nEND')).toBe('math=5\n')
    } finally {
      await ws.close()
    }
  })

  it('evaluates arithmetic with a var ref', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      expect(await run(ws, 'v=3\ncat <<END\nx=$(($v + 2))\nEND')).toBe('x=5\n')
    } finally {
      await ws.close()
    }
  })

  it('expands undefined vars to empty', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      expect(await run(ws, 'cat <<END\n[$__undefined_var__]\nEND')).toBe('[]\n')
    } finally {
      await ws.close()
    }
  })

  it('keeps escaped dollars literal', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      expect(await run(ws, 'v=real\ncat <<END\nesc=\\$v exp=$v\nEND')).toBe('esc=$v exp=real\n')
    } finally {
      await ws.close()
    }
  })

  it('joins backslash-newline continuations', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      expect(await run(ws, 'cat <<END\nline \\\njoined\nEND')).toBe('line joined\n')
    } finally {
      await ws.close()
    }
  })

  it('quoted delimiter disables expansion', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      const out = await run(ws, "v=zzz\ncat <<'END'\nraw=$v\nsub=$(echo x)\nEND")
      expect(out).toBe('raw=$v\nsub=$(echo x)\n')
    } finally {
      await ws.close()
    }
  })

  it('partially quoted delimiter disables expansion', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      expect(await run(ws, "cat <<EN'D'\nmixed=$((1+1))\nEND\n")).toBe('mixed=$((1+1))\n')
    } finally {
      await ws.close()
    }
  })

  it('<<- strips tabs, not spaces', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      const out = await run(ws, 'cat <<-END\n\ttab-stripped\n   spaces-kept\nEND')
      expect(out).toBe('tab-stripped\n   spaces-kept\n')
    } finally {
      await ws.close()
    }
  })

  it('<<- strips tabs before expansions', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      expect(await run(ws, 'v=deep\ncat <<-END\n\t$v\n\t\tEND')).toBe('deep\n')
    } finally {
      await ws.close()
    }
  })

  it('feeds a pipeline', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      expect(await run(ws, 'cat <<END | tr a-z A-Z\nshout this\nEND')).toBe('SHOUT THIS\n')
    } finally {
      await ws.close()
    }
  })
})

describe('process substitution stdin redirect', () => {
  it('feeds inner stdout via < <(cmd)', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      expect(await run(ws, "sort < <(printf 'b\\na\\n')")).toBe('a\nb\n')
    } finally {
      await ws.close()
    }
  })

  it('counts lines via wc -l < <(cmd)', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      const [exit, out] = await runResult(ws, "wc -l < <(printf 'x\\ny\\n')")
      expect(exit).toBe(0)
      expect(out.trim()).toBe('2')
    } finally {
      await ws.close()
    }
  })
})

describe('process substitution output redirect', () => {
  it('errors loudly on > >(cmd)', async () => {
    const { ws } = await makeIntegrationWS()
    try {
      const [exit, out, err] = await runResult(ws, 'echo hi > >(cat)')
      expect(exit).toBe(2)
      expect(out).toBe('')
      expect(err).toContain('unsupported: process substitution')
    } finally {
      await ws.close()
    }
  })
})
