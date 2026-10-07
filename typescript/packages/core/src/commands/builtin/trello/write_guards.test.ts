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

import { ioContext } from '../../../workspace/session/access.ts'
import type { IOContext } from '../../../context/types.ts'
import { describe, expect, it } from 'vitest'
import { TrelloAccessor } from '../../../accessor/trello.ts'

import type { TrelloTransport } from '../../../core/trello/client.ts'
import { MountMode } from '../../../types.ts'
import type { CommandOpts, RegisteredCommand } from '../../config.ts'
import type { FlagValue } from '../../spec/types.ts'
import { TRELLO_CARD_ASSIGN } from './trello_card_assign.ts'
import { TRELLO_CARD_COMMENT_ADD } from './trello_card_comment_add.ts'
import { TRELLO_CARD_COMMENT_UPDATE } from './trello_card_comment_update.ts'
import { TRELLO_CARD_CREATE } from './trello_card_create.ts'
import { TRELLO_CARD_LABEL_ADD } from './trello_card_label_add.ts'
import { TRELLO_CARD_LABEL_REMOVE } from './trello_card_label_remove.ts'
import { TRELLO_CARD_MOVE } from './trello_card_move.ts'
import { TRELLO_CARD_UPDATE } from './trello_card_update.ts'
const transport: TrelloTransport = {
  call() {
    throw new Error('the transport was reached; the guard did not fire')
  },
}
const accessor = new TrelloAccessor(transport)
// Every card write, with the flags that pass its own validation, so the
// refusal below is the guard's and not a missing-flag error. The guard
// fires before the client, so no case reaches the transport.
const CASES: readonly [readonly RegisteredCommand[], Record<string, FlagValue>][] = [
  [TRELLO_CARD_CREATE, { list_id: 'l1', name: 'card' }],
  [TRELLO_CARD_COMMENT_ADD, { card_id: 'c1', text: 'hi' }],
  [TRELLO_CARD_COMMENT_UPDATE, { card_id: 'c1', comment_id: 'm1', text: 'hi' }],
  [TRELLO_CARD_ASSIGN, { card_id: 'c1', member_id: 'u1' }],
  [TRELLO_CARD_LABEL_ADD, { card_id: 'c1', label_id: 'g1' }],
  [TRELLO_CARD_LABEL_REMOVE, { card_id: 'c1', label_id: 'g1' }],
  [TRELLO_CARD_MOVE, { card_id: 'c1', list_id: 'l2' }],
  [TRELLO_CARD_UPDATE, { card_id: 'c1', name: 'renamed' }],
]
describe('trello card writes hold the mount-wide write grant', () => {
  for (const [cmds, flags] of CASES) {
    const rc = cmds[0]
    if (rc === undefined) throw new Error('command registered nothing')
    it(`${rc.name} declares write and refuses under a READ gate`, async () => {
      // Mount.executeCmd's write-command gate keys on the registration
      // flag, and the in-handler guard covers the id-addressed write a
      // per-path check cannot judge. Nothing pinned the per-command
      // wiring before, which is how the Python side drifted to 3 of 8.
      expect(rc.write).toBe(true)
      const opts: CommandOpts = {
        stdin: null,
        flags,
        filetypeFns: null,
        cwd: '/',
        mountPrefix: '/trello',
      }
      {
        const context: IOContext = {
          ...ioContext(null, null, null),
          mountGate: ['/trello', MountMode.READ],
        }
        await expect(
          Promise.resolve(rc.fn(accessor, [], [], { ...opts, ioContext: context })),
        ).rejects.toThrow(/read-only/)
      }
    })
  }
})
// Mirrors python's test_a_card_write_refuses_an_id_outside_the_scope: the
// write is addressed by id, so without the check a mount narrowed to one
// board writes to any board the token can reach. The transport answers
// only the guard's lookups; a write that got past it throws a different
// error.
describe('trello card writes hold the mount scope', () => {
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
  for (const [cmds, flags] of CASES) {
    const rc = cmds[0]
    if (rc === undefined) throw new Error('command registered nothing')
    it(`${rc.name} refuses an id outside the scope`, async () => {
      const opts: CommandOpts = {
        stdin: null,
        flags,
        filetypeFns: null,
        cwd: '/',
        mountPrefix: '/trello',
      }
      {
        const context: IOContext = {
          ...ioContext(null, null, null),
          mountGate: ['/trello', MountMode.WRITE],
        }
        await expect(
          Promise.resolve(rc.fn(scoped, [], [], { ...opts, ioContext: context })),
        ).rejects.toThrow(/ is outside this mount's scope$/)
      }
    })
  }
})
