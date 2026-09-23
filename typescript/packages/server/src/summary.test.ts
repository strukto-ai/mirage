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
import type { VFS } from '@struktoai/mirage-core/vfs/base'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { MountMode } from '@struktoai/mirage-core/types'
import { Workspace } from '@struktoai/mirage-node'
import { WorkspaceRegistry } from './registry.ts'
import { describeVfs, makeBrief, makeDetail } from './summary.ts'

describe('summary', () => {
  it('makeBrief reports prefix count + workspace mode', () => {
    const r = new WorkspaceRegistry()
    const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
    const entry = r.add(ws, 'ws-x')
    const brief = makeBrief(entry)
    expect(brief.id).toBe('ws-x')
    expect(brief.mode).toBe('write')
    // /data/ plus the empty root anchor the workspace adds at / (no user /
    // mount). /dev and the history view are auto-prefixes and filtered out.
    expect(brief.mountCount).toBe(2)
  })

  it('makeDetail emits mounts + sessions', async () => {
    const r = new WorkspaceRegistry()
    const ws = new Workspace({ '/data/': new RAMVFS() }, { mode: MountMode.WRITE })
    const entry = r.add(ws, 'ws-y')
    const detail = await makeDetail(entry)
    // /data/ plus the empty root anchor at / (no user / mount was given).
    expect(detail.mounts.map((m) => m.prefix).sort()).toEqual(['/', '/data/'])
    const dataMount = detail.mounts.find((m) => m.prefix === '/data/')
    expect(dataMount?.vfs).toBe('ram')
  })
})

const ASTRAL = '\u{10400}'

// `RAMVFS.prompt` is inferred as its own string literal, so a subclass
// cannot widen it; the description only ever reads the field.
function promptVfs(prompt: string): VFS {
  return Object.assign(new RAMVFS(), { prompt })
}

describe('describeVfs', () => {
  it('returns a short prompt whole', () => {
    expect(describeVfs(promptVfs('hello'))).toBe('hello')
    expect(describeVfs(promptVfs(''))).toBe('')
  })

  it('measures the budget in code points, matching python', () => {
    // 40 ascii plus 45 Deseret letters is 85 code points and 130 UTF-16
    // units, so measuring `String.length` ellipsized a prompt python leaves
    // whole -- and the cut landed inside the 40th surrogate pair.
    const prompt = 'a'.repeat(40) + ASTRAL.repeat(45)
    expect(describeVfs(promptVfs(prompt))).toBe(prompt)
  })

  it('ellipsizes on a code-point boundary', () => {
    const out = describeVfs(promptVfs(ASTRAL.repeat(130)))
    expect(out).toBe(ASTRAL.repeat(119) + '\u2026')
    expect(Array.from(out)).toHaveLength(120)
    // A half pair is a legal `String` value and only becomes U+FFFD once the
    // bytes are written, so the check has to go through UTF-8.
    expect(new TextDecoder('utf-8').decode(new TextEncoder().encode(out))).not.toContain('\uFFFD')
  })

  it('drops trailing whitespace before the ellipsis', () => {
    const prompt = 'x'.repeat(118) + '  ' + 'y'.repeat(10)
    expect(describeVfs(promptVfs(prompt))).toBe('x'.repeat(118) + '\u2026')
  })
})
