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
import { OpRecord } from '../observe/record.ts'
import { ExecutionNode, ExecutionRecord } from './types.ts'

describe('ExecutionNode', () => {
  it('defaults are sensible', () => {
    const n = new ExecutionNode()
    expect(n.command).toBeNull()
    expect(n.op).toBeNull()
    expect(n.stderr).toEqual(new Uint8Array())
    expect(n.exitCode).toBe(0)
    expect(n.children).toEqual([])
    expect(n.records).toEqual([])
  })

  it('toJSON omits null command/op, includes stderr as decoded string', () => {
    const n = new ExecutionNode({
      command: 'cat /x',
      stderr: new TextEncoder().encode('oops'),
      exitCode: 1,
    })
    expect(n.toJSON()).toEqual({
      command: 'cat /x',
      stderr: 'oops',
      exitCode: 1,
    })
  })

  it('toJSON recurses into children and includes records when non-empty', () => {
    const child = new ExecutionNode({ command: 'echo hi' })
    const rec = new OpRecord({
      op: 'read',
      path: '/x',
      source: 'ram',
      bytes: 3,
      timestamp: 1,
      durationMs: 2,
    })
    const root = new ExecutionNode({ op: '|', children: [child], records: [rec] })
    const json = root.toJSON()
    expect(json.op).toBe('|')
    expect(json.children).toHaveLength(1)
    expect(json.records).toHaveLength(1)
  })

  // Port of tests/workspace/test_execution_types.py::test_execution_node_nested_tree:
  // verifies exit codes propagate through nested tree depths (`;` > `|` > command).
  it('nested tree: ; containing | containing commands — deep exit codes preserved', () => {
    const tree = new ExecutionNode({
      op: ';',
      children: [
        new ExecutionNode({
          op: '|',
          children: [
            new ExecutionNode({ command: 'grep foo file', exitCode: 1 }),
            new ExecutionNode({ command: 'sort', exitCode: 0 }),
          ],
        }),
        new ExecutionNode({ command: 'echo done', exitCode: 0 }),
      ],
    })
    expect(tree.children[0]?.children[0]?.exitCode).toBe(1)
    expect(tree.children[1]?.command).toBe('echo done')
  })
})

describe('ExecutionRecord', () => {
  it('defaults sessionId to empty when unattributed', () => {
    const tree = new ExecutionNode()
    const r = new ExecutionRecord({
      agent: 'a',
      command: 'cat /x',
      stdout: new Uint8Array(),
      exitCode: 0,
      tree,
      timestamp: 100,
    })
    expect(r.sessionId).toBe('')
  })

  it('toJSON decodes stdout and stdin', () => {
    const tree = new ExecutionNode()
    const r = new ExecutionRecord({
      agent: 'a',
      command: 'cmd',
      stdout: new TextEncoder().encode('out'),
      stdin: new TextEncoder().encode('in'),
      exitCode: 0,
      tree,
      timestamp: 10,
    })
    const json = r.toJSON()
    expect(json.stdout).toBe('out')
    expect(json.stdin).toBe('in')
    expect(json.command).toBe('cmd')
  })

  it('toJSON handles null stdin', () => {
    const tree = new ExecutionNode()
    const r = new ExecutionRecord({
      agent: 'a',
      command: 'cmd',
      stdout: new Uint8Array(),
      exitCode: 0,
      tree,
      timestamp: 10,
    })
    expect(r.toJSON().stdin).toBeNull()
  })
})
