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

// One half of the cross-language index cache interop (index_store.sh);
// the TypeScript twin of index_store.py, same roles, same checks.

import { LookupStatus } from '@struktoai/mirage-core/cache/index/config'
import {
  FileStat,
  FileType,
  RAMVFS,
  RedisIndexCacheStore,
  Workspace,
  type RedisIndexConfig,
} from '@struktoai/mirage-node'

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379/0'
const TTL = 600
const DIR = '/data'
const EMPTY_DIR = '/data/empty'
const PARTIAL_DIR = '/data/partial'
const UNLISTED_DIR = '/data/never'
const VERSIONED_DIR = '/data/versioned'
const VERSION = '0123456789abcdef0123456789abcdef01234567'
const FILE_NAME = 'a.txt'
const FOLDER_NAME = 'sub'
const FILE = `${DIR}/${FILE_NAME}`
const CHILDREN = [FILE, `${DIR}/${FOLDER_NAME}`]
const REMOTE_TIME = '2026-01-01T00:00:00Z'
const EXTRA = { etag: 'abc' }

let fail = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  OK   ${name}`)
  } else {
    console.log(`  FAIL ${name} ${detail}`)
    fail = 1
  }
}

function sameList(got: readonly string[] | null | undefined, want: readonly string[]): boolean {
  return (
    got !== null &&
    got !== undefined &&
    got.length === want.length &&
    got.every((v, i) => v === want[i])
  )
}

function makeStore(prefix: string): { ws: Workspace; store: RedisIndexCacheStore } {
  const ram = new RAMVFS()
  const index: RedisIndexConfig = { type: 'redis', url: REDIS_URL, keyPrefix: prefix, ttl: TTL }
  const ws = new Workspace({ [DIR]: ram }, { index })
  const store = ws.registry.mountForPrefix(DIR).indexStore
  if (!(store instanceof RedisIndexCacheStore)) {
    throw new Error(
      `ts: workspace index config did not reach the mount, got ${store.constructor.name}`,
    )
  }
  return { ws, store }
}

async function close(ws: Workspace, store: RedisIndexCacheStore): Promise<void> {
  await store.close()
  await ws.close()
}

async function write(prefix: string): Promise<void> {
  const { ws, store } = makeStore(prefix)
  const fileEntry = new FileStat({
    name: FILE_NAME,
    type: FileType.FILE,
    modified: REMOTE_TIME,
    size: 6,
    fingerprint: FILE,
    extra: { ...EXTRA },
  })
  const folderEntry = new FileStat({
    name: FOLDER_NAME,
    type: FileType.DIRECTORY,
    modified: REMOTE_TIME,
    fingerprint: `${DIR}/${FOLDER_NAME}`,
  })
  await store.setDir(DIR, [
    [FILE_NAME, fileEntry],
    [FOLDER_NAME, folderEntry],
  ])
  await store.setDir(`${DIR}/${FOLDER_NAME}`, [[FILE_NAME, fileEntry]])
  await store.put(`${DIR}/${FOLDER_NAME}/unlisted`, fileEntry)
  await store.setDir(EMPTY_DIR, [])
  await store.setPartialDir(PARTIAL_DIR, [[FILE_NAME, fileEntry]])
  await store.setDir(VERSIONED_DIR, [[FILE_NAME, fileEntry]], undefined, { version: VERSION })
  const listing = await store.listDir(DIR)
  check(
    'ts write: listing reads back',
    sameList(listing.entries, CHILDREN),
    JSON.stringify(listing),
  )
  await close(ws, store)
}

async function read(prefix: string): Promise<void> {
  const { ws, store } = makeStore(prefix)
  const got = await store.get(FILE)
  const entry = got.entry
  check(
    'ts read: entry field by field',
    entry !== null &&
      entry !== undefined &&
      (got.status ?? null) === null &&
      entry.fingerprint === FILE &&
      entry.name === FILE_NAME &&
      entry.type === FileType.FILE &&
      entry.modified === REMOTE_TIME &&
      entry.size === 6 &&
      JSON.stringify(entry.extra) === JSON.stringify(EXTRA),
    JSON.stringify(got),
  )
  const listing = await store.listDir(DIR)
  check(
    'ts read: listing in order',
    (listing.status ?? null) === null && sameList(listing.entries, CHILDREN),
    JSON.stringify(listing),
  )
  check(
    'ts read: an unversioned listing has no version',
    listing.version === null,
    JSON.stringify(listing),
  )
  const versioned = await store.listDir(VERSIONED_DIR)
  check(
    "ts read: a listing's version as written",
    (versioned.status ?? null) === null &&
      sameList(versioned.entries, [`${VERSIONED_DIR}/${FILE_NAME}`]) &&
      versioned.version === VERSION,
    JSON.stringify(versioned),
  )
  const empty = await store.listDir(EMPTY_DIR)
  check(
    'ts read: empty listing is listed, not missing',
    (empty.status ?? null) === null && sameList(empty.entries, []),
    JSON.stringify(empty),
  )
  const missing = await store.listDir(UNLISTED_DIR)
  check(
    'ts read: unlisted directory is not found',
    missing.status === LookupStatus.NOT_FOUND,
    JSON.stringify(missing),
  )
  const partial = await store.listDir(PARTIAL_DIR)
  check(
    'ts read: partial listing proves only observed children',
    partial.entries === undefined &&
      partial.status === undefined &&
      sameList(partial.partialEntries, [`${PARTIAL_DIR}/${FILE_NAME}`]),
    JSON.stringify(partial),
  )
  await store.invalidate()
  const expiredPartial = await store.listDir(PARTIAL_DIR)
  check(
    'ts read: invalidate expires partial membership',
    expiredPartial.status === LookupStatus.EXPIRED && expiredPartial.partialEntries === undefined,
    JSON.stringify(expiredPartial),
  )
  const stale = await store.listDir(DIR)
  check(
    'ts read: invalidate expires the foreign listing',
    stale.status === LookupStatus.EXPIRED,
    JSON.stringify(stale),
  )
  const kept = await store.get(FILE)
  check(
    'ts read: invalidate keeps the entries',
    kept.entry !== null && kept.entry !== undefined,
    JSON.stringify(kept),
  )
  await store.setDir(DIR, [
    [
      FOLDER_NAME,
      new FileStat({ name: FOLDER_NAME, type: FileType.FILE, fingerprint: 'replacement' }),
    ],
  ])
  const replaced = await store.get(`${DIR}/${FOLDER_NAME}`)
  check(
    'ts read: replacement file survives foreign subtree eviction',
    replaced.entry?.type === FileType.FILE,
  )
  for (const path of [`${DIR}/${FOLDER_NAME}/${FILE_NAME}`, `${DIR}/${FOLDER_NAME}/unlisted`]) {
    check(
      'ts read: foreign descendant evicted ' + path,
      (await store.get(path)).status === LookupStatus.NOT_FOUND,
    )
  }
  check(
    'ts read: foreign directory listing evicted',
    (await store.listDir(`${DIR}/${FOLDER_NAME}`)).status === LookupStatus.NOT_FOUND,
  )
  await store.clear()
  const gone = await store.listDir(DIR)
  check(
    'ts read: clear forgets the listing',
    gone.status === LookupStatus.NOT_FOUND,
    JSON.stringify(gone),
  )
  await close(ws, store)
}

async function main(): Promise<void> {
  const [role, prefix] = process.argv.slice(2)
  if (prefix === undefined) throw new Error('usage: index_store.ts <write|read> <prefix>')
  if (role === 'write') {
    await write(prefix)
  } else if (role === 'read') {
    await read(prefix)
  } else {
    throw new Error(`unknown role: ${String(role)}`)
  }
  if (fail !== 0) process.exit(1)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
