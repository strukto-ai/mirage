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

import { mountKey } from '../../../utils/key_prefix.ts'
import { describe, expect, it } from 'vitest'
import { SlackAccessor } from '../../../accessor/slack.ts'
import { IndexEntry } from '../../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../../cache/index/ram.ts'
import { Precision } from '../../../provision/types.ts'
import { PathSpec } from '../../../types.ts'
import { FakeSlackTransport, makeFakeResource } from './_test_util.ts'
import { fileReadProvision, metadataProvision } from './_provision.ts'

function spec(virtual: string, prefix = ''): PathSpec {
  return new PathSpec({ virtual, directory: virtual, resourcePath: mountKey(virtual, prefix) })
}

describe('fileReadProvision', () => {
  it('returns UNKNOWN precision for empty paths', async () => {
    const transport = new FakeSlackTransport()
    const accessor = new SlackAccessor(transport)
    const result = await fileReadProvision(accessor, [], [], {
      stdin: null,
      flags: {},
      filetypeFns: null,
      cwd: '/',
      resource: makeFakeResource(transport),
    })
    expect(result.precision).toBe(Precision.UNKNOWN)
  })

  it('counts cached entries as ops', async () => {
    const transport = new FakeSlackTransport()
    const accessor = new SlackAccessor(transport)
    const index = new RAMIndexCacheStore()
    await index.put(
      '/mnt/slack/users/alice__U1.json',
      new IndexEntry({
        id: 'U1',
        name: 'alice',
        resourceType: 'slack/user',
        vfsName: 'alice__U1.json',
      }),
    )
    const result = await fileReadProvision(
      accessor,
      [spec('/mnt/slack/users/alice__U1.json', '/mnt/slack')],
      [],
      {
        stdin: null,
        flags: {},
        filetypeFns: null,
        cwd: '/',
        resource: makeFakeResource(transport),
        index,
      },
    )
    expect(result.precision).toBe(Precision.EXACT)
    expect(result.readOps).toBe(1)
    expect(result.networkReadHigh).toBe(0)
  })
})

describe('metadataProvision', () => {
  it('returns EXACT zero-cost result', async () => {
    const transport = new FakeSlackTransport()
    const accessor = new SlackAccessor(transport)
    const result = await metadataProvision(accessor, [], [], {
      stdin: null,
      flags: {},
      filetypeFns: null,
      cwd: '/',
      resource: makeFakeResource(transport),
    })
    expect(result.precision).toBe(Precision.EXACT)
    expect(result.networkReadHigh).toBe(0)
    expect(result.readOps).toBe(0)
  })
})
