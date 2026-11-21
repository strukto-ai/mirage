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
import { mcpServer, workspaceOf } from './acp.ts'

describe('workspaceOf', () => {
  it.each([
    ['http://127.0.0.1:8765/v1/workspaces/demo/rpc', 'demo'],
    ['https://h.example/base/v1/workspaces/a%2Fb/rpc?session_id=s', 'a/b'],
  ])('reads %s', (url, expected) => {
    expect(workspaceOf(url)).toBe(expected)
  })
})

describe('mcpServer', () => {
  it('runs mirage mcp on the same session', () => {
    expect(mcpServer('demo', 'agent')).toEqual({
      name: 'mirage',
      command: process.execPath,
      args: [process.argv[1], 'mcp', '--workspace', 'demo', '--session', 'agent'],
      env: [],
    })
    expect(mcpServer('demo', undefined).args).not.toContain('--session')
  })
})
