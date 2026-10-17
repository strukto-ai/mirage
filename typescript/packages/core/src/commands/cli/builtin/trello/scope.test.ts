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
import { requireBoard, requireCard, requireList } from './scope.ts'

class FakeTransport implements TrelloTransport {
  public readonly paths: string[] = []
  constructor(private readonly responder: (path: string) => unknown) {}
  call(_method: string, path: string): Promise<unknown> {
    this.paths.push(path)
    return Promise.resolve(this.responder(path))
  }
}

// Mirrors python's tests/commands/cli/builtin/trello/test_scope.py.
describe('trello id scope guards', () => {
  it('admit every id on an unnarrowed install without a call', async () => {
    const t = new FakeTransport(() => ({}))
    const accessor = new TrelloAccessor(t)
    await requireBoard(accessor, 'b_any')
    await requireList(accessor, 'l_any')
    await requireCard(accessor, 'c_any')
    expect(t.paths).toEqual([])
  })

  it('admit an id on a board in scope', async () => {
    const t = new FakeTransport(() => ({ idBoard: 'b_in' }))
    const accessor = new TrelloAccessor(t, { boardIds: ['b_in'] })
    await requireBoard(accessor, 'b_in')
    await requireList(accessor, 'l1')
    await requireCard(accessor, 'c1')
    expect(t.paths).toEqual(['/lists/l1', '/cards/c1'])
  })

  it('refuse a record without a board', async () => {
    const t = new FakeTransport(() => ({ id: 'c1' }))
    const accessor = new TrelloAccessor(t, { boardIds: ['b_in'] })
    await expect(requireCard(accessor, 'c1')).rejects.toThrow(
      /^card c1 is outside the configured scope$/,
    )
  })
})
