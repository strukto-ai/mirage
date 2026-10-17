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
import { compileSpec } from '../../../spec/compile.ts'
import type { CommandSpec } from '../../../spec/types.ts'
import { cliSpecFor } from '../../specs.ts'
import { TRELLO } from './index.ts'
import { TrelloConfigSchema } from '../../../../core/trello/config.ts'

function leaf(...path: string[]): CommandSpec {
  let node = TRELLO.spec
  for (const name of path) {
    const child = node.subcommands.find((c) => c.name === name)
    if (child === undefined) throw new Error(`no subcommand ${name}`)
    node = child
  }
  return node
}

const WRITES = [
  'create',
  'update',
  'move',
  'assign',
  'label',
  'unlabel',
  'comment',
  'comment-update',
]

// Mirrors python's tests/commands/cli/builtin/trello/test_tree.py.
describe('trello tree', () => {
  it('keeps the verbs the mount spoke and registers itself', () => {
    expect(TRELLO.spec.subcommands.map((g) => g.name)).toEqual(['board', 'list', 'label', 'card'])
    expect(leaf('board').subcommands.map((v) => v.name)).toEqual(['list', 'show', 'members'])
    expect(leaf('card').subcommands.map((v) => v.name)).toEqual([
      'list',
      'show',
      'comments',
      ...WRITES,
    ])
    expect(TRELLO.configModel).toBe(TrelloConfigSchema)
    expect(cliSpecFor('trello')).toBe(TRELLO)
  })

  it('classifies writers and keeps ids positional on reads and flags on writes', () => {
    for (const verb of WRITES) {
      expect(TRELLO.handlers[['card', verb].join(' ')]?.write).toBe(true)
    }
    for (const path of ['board list', 'board show', 'card show', 'card comments']) {
      expect(TRELLO.handlers[path]?.write).toBe(false)
    }
    expect(compileSpec(leaf('card', 'show')).rest).not.toBeNull()
    expect(compileSpec(leaf('board', 'list')).rest).toBeNull()
    expect(compileSpec(leaf('card', 'create')).rest).toBeNull()
    expect(
      compileSpec(leaf('card', 'update'))
        .options.map((o) => o.names.at(-1))
        .sort(),
    ).toEqual(['--card_id', '--closed', '--desc', '--desc_file', '--due', '--name'])
  })
})
