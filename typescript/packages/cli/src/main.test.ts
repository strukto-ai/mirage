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

import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildProgram } from './main.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

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
        'machine',
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
        'list-machines',
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

  it.each([
    [['shell', '-c', 'true', '--workspace_id', 'w'], "unknown option '--workspace_id'"],
    [['shell', '-c', 'true', '--session_id', 's'], "unknown option '--session_id'"],
    [['workspace', 'vfs', 'stat', '/', '--workspace_id', 'w'], "unknown option '--workspace_id'"],
    [['workspace', 'session', 'list', '--workspace_id', 'w'], "unknown option '--workspace_id'"],
    [['mcp', '--session_id', 's'], "unknown option '--session_id'"],
    [['workspace', 'list-lines', 'w'], 'too many arguments'],
    [['workspace', 'list-machines', 'w'], 'too many arguments'],
  ])('refuses %j as a usage error with exit 2', async (args, said) => {
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`exit ${String(code)}`)
    })
    const err: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      err.push(String(chunk))
      return true
    })
    await expect(buildProgram().parseAsync(args, { from: 'user' })).rejects.toThrow('exit 2')
    expect(err.join('')).toContain(said)
  })
})
