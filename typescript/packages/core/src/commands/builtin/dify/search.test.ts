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

import { expect, it } from 'vitest'
import type { Accessor } from '../../../accessor/base.ts'
import { PathSpec } from '../../../types.ts'
import { search } from './search.ts'

// Twin of test_search_command_refuses_an_option_dify_cannot_take.
it.each([
  [{ method: '' }, 'search: method must be one of semantic, fulltext, hybrid, keyword'],
  [{ method: 'vector' }, 'search: method must be one of semantic, fulltext, hybrid, keyword'],
  [{ threshold: '1.2' }, 'search: threshold must be in [0, 1]'],
  [{ top_k: '0' }, 'search: top-k must be positive'],
])('refuses %j as a usage error before Dify is asked', async (flags, message) => {
  const [cmd] = search
  if (cmd === undefined) throw new Error('search not registered')
  const opts = { stdin: null, flags, cwd: PathSpec.fromStrPath('/') }
  await expect(cmd.fn({} as Accessor, [], ['anything'], opts)).rejects.toMatchObject({
    exitCode: 2,
    message,
  })
})
