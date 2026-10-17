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
import { TrelloAccessor } from '../../../../accessor/trello.ts'
import type { TrelloTransport } from '../../../../core/trello/client.ts'
import { materialize } from '../../../../io/types.ts'
import { PathSpec } from '../../../../types.ts'
import { context } from '../../../../workspace/fixtures/context.ts'
import type { Files } from '../../../../workspace/files.ts'
import type { FlagValue } from '../../../spec/types.ts'
import type { CommandSpec } from '../../../spec/types.ts'
import type { CLIVerbFn } from '../../types.ts'
import { TRELLO } from './index.ts'

const DEC = new TextDecoder()
const ENC = new TextEncoder()

const CASES: readonly [string, Record<string, FlagValue>][] = [
  ['card create', { list_id: 'l1', name: 'card' }],
  ['card comment', { card_id: 'c1', text: 'hi' }],
  ['card comment-update', { card_id: 'c1', comment_id: 'm1', text: 'hi' }],
  ['card assign', { card_id: 'c1', member_id: 'u1' }],
  ['card label', { card_id: 'c1', label_id: 'g1' }],
  ['card unlabel', { card_id: 'c1', label_id: 'g1' }],
  ['card move', { card_id: 'c1', list_id: 'l2' }],
  ['card update', { card_id: 'c1', name: 'renamed' }],
]

function spec(path: string): CommandSpec {
  let node = TRELLO.spec
  for (const name of path.split(' ')) {
    const child = node.subcommands.find((c) => c.name === name)
    if (child === undefined) throw new Error(`no subcommand ${name}`)
    node = child
  }
  return node
}

function leaf(path: string): CLIVerbFn {
  const fn = TRELLO.handlers[path]?.fn
  if (fn === null || fn === undefined) throw new Error(`trello ${path} has no handler`)
  return fn
}

describe('trello card writes are classified as writes', () => {
  for (const [path] of CASES) {
    it(`${path} declares write`, () => {
      expect(TRELLO.handlers[path]?.write).toBe(true)
    })
  }
})

// Mirrors python's test_a_card_write_refuses_an_id_outside_the_scope: the
// write is addressed by id, so without the check an install narrowed to one
// board writes to any board the token can reach. The transport answers
// only the guard's lookups; a write that got past it throws a different
// error.
describe('trello card writes hold the configured scope', () => {
  const scoped = new TrelloAccessor(
    {
      call(method: string, path: string) {
        if (method === 'GET' && /^\/(cards|lists)\/[^/]+$/.test(path)) {
          return Promise.resolve({ idBoard: 'b_out' })
        }
        throw new Error(`the transport was reached: ${method} ${path}`)
      },
    },
    { boardIds: ['b_in'] },
  )
  for (const [path, flags] of CASES) {
    it(`${path} refuses an id outside the scope`, async () => {
      const ctx = context({ flags, spec: spec(path) })
      await expect(Promise.resolve(leaf(path)(scoped, [], [], ctx))).rejects.toThrow(
        / is outside the configured scope$/,
      )
    })
  }
})

describe('trello card text operands', () => {
  let desc = ''
  const accessor = new TrelloAccessor({
    call(method: string, path: string, params?: Record<string, string>) {
      if (method === 'PUT' && path === '/cards/c1') {
        desc = params?.desc ?? ''
        return Promise.resolve({})
      }
      if (method === 'GET' && path === '/cards/c1') return Promise.resolve({ id: 'c1', desc })
      throw new Error(`unexpected ${method} ${path}`)
    },
  } satisfies TrelloTransport)

  it('reads a --desc_file operand through the session files', async () => {
    const read: PathSpec[] = []
    const vfs = {
      read(path: PathSpec) {
        read.push(path)
        return Promise.resolve(ENC.encode('from a file'))
      },
    } as unknown as Files
    const operand = PathSpec.fromStrPath('/scratch/desc.txt')
    const ctx = context({
      flags: { card_id: 'c1', desc_file: operand },
      spec: spec('card update'),
      vfs,
    })
    const result = await leaf('card update')(accessor, [], [], ctx)
    if (result === null) throw new Error('card update returned nothing')
    const card = JSON.parse(DEC.decode(await materialize(result[0]))) as { desc: string }
    expect(card.desc).toBe('from a file')
    expect(read.map((p) => p.virtual)).toEqual(['/scratch/desc.txt'])
  })

  it('refuses a --desc_file operand outside a workspace', async () => {
    const operand = PathSpec.fromStrPath('/scratch/desc.txt')
    const ctx = context({ flags: { card_id: 'c1', desc_file: operand }, spec: spec('card update') })
    await expect(Promise.resolve(leaf('card update')(accessor, [], [], ctx))).rejects.toThrow(
      /^--desc_file needs a workspace to read files from$/,
    )
  })
})
