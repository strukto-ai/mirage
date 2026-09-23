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

import { RedisFileCacheStore } from '@struktoai/mirage-node'

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379/0'
const ENC = new TextEncoder()
const DEC = new TextDecoder()

async function main(): Promise<void> {
  const cache = new RedisFileCacheStore({
    url: REDIS_URL,
    keyPrefix: 'mirage:example:cache:',
    cacheLimit: '64MB',
  })
  await cache.open()
  await cache.clear()

  console.log('=== RedisFileCacheStore: FileCache backed by Redis ===\n')
  console.log(`  url: ${cache.url}`)
  console.log(`  keyPrefix: ${cache.keyPrefix}`)
  console.log(`  cacheLimit: ${String(cache.cacheLimit)} bytes\n`)

  console.log('--- set + get round-trip ---')
  const payload = ENC.encode('hello from redis cache')
  // A backend token, not a hash of the bytes: the cache compares what
  // the backend said about the object, so that is what a caller supplies.
  const fp = 'etag-demo-1'
  await cache.set('/data/hello.txt', payload, { fingerprint: fp })
  const got = await cache.get('/data/hello.txt')
  console.log(`  get: ${DEC.decode(got ?? new Uint8Array())}`)

  console.log('\n--- isFresh (fingerprint comparison) ---')
  console.log(`  matches same fp: ${String(await cache.isFresh('/data/hello.txt', fp))}`)
  console.log(`  matches other fp: ${String(await cache.isFresh('/data/hello.txt', 'abc'))}`)

  console.log('\n--- add (no-op if present, true if inserted) ---')
  console.log(`  add existing: ${String(await cache.add('/data/hello.txt', payload))}`)
  console.log(`  add new: ${String(await cache.add('/data/new.bin', new Uint8Array([1, 2, 3])))}`)

  console.log('\n--- multiGet ---')
  const keys = ['/data/hello.txt', '/data/new.bin', '/data/missing']
  const results = await cache.multiGet(keys)
  for (let i = 0; i < keys.length; i++) {
    const r = results[i]
    console.log(`  ${keys[i]}: ${r === null ? 'MISS' : `${String(r.byteLength)} bytes`}`)
  }

  console.log('\n--- ttl expiry ---')
  await cache.set('/data/ephemeral', ENC.encode('soon gone'), { ttl: 1 })
  console.log(`  immediate: ${String(await cache.exists('/data/ephemeral'))}`)
  await new Promise((resolve) => setTimeout(resolve, 1100))
  console.log(`  after 1.1s: ${String(await cache.exists('/data/ephemeral'))}`)

  console.log('\n--- inspect raw keys under prefix ---')
  const client = await cache.cacheClient()
  const keysUnderPrefix: string[] = []
  for await (const k of client.scanIterator({ MATCH: `${cache.keyPrefix}*` })) {
    if (Array.isArray(k)) keysUnderPrefix.push(...k)
    else keysUnderPrefix.push(k)
  }
  console.log(`  total keys: ${String(keysUnderPrefix.length)}`)
  for (const k of keysUnderPrefix.sort()) console.log(`    ${k}`)

  console.log('\n--- cross-process persistence ---')
  console.log('  another RedisFileCacheStore with same keyPrefix sees the same data:')
  const cache2 = new RedisFileCacheStore({
    url: REDIS_URL,
    keyPrefix: 'mirage:example:cache:',
  })
  const fromOther = await cache2.get('/data/hello.txt')
  console.log(`  cache2.get: ${DEC.decode(fromOther ?? new Uint8Array())}`)
  await cache2.close()

  console.log('\n=== CLEANUP ===')
  await cache.clear()
  await cache.close()
  console.log('  wiped cache keys from Redis')
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
