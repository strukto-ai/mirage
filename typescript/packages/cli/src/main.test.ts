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
      [
        'api',
        'codex-exec',
        'cli',
        'context',
        'daemon',
        'login',
        'logout',
        'mcp',
        'policy',
        'rpc',
        'runtime',
        'shell',
        'ssh-proxy',
        'template',
        'vfs',
        'whoami',
        'workspace',
      ].sort(),
    )
  })

  it('workspace subcommand has the lifecycle commands', () => {
    const program = buildProgram()
    const ws = program.commands.find((c) => c.name() === 'workspace')
    expect(ws).toBeDefined()
    const sub = ws?.commands.map((c) => c.name()).sort() ?? []
    expect(sub).toEqual(
      [
        'allow',
        'clone',
        'create',
        'delete',
        'deny',
        'get',
        'logs',
        'list',
        'list-asks',
        'list-jobs',
        'list-lines',
        'list-processes',
        'load',
        'session',
        'set-profile',
        'shell',
        'snapshot',
        'start',
        'stop',
        'tools',
        'use',
        'vfs',
        'vfs-md',
        'skill-md',
      ].sort(),
    )
  })

  it('daemon subcommand has its lifecycle and config', () => {
    const program = buildProgram()
    const d = program.commands.find((c) => c.name() === 'daemon')
    const sub = d?.commands.map((c) => c.name()).sort() ?? []
    expect(sub).toEqual(['config', 'kill', 'restart', 'status', 'stop'].sort())
  })
})
