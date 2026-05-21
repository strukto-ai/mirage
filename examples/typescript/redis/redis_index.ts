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

import {
  IndexEntry,
  RAMResource,
  RedisIndexCacheStore,
  Workspace,
  type RedisIndexConfig,
} from '@struktoai/mirage-node'

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379/0'

function file(name: string): IndexEntry {
  return new IndexEntry({ id: name, name, resourceType: 'file' })
}

async function main(): Promise<void> {
  // A workspace-level `index` config points every mounted resource's index
  // cache at the same Redis instance. Two separate Mirage processes that
  // share a keyPrefix then share one index -- the building block for running
  // the same mounts locally and in a remote sandbox.
  const keyPrefix = `mirage:example:idx:${String(Date.now())}:`
  const indexConfig: RedisIndexConfig = { type: 'redis', url: REDIS_URL, keyPrefix }

  // Workspace A: a RAM mount whose INDEX is backed by Redis (not RAM).
  const ramA = new RAMResource()
  const wsA = new Workspace({ '/data': ramA }, { index: indexConfig })
  console.log(`index store A is redis-backed: ${ramA.index instanceof RedisIndexCacheStore}`)

  // Populate the shared Redis index through workspace A.
  await ramA.index.put('/data/hello.txt', file('hello.txt'))
  await ramA.index.setDir('/data', [
    ['hello.txt', file('hello.txt')],
    ['notes.md', file('notes.md')],
  ])

  // Workspace B: a *separate* resource pointed at the *same* Redis index
  // (same keyPrefix). It sees what A cached without re-listing anything.
  const ramB = new RAMResource()
  const wsB = new Workspace({ '/data': ramB }, { index: indexConfig })

  const entry = await ramB.index.get('/data/hello.txt')
  console.log(`shared index entry: ${entry.entry?.name ?? '(none)'}`)

  const listing = await ramB.index.listDir('/data')
  console.log(`shared index listing: ${(listing.entries ?? []).join(', ')}`)

  await ramA.index.clear()
  if (ramA.index instanceof RedisIndexCacheStore) await ramA.index.close()
  if (ramB.index instanceof RedisIndexCacheStore) await ramB.index.close()
  await wsA.close()
  await wsB.close()
  console.log('wiped test keys from Redis')
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
