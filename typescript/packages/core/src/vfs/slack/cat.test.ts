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

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { SlackWorkspace } from '../../../tests/core/slack/workspace.ts'
import { SlackVFS } from './slack.ts'

let origin = ''
let workspace: SlackWorkspace

beforeAll(async () => {
  origin = await serve('slack')
})

beforeEach(async () => {
  workspace = new SlackWorkspace(origin)
  await workspace.reset()
})

afterEach(async () => {
  await workspace.close()
})

// `line` over the workspace mounted at /mnt/slack.
async function onSlack(line: string): Promise<string> {
  const ws = new Workspace({ '/mnt/slack/': new SlackVFS({ accessor: workspace.accessor() }) })
  try {
    return new TextDecoder().decode((await ws.shell(line)).stdout)
  } finally {
    await ws.close()
  }
}

function texts(out: string): string[] {
  return out
    .trimEnd()
    .split('\n')
    .map((line) => (JSON.parse(line) as { text: string }).text)
}

describe('slack cat', () => {
  it('concatenates multiple jsonl files in order (regression: previously only read the first)', async () => {
    const dates = ['2025-11-03', '2025-11-04', '2025-11-06']
    const paths = dates.map((date) => `/mnt/slack/channels/general__C1/${date}/chat.jsonl`)
    expect(texts(await onSlack(`cat ${paths.join(' ')}`))).toEqual([
      'the deploy is done at acme',
      'coffee is ready',
      'lunch at noon',
      'deploy again',
    ])
  })
})
