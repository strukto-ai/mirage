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
import { buildProgram } from './main.ts'

describe('mirage CLI program', () => {
  it('registers expected subcommands', () => {
    const program = buildProgram()
    const names = program.commands.map((c) => c.name())
    expect(names.sort()).toEqual(
      ['config', 'daemon', 'execute', 'job', 'mcp', 'provision', 'session', 'workspace'].sort(),
    )
  })

  it('workspace subcommand has lifecycle + versioning commands', () => {
    const program = buildProgram()
    const ws = program.commands.find((c) => c.name() === 'workspace')
    expect(ws).toBeDefined()
    const sub = ws?.commands.map((c) => c.name()).sort() ?? []
    expect(sub).toEqual(
      [
        'branch',
        'checkout',
        'clone',
        'commit',
        'create',
        'delete',
        'diff',
        'get',
        'list',
        'load',
        'log',
        'snapshot',
      ].sort(),
    )
  })

  it('daemon subcommand has status/stop/restart/kill', () => {
    const program = buildProgram()
    const d = program.commands.find((c) => c.name() === 'daemon')
    const sub = d?.commands.map((c) => c.name()).sort() ?? []
    expect(sub).toEqual(['kill', 'restart', 'status', 'stop'].sort())
  })
})
