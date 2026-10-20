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

import { FileStat, FileType } from '../../types.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IndexDirectorySchema, LookupStatus } from './config.ts'
import { CacheManager } from '../manager.ts'
import { ENTRY_PREFIX, REGISTRY_PAGE } from './constants.ts'
import { RedisIndexCacheStore, type RedisClientLike } from './redis.ts'
import { runInCommandScope } from './scope.ts'
import { storedStat } from '../../workspace/mount/listing.ts'
import { ManualClock } from '../../utils/clock.ts'

describe('RedisIndexCacheStore default keyPrefix', () => {
  it('namespaces keys under mirage:index: by default', () => {
    const store = new RedisIndexCacheStore()
    const prefix = (store as unknown as { entryPrefix: string }).entryPrefix
    expect(prefix).toBe('mirage:index:mirage:idx:entry:')
  })
})

const REDIS_URL = process.env.REDIS_URL
const skip = REDIS_URL === undefined

function entry(id: string, name: string, kind = 'file'): FileStat {
  const type = kind === 'folder' ? FileType.DIRECTORY : FileType.FILE
  return new FileStat({ name, type, fingerprint: id })
}

describe.skipIf(skip)('RedisIndexCacheStore', () => {
  let store: RedisIndexCacheStore
  const prefix = `mirage:idx:test:${String(Date.now())}:${Math.random().toString(36).slice(2)}:`

  beforeEach(async () => {
    store = new RedisIndexCacheStore(
      REDIS_URL !== undefined
        ? { url: REDIS_URL, keyPrefix: prefix, ttl: 600 }
        : { keyPrefix: prefix, ttl: 600 },
    )
    await store.clear()
  })

  afterEach(async () => {
    await store.clear()
    await store.close()
  })

  async function redis(): Promise<RedisClientLike> {
    return (store as unknown as { client: () => Promise<RedisClientLike> }).client()
  }

  it.each(['none', 'replace', 'delete'])('conditional replacement is atomic: %s', async (peer) => {
    await store.setDir('/dir', [['a', entry('old', 'a')]], undefined, { version: 'v1' })
    const old = (await store.get('/dir/a')).entry

    if (old == null) throw new Error('missing seeded row')
    const client = await redis()
    const key = (store as unknown as { entryKey: (path: string) => string }).entryKey('/dir/a')
    const raw = JSON.stringify(
      Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(old)) as object).reverse()),
      null,
      2,
    )
    await client.set(key, raw)
    const latest = old.with({ size: 9 })
    const listingKey = (store as unknown as { childrenKey: (path: string) => string }).childrenKey(
      '/dir',
    )
    const listingRaw = await client.get(listingKey)
    const evaluate = client.eval.bind(client)
    const spy = vi.spyOn(client, 'eval').mockImplementation(async (script, options) => {
      expect(options.keys).toEqual([key])
      expect(options.arguments[0]).toBe(raw)
      if (peer === 'replace') await client.set(key, JSON.stringify(latest))
      else if (peer === 'delete') await client.del(key)
      return evaluate(script, options)
    })
    try {
      expect(
        await store.replaceIfUnchanged('/dir/a', JSON.stringify(old), entry('confirmed', 'a')),
      ).toBe(peer === 'none')
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }
    const current = (await store.get('/dir/a')).entry ?? null
    if (peer === 'none') expect(current?.fingerprint).toBe('confirmed')
    else expect(current).toEqual(peer === 'replace' ? latest : null)
    expect(await client.get(listingKey)).toBe(listingRaw)
  })

  it('evicts a subtree without scanning unrelated Redis keys', async () => {
    const client = await redis()
    const child = entry('child', 'child')
    await store.setDir('/d', [['sub', entry('sub', 'sub', 'folder')]])
    await store.put('/d/sub/unlisted/deep', child)
    store.seed(
      new Map(Array.from({ length: 200 }, (_, i) => [`/other/${String(i)}`, child])),
      new Map(),
      new Date(Date.now() + 3600000),
    )
    await store.get('/other/0')
    await client.set(`${prefix}unrelated`, 'keep')
    const evaluate = client.eval.bind(client)
    const spy = vi.spyOn(client, 'eval').mockImplementation((script, options) =>
      evaluate(
        `
local call = redis.call
local redis = {call = function(command, ...)
  if command == 'SCAN' then error('unexpected database scan') end
  return call(command, ...)
end}
${script}`,
        options,
      ),
    )
    try {
      await store.setDir('/d', [])
      expect((await store.get('/d/sub/unlisted/deep')).status).toBe(LookupStatus.NOT_FOUND)
      expect((await store.get('/other/0')).entry).toBeDefined()
      expect(await client.get(`${prefix}unrelated`)).toBe('keep')
    } finally {
      spy.mockRestore()
    }
  })

  it('recovers subtree membership after Redis evicts the path registry', async () => {
    const client = await redis()
    const child = entry('child', 'child')
    await store.setDir('/d', [['sub', entry('sub', 'sub', 'folder')]])
    await store.put('/d/sub/unlisted/deep', child)
    await store.setDir('/d/sub/buried', [['child', child]])
    await store.invalidateDir('/d/sub/buried')
    await client.del(`${prefix}mirage:idx:paths`)
    await store.put('/unrelated', child)
    await store.setDir('/d', [])
    expect((await store.get('/d/sub/unlisted/deep')).status).toBe(LookupStatus.NOT_FOUND)
    expect(await client.get(`${prefix}mirage:idx:tombstone:/d/sub/buried`)).toBeNull()
    expect((await store.get('/unrelated')).entry).toBeDefined()
  })

  it('prunes removed path members while retaining tombstones', async () => {
    const client = await redis()
    const child = entry('child', 'child')
    const members = () =>
      client.eval("return redis.call('ZRANGE', KEYS[1], 0, -1)", {
        keys: [`${prefix}mirage:idx:paths`],
        arguments: [],
      })
    await store.put('/put-only', child)
    await store.invalidateEntry('/put-only')
    expect(await members()).toEqual(['', '/'])
    await store.invalidatePrefix('/')
    await store.setDir('/d', [['child', child]])
    await store.setDir('/d', [])
    expect(await members()).toEqual(['', '/d'])
    await store.setDir('/d', [['child', child]])
    await store.invalidateDir('/d')
    await store.invalidatePrefix('/d')
    expect(await members()).toEqual(['', '/d'])
    expect(await client.get(`${prefix}mirage:idx:tombstone:/d`)).not.toBeNull()
    await store.clear()
    expect(await members()).toEqual([''])
  })

  it('accepts trailing slashes while preserving literal prefix boundaries and exclusions', async () => {
    const child = entry('child', 'child')
    await store.setDir('/literal[1]', [['child', child]])
    await store.setDir('/literal[1]/nested', [['child', child]])
    await store.put('/literal[1]sibling/child', child)
    await store.invalidatePrefix('/literal[1]/', ['/literal[1]/nested/'])
    expect((await store.get('/literal[1]/child')).status).toBe(LookupStatus.NOT_FOUND)
    expect((await store.listDir('/literal[1]')).status).toBe(LookupStatus.NOT_FOUND)
    expect((await store.get('/literal[1]/nested/child')).entry).toBeDefined()
    expect((await store.get('/literal[1]sibling/child')).entry).toBeDefined()
  })

  it('probes a subtree through a seed not yet flushed', async () => {
    store.seed(
      new Map([['/x/dir/sub/f', entry('f', 'f')]]),
      new Map([['/x/dir/sub', ['/x/dir/sub/f']]]),
      new Date(Date.now() + 3600000),
    )
    expect(await store.holdsSubtree('/x/dir')).toBe(true)
  })

  it('rebuilds an evicted path registry before probing a subtree', async () => {
    const client = await redis()
    await store.setDir('/x/dir/sub', [['f', entry('f', 'f')]])
    await client.del(`${prefix}mirage:idx:paths`)
    // An empty registry would read as "nothing below", so a folder delete
    // would keep its subtree; the probe must rebuild it first.
    expect(await store.holdsSubtree('/x/dir')).toBe(true)
    expect(await client.exists(`${prefix}mirage:idx:paths`)).toBe(1)
  })

  async function buried(count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      const dir = `/x/dir/a${String(i).padStart(4, '0')}`
      await store.setDir(dir, [['g', entry('g', 'g')]])
      await store.invalidateDir(dir)
    }
  }

  it('reads one registry page per subtree probe script', async () => {
    // Buried listings stay registered as tombstones; walking all of them in
    // one atomic script would block the shared server for the whole history
    // of the folder.
    const client = await redis()
    await buried(REGISTRY_PAGE + 12)
    const spy = vi.spyOn(client, 'eval')
    try {
      expect(await store.holdsSubtree('/x/dir')).toBe(false)
      expect(
        spy.mock.calls.filter(([script]) => script.includes('return {0, #paths == page')),
      ).toHaveLength(2)
    } finally {
      spy.mockRestore()
    }
  })

  it('finds a live listing at the end of a full page', async () => {
    // The next page starts strictly after the last member read, so the last
    // member of a full page is checked only on that page.
    await buried(REGISTRY_PAGE - 1)
    await store.setDir('/x/dir/z', [['g', entry('g', 'g')]])
    expect(await store.holdsSubtree('/x/dir')).toBe(true)
  })

  it('recovers a cold registry without scanning inside Lua', async () => {
    const client = await redis()
    const child = entry('child', 'child')
    await store.put('/d/sub/orphan', child)
    await client.del(`${prefix}mirage:idx:paths`)
    const evaluate = client.eval.bind(client)
    const multi = client.multi.bind(client)
    const guard = `
local call = redis.call
local redis = {call = function(command, ...)
  if command == 'SCAN' then error('atomic database scan') end
  return call(command, ...)
end}
`
    const spy = vi
      .spyOn(client, 'eval')
      .mockImplementation((script, options) => evaluate(guard + script, options))
    const transactions = vi.spyOn(client, 'multi').mockImplementation(() => {
      const pipe = multi()
      const run = pipe.eval.bind(pipe)
      pipe.eval = (script, options) => run(guard + script, options)
      return pipe
    })
    try {
      await store.setDir('/d', [['sub', entry('sub', 'sub', 'folder')]])
      await store.setDir('/d', [])
      expect((await store.get('/d/sub/orphan')).status).toBe(LookupStatus.NOT_FOUND)
    } finally {
      spy.mockRestore()
      transactions.mockRestore()
    }
  })

  it.each(['invalidatePrefix', 'clear'] as const)(
    'pages large %s operations',
    async (operation) => {
      const client = await redis()
      const child = entry('child', 'child')
      store.seed(
        new Map(Array.from({ length: 400 }, (_, i) => [`/d/${String(i)}`, child])),
        new Map(),
        new Date(Date.now() + 3600000),
      )
      await store.setDir('/other', [])
      const evaluate = client.eval.bind(client)
      const spy = vi.spyOn(client, 'eval').mockImplementation((script, options) =>
        evaluate(
          `
local call = redis.call
local redis = {call = function(command, ...)
  if command == 'ZRANGEBYLEX' then
    local args = {...}
    if args[4] ~= 'LIMIT' or tonumber(args[6]) > 128 then
      error('unbounded registry range')
    end
  end
  return call(command, ...)
end}
${script}`,
          options,
        ),
      )
      try {
        if (operation === 'clear') await store.clear()
        else await store.invalidatePrefix('/d')
        expect(spy.mock.calls.length).toBeGreaterThanOrEqual(4)
        expect((await store.get('/d/0')).status).toBe(LookupStatus.NOT_FOUND)
        expect((await store.get('/d/399')).status).toBe(LookupStatus.NOT_FOUND)
      } finally {
        spy.mockRestore()
      }
    },
  )

  it('restarts registry recovery when Redis evicts it during a scan', async () => {
    const client = await redis()
    const child = entry('child', 'child')
    await store.setDir('/d', [['sub', entry('sub', 'sub', 'folder')]])
    await store.put('/d/sub/old', child)
    await client.del(`${prefix}mirage:idx:paths`)
    const scan = client.scanIterator.bind(client)
    let evicted = false
    const spy = vi.spyOn(client, 'scanIterator').mockImplementation(async function* (options) {
      for await (const batch of scan(options)) {
        if (!evicted) {
          evicted = true
          await client.del(`${prefix}mirage:idx:paths`)
          await store.put('/d/sub/new', child)
        }
        yield batch
      }
    })
    try {
      await store.setDir('/d', [])
      expect(evicted).toBe(true)
      expect((await store.get('/d/sub/old')).status).toBe(LookupStatus.NOT_FOUND)
      expect((await store.get('/d/sub/new')).status).toBe(LookupStatus.NOT_FOUND)
    } finally {
      spy.mockRestore()
    }
  })

  it.each(['/d', '/d/nested'])(
    'does not leave a refill under %s naming rows deleted by later pages',
    async (directory) => {
      const client = await redis()
      const child = entry('child', 'child')
      await store.setDir(
        directory,
        Array.from({ length: 300 }, (_, i) => [String(i).padStart(3, '0'), child]),
      )
      const evaluate = client.eval.bind(client)
      let refilled = false
      const spy = vi.spyOn(client, 'eval').mockImplementation(async (script, options) => {
        const result = await evaluate(script, options)
        if (!refilled && script.includes('local removed = cjson.decode(ARGV[5])')) {
          refilled = true
          await store.setDir(directory, [
            ['000', child],
            ['zzz', child],
          ])
        }
        return result
      })
      try {
        await store.invalidatePrefix('/d')
        expect(refilled).toBe(true)
        expect((await store.get(`${directory}/zzz`)).status).toBe(LookupStatus.NOT_FOUND)
        expect([LookupStatus.NOT_FOUND, LookupStatus.EXPIRED]).toContain(
          (await store.listDir(directory)).status,
        )
      } finally {
        spy.mockRestore()
      }
    },
  )

  it('finishes subtree eviction before a newer listing can be written', async () => {
    const client = await redis()
    const folder = entry('sub', 'sub', 'folder')
    const child = entry('new', 'new')
    await store.setDir('/d', [['sub', folder]])
    await store.setDir('/d/sub', [['new', child]])
    const second = new RedisIndexCacheStore({
      url: REDIS_URL ?? 'redis://127.0.0.1:6379',
      keyPrefix: prefix,
    })
    const evaluate = client.eval.bind(client)
    let interleave = true
    const spy = vi.spyOn(client, 'eval').mockImplementation(async (...args) => {
      const result = await evaluate(...args)
      if (interleave) {
        interleave = false
        await second.setDir('/d', [['sub', folder]])
        await second.setDir('/d/sub', [['new', child]])
      }
      return result
    })
    try {
      await store.setDir('/d', [])
      expect((await second.get('/d/sub')).entry).toBeDefined()
      expect((await second.listDir('/d/sub')).entries).toEqual(['/d/sub/new'])
      expect((await second.get('/d/sub/new')).entry).toBeDefined()
    } finally {
      spy.mockRestore()
      await second.close()
    }
  })

  it('batches cold snapshot directory tokens in a bounded number of requests', async () => {
    const client = await redis()
    const paths = Array.from({ length: 100 }, (_, i) => `/dir-${String(i)}`)
    const get = vi.spyOn(client, 'get')
    const set = vi.spyOn(client, 'set')
    const mGet = vi.spyOn(client, 'mGet')
    const multi = client.multi.bind(client)
    const commands: number[] = []
    let executions = 0
    const transactions = vi.spyOn(client, 'multi').mockImplementation(() => {
      const pipeline = multi()
      const index = commands.length
      commands.push(0)
      const write = pipeline.set.bind(pipeline)
      pipeline.set = (key, value, options) => {
        commands[index] = (commands[index] ?? 0) + 1
        return write(key, value, options)
      }
      const evaluate = pipeline.eval.bind(pipeline)
      pipeline.eval = (script, options) => {
        commands[index] = (commands[index] ?? 0) + 1
        return evaluate(script, options)
      }
      const exec = pipeline.exec.bind(pipeline)
      pipeline.exec = async () => {
        executions += 1
        return exec()
      }
      return pipeline
    })
    try {
      const deadline = new Date(Date.now() + 365 * 24 * 3600000)
      store.seed(new Map(), new Map(paths.map((path) => [path, []])), deadline)
      store.seed(new Map(), new Map([['/dir-0', []]]), deadline)
      await store.entries()
      expect(get).toHaveBeenCalledTimes(1)
      expect(set).toHaveBeenCalledTimes(1)
      expect(mGet).toHaveBeenCalledTimes(1)
      expect(mGet.mock.calls.map(([keys]) => keys.length)).toEqual([100])
      expect(transactions).toHaveBeenCalledTimes(2)
      expect(executions).toBe(2)
      expect(commands).toEqual([101, 102])
    } finally {
      get.mockRestore()
      set.mockRestore()
      mGet.mockRestore()
      transactions.mockRestore()
    }
    expect((await store.listDir('/dir-0')).entries).toEqual([])
    expect((await store.listDir('/dir-99')).entries).toEqual([])
  })

  it('keeps parallel directory refills fresh on a cold store', async () => {
    const paths = Array.from({ length: 50 }, (_, i) => `/dir-${String(i)}`)
    await Promise.all(paths.map((path) => store.setDir(path, [['a', entry('a', 'a')]])))
    for (const path of paths) {
      expect((await store.listDir(path)).entries).toEqual([`${path}/a`])
    }
    await store.invalidate()
    await Promise.all(paths.map((path) => store.setDir(path, [])))
    for (const path of paths) expect((await store.listDir(path)).entries).toEqual([])
  })

  it('preserves an observed directory token while missing seed tokens initialize', async () => {
    const client = await redis()
    await store.setDir('/existing', [])
    const key = `${prefix}mirage:idx:generation:/existing`
    const multi = client.multi.bind(client)
    const spy = vi.spyOn(client, 'multi').mockImplementationOnce(() => {
      const pipeline = multi()
      const exec = pipeline.exec.bind(pipeline)
      pipeline.exec = async () => {
        await client.del(key)
        await client.set(key, 'concurrent-replacement')
        return exec()
      }
      return pipeline
    })
    try {
      store.seed(
        new Map(),
        new Map([
          ['/existing', []],
          ['/missing', []],
        ]),
        new Date(Date.now() + 3600000),
      )
      expect((await store.listDir('/existing')).status).toBe(LookupStatus.EXPIRED)
      expect((await store.listDir('/missing')).entries).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })

  it.each(['none', 'global-change', 'directory-change', 'missing-global', 'missing-directory'])(
    'repeated seeds retain the final snapshot without reviving %s',
    async (race) => {
      const client = await redis()
      await store.setDir('/dir', [])
      await store.setDir('/other', [])
      const deadline = new Date('2090-01-01T00:00:00.123Z')
      const seeds = [
        { directory: '/dir', name: 'a', version: 'dir-1', hours: 0 },
        { directory: '/other', name: 'x', version: 'other-1', hours: 1 },
        { directory: '/dir', name: 'b', version: 'dir-2', hours: 2 },
        { directory: '/other', name: 'y', version: 'other-2', hours: 3 },
        { directory: '/dir', name: 'c', version: 'dir-3', hours: 4 },
      ]
      const rows = new Map<string, FileStat>()
      for (const { directory, name, version, hours } of seeds) {
        const path = `${directory}/${name}`
        const row = entry(version, name)
        rows.set(path, row)
        store.seed(
          new Map([[path, row]]),
          new Map([[directory, [path]]]),
          new Date(deadline.getTime() + hours * 3600000),
          version,
        )
      }
      const multi = client.multi.bind(client)
      let intercepted = false
      const spy = vi.spyOn(client, 'multi').mockImplementation(() => {
        const pipeline = multi()
        const evaluate = pipeline.eval.bind(pipeline)
        let publishesSeed = false
        pipeline.eval = (script, options) => {
          if (
            options.keys[0] === `${prefix}mirage:idx:directory:/dir` &&
            options.arguments[3] === '/dir'
          )
            publishesSeed = true
          return evaluate(script, options)
        }
        const exec = pipeline.exec.bind(pipeline)
        pipeline.exec = async () => {
          if (publishesSeed && !intercepted) {
            intercepted = true
            if (race !== 'none') {
              const key = `${prefix}mirage:idx:generation${
                race === 'directory-change' || race === 'missing-directory' ? ':/dir' : ''
              }`
              if (race.startsWith('missing-')) await client.del(key)
              else await client.set(key, 'concurrent-replacement')
            }
          }
          return exec()
        }
        return pipeline
      })
      try {
        const listing = await store.listDir('/dir')
        expect(intercepted).toBe(true)
        expect(await store.getMany([...rows.keys()])).toEqual(rows)
        const raw = await client.get(`${prefix}mirage:idx:directory:/dir`)
        if (raw === null) throw new Error('missing final seeded listing')
        const snapshot = IndexDirectorySchema.parse(JSON.parse(raw))
        expect(snapshot.entries).toEqual(['/dir/c'])
        expect(snapshot.version).toBe('dir-3')
        expect(snapshot.expires_at).toBe((deadline.getTime() + 4 * 3600000) / 1000)
        if (race === 'none') {
          expect(listing.entries).toEqual(['/dir/c'])
          expect(listing.version).toBe('dir-3')
          expect(await storedStat(store, '/dir/c')).toEqual(rows.get('/dir/c'))
        } else {
          expect(listing.status).toBe(LookupStatus.EXPIRED)
          expect(await storedStat(store, '/dir/c')).toBeNull()
        }
        const other = await store.listDir('/other')
        if (race === 'global-change' || race === 'missing-global') {
          expect(other.status).toBe(LookupStatus.EXPIRED)
        } else {
          expect(other.entries).toEqual(['/other/y'])
          expect(other.version).toBe('other-2')
        }
        await store.setDir('/reviver', [])
        const final = await store.listDir('/dir')
        if (race === 'none') expect(final.entries).toEqual(['/dir/c'])
        else expect(final.status).toBe(LookupStatus.EXPIRED)
      } finally {
        spy.mockRestore()
      }
    },
  )

  it.each(['replaced after initialization', 'lost NX'] as const)(
    'keeps pending seed rows expired when their token was %s',
    async (race) => {
      const client = await redis()
      const peer = new RedisIndexCacheStore({ client, keyPrefix: prefix })
      await store.setDir('/other', [])
      const multi = client.multi.bind(client)
      const spy = vi.spyOn(client, 'multi').mockImplementationOnce(() => {
        const pipeline = multi()
        const exec = pipeline.exec.bind(pipeline)
        pipeline.exec = async () => {
          if (race === 'lost NX') {
            await peer.setDir('/snapshot', [['new', entry('new', 'new')]])
          }
          const result = await exec()
          if (race === 'replaced after initialization') {
            await peer.invalidateDir('/snapshot')
            await peer.setDir('/snapshot', [['new', entry('new', 'new')]])
          }
          return result
        }
        return pipeline
      })
      try {
        store.seed(
          new Map([['/snapshot/old', entry('old', 'old')]]),
          new Map([['/snapshot', ['/snapshot/old']]]),
          new Date(Date.now() + 3600000),
        )
        expect((await store.listDir('/snapshot')).status).toBe(LookupStatus.EXPIRED)
        expect((await store.listDir('/other')).entries).toEqual([])
      } finally {
        spy.mockRestore()
        await peer.close()
      }
    },
  )

  for (const token of ['global', 'directory'] as const) {
    it.each(['replaced after initialization', 'lost NX'] as const)(
      `keeps a scalar refill expired when its ${token} token was %s`,
      async (race) => {
        const client = await redis()
        if (token === 'directory') await store.setDir('/other', [])
        const key = `${prefix}mirage:idx:generation${token === 'directory' ? ':/snapshot' : ''}`
        const set = client.set.bind(client)
        let intercepted = false
        const spy = vi.spyOn(client, 'set').mockImplementation(async (path, value, options) => {
          if (path !== key || intercepted || options?.NX !== true) return set(path, value, options)
          intercepted = true
          if (race === 'lost NX') await set(path, 'concurrent-winner')
          const result = await set(path, value, options)
          if (race === 'replaced after initialization') {
            await client.del(path)
            await set(path, 'concurrent-replacement')
          }
          return result
        })
        const multi = client.multi.bind(client)
        const transactions = vi.spyOn(client, 'multi').mockImplementation(() => {
          const pipeline = multi()
          if (token !== 'directory' || intercepted) return pipeline
          const exec = pipeline.exec.bind(pipeline)
          pipeline.exec = async () => {
            intercepted = true
            if (race === 'lost NX') await set(key, 'concurrent-winner')
            const result = await exec()
            if (race === 'replaced after initialization') {
              await client.del(key)
              await set(key, 'concurrent-replacement')
            }
            return result
          }
          return pipeline
        })
        try {
          await store.setDir('/snapshot', [['old', entry('old', 'old')]])
          expect(intercepted).toBe(true)
          expect((await store.listDir('/snapshot')).status).toBe(LookupStatus.EXPIRED)
        } finally {
          spy.mockRestore()
          transactions.mockRestore()
        }
      },
    )
  }

  it('expires year-long listings when another worker globally invalidates', async () => {
    const deadline = new Date(Date.now() + 365 * 24 * 3600000)
    await store.setDir('/snapshot', [['a', entry('a', 'a')]], deadline)
    await store.setDir('/empty', [], deadline)
    expect((await store.listDir('/snapshot')).entries).toEqual(['/snapshot/a'])
    expect((await store.listDir('/empty')).entries).toEqual([])

    await new RedisIndexCacheStore({ client: await redis(), keyPrefix: prefix }).invalidate()
    expect((await store.listDir('/snapshot')).status).toBe(LookupStatus.EXPIRED)
    expect((await store.listDir('/empty')).status).toBe(LookupStatus.EXPIRED)
    expect((await store.listDir('/absent')).status).toBe(LookupStatus.NOT_FOUND)

    await store.setDir('/other', [], deadline)
    expect((await store.listDir('/other')).entries).toEqual([])
    expect((await store.listDir('/snapshot')).status).toBe(LookupStatus.EXPIRED)
    expect((await store.listDir('/empty')).status).toBe(LookupStatus.EXPIRED)
    await store.setDir('/snapshot', [['b', entry('b', 'b')]], deadline)
    expect((await store.listDir('/snapshot')).entries).toEqual(['/snapshot/b'])
  })

  it('does not revive a refill committed after another worker invalidates its generation', async () => {
    await store.setDir('/snapshot', [])
    const client = await redis()
    const run = client.eval.bind(client)
    const spy = vi.spyOn(client, 'eval').mockImplementationOnce(async (script, options) => {
      await new RedisIndexCacheStore({ client: await redis(), keyPrefix: prefix }).invalidate()
      return run(script, options)
    })
    try {
      await store.setDir('/snapshot', [['old', entry('old', 'old')]])
      expect((await store.listDir('/snapshot')).status).toBe(LookupStatus.EXPIRED)
      await store.setDir('/other', [])
      expect((await store.listDir('/snapshot')).status).toBe(LookupStatus.EXPIRED)
    } finally {
      spy.mockRestore()
    }
  })

  it('narrow invalidation fences a captured directory generation', async () => {
    await store.setDir('/snapshot', [])
    const client = await redis()
    const run = client.eval.bind(client)
    const peer = new RedisIndexCacheStore({ client: await redis(), keyPrefix: prefix })
    const spy = vi.spyOn(client, 'eval').mockImplementationOnce(async (script, options) => {
      await peer.invalidateEntry('/snapshot/old')
      return run(script, options)
    })
    try {
      await store.setDir('/snapshot', [['old', entry('old', 'old')]])
      expect((await store.listDir('/snapshot')).status).toBe(LookupStatus.EXPIRED)
    } finally {
      spy.mockRestore()
    }
  })

  it('narrow invalidation preserves the exact deadline', async () => {
    const deadline = new Date(Date.now() + 3600000)
    await store.setDir('/snapshot', [['a', entry('a', 'a')]], deadline)
    await store.invalidateEntry('/snapshot/a')
    const client = await redis()
    const raw = await client.get(`${prefix}mirage:idx:directory:/snapshot`)
    expect(raw).not.toBeNull()
    if (raw === null) throw new Error('missing parent listing')
    expect(IndexDirectorySchema.parse(JSON.parse(raw)).expires_at).toBe(deadline.getTime() / 1000)
  })

  it('learning a child directory preserves parent freshness fields', async () => {
    const deadline = new Date(Date.now() + 3600000)
    await store.setDir('/dir', [['sub', entry('sub', 'sub')]], deadline, {
      window: true,
      version: 'v1',
    })
    const client = await redis()
    const before = await client.get(`${prefix}mirage:idx:directory:/dir`)
    if (before === null) throw new Error('missing parent listing')
    await store.setDir('/dir/sub', [])
    const after = await client.get(`${prefix}mirage:idx:directory:/dir`)
    if (after === null) throw new Error('missing parent listing')
    const original = IndexDirectorySchema.parse(JSON.parse(before))
    const updated = IndexDirectorySchema.parse(JSON.parse(after))
    expect(updated).toEqual({ ...original, folders: [1] })
    expect(updated.expires_at).toBe(deadline.getTime() / 1000)
  })

  it('seed commit captures a concurrently published child directory', async () => {
    const client = await redis()
    const peer = new RedisIndexCacheStore({ client, keyPrefix: prefix })
    const row = entry('sub', 'sub')
    store.seed(
      new Map([['/dir/sub', row]]),
      new Map([['/dir', ['/dir/sub']]]),
      new Date(Date.now() + 3600000),
    )
    const multi = client.multi.bind(client)
    let inserted = false
    const spy = vi.spyOn(client, 'multi').mockImplementation(() => {
      const pipeline = multi()
      const evaluate = pipeline.eval.bind(pipeline)
      let publishesSeed = false
      pipeline.eval = (script, options) => {
        if (
          options.keys[0] === `${prefix}mirage:idx:directory:/dir` &&
          options.arguments[3] === '/dir'
        )
          publishesSeed = true
        return evaluate(script, options)
      }
      const exec = pipeline.exec.bind(pipeline)
      pipeline.exec = async () => {
        if (publishesSeed && !inserted) {
          inserted = true
          await peer.setDir('/dir/sub', [])
          await peer.put('/dir/sub/stray', entry('stray', 'stray'))
        }
        return exec()
      }
      return pipeline
    })
    try {
      expect((await store.listDir('/dir')).entries).toEqual(['/dir/sub'])
    } finally {
      spy.mockRestore()
      await peer.close()
    }
    expect(inserted).toBe(true)
    await store.invalidateDir('/dir/sub')
    expect(await store.setDir('/dir', [['sub', row]])).toEqual([{ path: '/dir/sub', folder: true }])
    expect((await store.get('/dir/sub/stray')).status).toBe(LookupStatus.NOT_FOUND)
  })

  it.each([false, true])(
    'split seed membership retains directory flags (flushed=%s)',
    async (flushed) => {
      const deadline = new Date(Date.now() + 3600000)
      store.seed(
        new Map([['/dir/sub', new FileStat({ name: 'sub', type: FileType.DIRECTORY })]]),
        new Map(),
        deadline,
      )
      if (flushed) await store.get('/dir/sub')
      store.seed(new Map(), new Map([['/dir', ['/dir/sub']]]), deadline)
      await store.listDir('/dir')
      const raw = await (await redis()).get(`${prefix}mirage:idx:directory:/dir`)
      if (raw === null) throw new Error('missing seeded directory')
      expect(IndexDirectorySchema.parse(JSON.parse(raw)).folders).toEqual([1])
    },
  )

  it('entry-only seeds retain directory history for later subtree eviction', async () => {
    const deadline = new Date(Date.now() + 3600000)
    const file = entry('file', 'sub')
    store.seed(
      new Map([['/dir/sub', entry('directory', 'sub', 'folder')]]),
      new Map([['/dir', ['/dir/sub']]]),
      deadline,
    )
    store.seed(
      new Map([
        ['/dir/sub', file],
        ['/dir/sub/stray', entry('stray', 'stray')],
      ]),
      new Map(),
      deadline,
    )
    expect((await store.listDir('/dir')).entries).toEqual(['/dir/sub'])
    expect((await store.get('/dir/sub')).entry).toEqual(file)
    expect((await store.get('/dir/sub/stray')).entry).toBeDefined()
    expect(await store.setDir('/dir', [['sub', file]])).toEqual([
      { path: '/dir/sub', folder: true },
    ])
    expect((await store.get('/dir/sub/stray')).status).toBe(LookupStatus.NOT_FOUND)
    expect((await store.get('/dir/sub')).entry).toEqual(file)
  })

  it('authoritative add fences a captured directory generation', async () => {
    const old = new FileStat({ name: 'a', type: FileType.FILE, size: 3, fingerprint: 'old' })
    const next = new FileStat({ name: 'a', type: FileType.FILE, size: 11, fingerprint: 'new' })
    await store.setDir('/snapshot', [['a', old]])
    const client = await redis()
    const run = client.eval.bind(client)
    const peer = new RedisIndexCacheStore({ client: await redis(), keyPrefix: prefix })
    const spy = vi.spyOn(client, 'eval').mockImplementationOnce(async (script, options) => {
      await new CacheManager(null, peer, '/snapshot/', true).keepCreated('/a', next)
      expect((await peer.get('/snapshot/a')).entry).toEqual(next)
      return run(script, options)
    })
    try {
      await store.setDir('/snapshot', [['a', old]])
      expect((await store.listDir('/snapshot')).status).toBe(LookupStatus.EXPIRED)
    } finally {
      spy.mockRestore()
    }
  })

  it('batch entry lookup uses one MGET', async () => {
    const entry = new FileStat({ name: 'a', type: FileType.FILE, size: 3 })
    await store.put('/dir/a', entry)
    const client = await redis()
    const read = vi.spyOn(client, 'get')
    const batch = vi.spyOn(client, 'mGet')
    try {
      expect(await store.getMany([])).toEqual(new Map())
      expect(await store.getMany(['/dir/a', '/dir/missing', '/dir/a'])).toEqual(
        new Map([['/dir/a', entry]]),
      )
      expect(read).not.toHaveBeenCalled()
      expect(batch).toHaveBeenCalledExactlyOnceWith([
        `${prefix}mirage:idx:entry:/dir/a`,
        `${prefix}mirage:idx:entry:/dir/missing`,
      ])
    } finally {
      read.mockRestore()
      batch.mockRestore()
    }
  })

  it.each(
    ['add', 'complete', 'window', 'partial', 'seed'].flatMap((publication) =>
      (
        [
          ['a', false],
          ['b', false],
          ['a', true],
          ['b', true],
        ] as const
      ).map(([peerName, ownListing]) => ({ publication, peerName, ownListing })),
    ),
  )(
    'delayed authoritative add preserves a newer $publication publication ($peerName, own listing=$ownListing)',
    async ({ publication, peerName, ownListing }) => {
      const old = new FileStat({ name: 'a', type: FileType.FILE, size: 3, fingerprint: 'old' })
      const next = new FileStat({
        name: peerName,
        type: FileType.FILE,
        size: 11,
        fingerprint: 'new',
      })
      await store.setDir('/dir', [['a', old]])
      if (ownListing) await store.setDir('/dir/a', [])
      const client = await redis()
      const peer = new RedisIndexCacheStore({ client, keyPrefix: prefix })
      const listingKey = `${prefix}mirage:idx:directory:/dir`
      const generationKey = `${prefix}mirage:idx:generation:/dir`
      const multi = client.multi.bind(client)
      let inserted = false
      let expectedListing = ''
      let expectedGeneration: string | null = null
      const spy = vi.spyOn(client, 'multi').mockImplementation(() => {
        const pipe = multi()
        const evaluate = pipe.eval.bind(pipe)
        let publishesAdd = false
        pipe.eval = (script, options) => {
          if (options.keys.length === 5 && options.arguments[2] === '/dir/a') publishesAdd = true
          return evaluate(script, options)
        }
        const exec = pipe.exec.bind(pipe)
        pipe.exec = async () => {
          if (publishesAdd && !inserted) {
            inserted = true
            const rows: [string, FileStat][] =
              peerName === 'a'
                ? [['a', next]]
                : [
                    ['a', old],
                    ['b', next],
                  ]
            if (publication === 'add') {
              await new CacheManager(null, peer, '/dir/', true).keepCreated(`/${peerName}`, next)
            } else if (publication === 'partial') {
              await peer.setPartialDir('/dir', rows)
            } else if (publication === 'seed') {
              peer.seed(
                new Map(rows.map(([name, row]) => [`/dir/${name}`, row])),
                new Map([['/dir', rows.map(([name]) => `/dir/${name}`)]]),
                new Date(Date.now() + 3600000),
              )
              await peer.listDir('/dir')
            } else {
              await peer.setDir('/dir', rows, undefined, { window: publication === 'window' })
            }
            expectedGeneration = await client.get(generationKey)
            expect((await peer.get(`/dir/${peerName}`)).entry).toEqual(next)
            expectedListing = (await client.get(listingKey)) ?? ''
          }
          return exec()
        }
        return pipe
      })
      try {
        await new CacheManager(null, store, '/dir/', true).keepCreated('/a', old)
      } finally {
        spy.mockRestore()
        await peer.close()
      }
      expect(inserted).toBe(true)
      expect((await store.get(`/dir/${peerName}`)).entry).toEqual(next)
      const listing = await store.listDir('/dir')
      expect(listing.entries ?? null).toBeNull()
      expect(listing.partialEntries).toEqual(peerName === 'a' ? [] : ['/dir/b'])
      expect(listing.version ?? null).toBeNull()
      expect(listing.window ?? false).toBe(false)
      expect(await storedStat(store, '/dir/a')).toBeNull()
      if (ownListing)
        expect([LookupStatus.EXPIRED, LookupStatus.NOT_FOUND]).toContain(
          (await store.listDir('/dir/a')).status,
        )
      expect(
        IndexDirectorySchema.parse(JSON.parse((await client.get(listingKey)) ?? '')).expires_at,
      ).toBe(IndexDirectorySchema.parse(JSON.parse(expectedListing)).expires_at)
      expect(await client.get(generationKey)).not.toBe(expectedGeneration)
    },
  )

  it('authoritative add preserves the exact live deadline', async () => {
    const deadline = new Date(Date.now() + 3600000)
    await store.setDir('/dir', [['a', entry('a', 'a')]], deadline, { version: 'v1', window: true })
    await store.addEntry('/dir/a', new FileStat({ name: 'a', type: FileType.FILE, size: 11 }))
    const raw = await (await redis()).get(`${prefix}mirage:idx:directory:/dir`)
    if (raw === null) throw new Error('missing parent listing')
    const listing = IndexDirectorySchema.parse(JSON.parse(raw))
    expect(listing.expires_at).toBe(deadline.getTime() / 1000)
    expect(listing.version).toBe('v1')
    expect(listing.window).toBe(true)
    expect(listing.partial).toBe(false)
  })

  it('authoritative add does not adopt a raced global generation', async () => {
    await store.setDir('/dir', [])
    const client = await redis()
    const peer = new RedisIndexCacheStore({ client: await redis(), keyPrefix: prefix })
    const multi = client.multi.bind(client)
    const spy = vi.spyOn(client, 'multi').mockImplementationOnce(() => {
      const pipe = multi()
      const exec = pipe.exec.bind(pipe)
      pipe.exec = async () => {
        await peer.invalidate()
        return exec()
      }
      return pipe
    })
    try {
      await store.addEntry('/dir/a', new FileStat({ name: 'a', type: FileType.FILE }))
      expect((await store.listDir('/dir')).status).toBe(LookupStatus.EXPIRED)
    } finally {
      spy.mockRestore()
    }
  })

  it('keeps a listing expired when its directory token is removed and recreated', async () => {
    const client = await redis()
    const directoryKey = `${prefix}mirage:idx:generation:/snapshot`
    await store.setDir('/snapshot', [])
    const original = await client.get(directoryKey)
    await client.del(directoryKey)
    expect((await store.listDir('/snapshot')).status).toBe(LookupStatus.EXPIRED)
    await store.setDir('/other', [])
    expect((await store.listDir('/other')).entries).toEqual([])
    expect((await store.listDir('/snapshot')).status).toBe(LookupStatus.EXPIRED)
    await client.set(directoryKey, 'replacement-token')
    expect((await store.listDir('/snapshot')).status).toBe(LookupStatus.EXPIRED)
    await client.del(directoryKey)
    await store.setDir('/snapshot', [])
    expect(await client.get(directoryKey)).not.toBe(original)
    expect((await store.listDir('/snapshot')).entries).toEqual([])
  })

  it('keeps a late refill expired after its directory token is deleted', async () => {
    const client = await redis()
    const directoryKey = `${prefix}mirage:idx:generation:/snapshot`
    await store.setDir('/snapshot', [])
    const run = client.eval.bind(client)
    const spy = vi.spyOn(client, 'eval').mockImplementationOnce(async (script, options) => {
      await client.del(directoryKey)
      return run(script, options)
    })
    try {
      await store.setDir('/snapshot', [['old', entry('old', 'old')]])
      expect((await store.listDir('/snapshot')).status).toBe(LookupStatus.EXPIRED)
      await store.setDir('/other', [])
      expect((await store.listDir('/snapshot')).status).toBe(LookupStatus.EXPIRED)
    } finally {
      spy.mockRestore()
    }
  })

  it('globally invalidates listings while retaining current metadata', async () => {
    await store.setDir('/snapshot', [['a', entry('new', 'a')]])
    await store.setDir('/empty', [])
    await store.invalidate()

    expect((await store.get('/snapshot/a')).entry?.fingerprint).toBe('new')
    expect((await store.listDir('/snapshot')).status).toBe(LookupStatus.EXPIRED)
    expect((await store.listDir('/empty')).status).toBe(LookupStatus.EXPIRED)
    await store.setDir('/snapshot', [])
    expect((await store.listDir('/snapshot')).entries).toEqual([])
    expect((await store.listDir('/empty')).status).toBe(LookupStatus.EXPIRED)
  })

  it.each(['invalidateDir', 'invalidatePrefix', 'clear'] as const)(
    '%s respects literal custom namespaces and paths',
    async (method) => {
      const client = await redis()
      const stores = ['custom:[1]:', 'custom:1:'].map(
        (suffix) => new RedisIndexCacheStore({ client, keyPrefix: prefix + suffix }),
      )
      const [isolated, neighbor] = stores as [RedisIndexCacheStore, RedisIndexCacheStore]
      try {
        for (const target of stores) {
          for (const directory of ['/repo[1]', '/repo1']) {
            await target.setDir(directory, [['a', entry('a', 'a')]])
          }
        }
        if (method === 'clear') await isolated.clear()
        else await isolated[method]('/repo[1]')
        expect((await isolated.get('/repo[1]/a')).status).toBe(LookupStatus.NOT_FOUND)
        expect((await isolated.listDir('/repo[1]')).status).toBe(LookupStatus.NOT_FOUND)
        expect((await neighbor.listDir('/repo[1]')).entries).toEqual(['/repo[1]/a'])
        expect((await neighbor.listDir('/repo1')).entries).toEqual(['/repo1/a'])
        if (method !== 'clear') {
          expect((await isolated.listDir('/repo1')).entries).toEqual(['/repo1/a'])
        }
      } finally {
        for (const target of stores) {
          await target.clear()
          await target.close()
        }
      }
    },
  )

  // Redis eviction can drop a row while its listing survives. The store
  // serves the listing as written; the reader that finds a listed name with
  // no row refills on demand.
  it('serves a versioned listing missing a child row', async () => {
    await store.setDir(
      '/d',
      [
        ['a', entry('a', 'a')],
        ['b', entry('b', 'b')],
      ],
      undefined,
      { version: 'v1' },
    )
    await (await redis()).del(`${prefix}mirage:idx:entry:/d/b`)
    const listing = await store.listDir('/d')
    expect(listing.entries).toEqual(['/d/a', '/d/b'])
    expect(listing.version).toBe('v1')
  })

  it('serves an empty versioned listing', async () => {
    await store.setDir('/e', [], undefined, { version: 'v1' })
    const listing = await store.listDir('/e')
    expect(listing.entries).toEqual([])
    expect(listing.version).toBe('v1')
  })

  it('get returns NOT_FOUND when missing', async () => {
    const r = await store.get('/nope')
    expect(r.status).toBe(LookupStatus.NOT_FOUND)
  })

  // The one wire format: what pydantic writes for a FileStat, snake_case and
  // every field. `test_redis.py` pins the same literal, so a row either
  // language writes is one the other reads.
  it('writes the row JSON Python writes', async () => {
    await store.put(
      '/a.txt',
      new FileStat({
        name: 'a.txt',
        type: FileType.FILE,
        size: 6,
        modified: '2026-01-01T00:00:00Z',
        fingerprint: '/a.txt',
      }),
    )
    const c = await redis()
    expect(await c.get(`${prefix}mirage:idx:entry:/a.txt`)).toBe(
      '{"name":"a.txt","size":6,"modified":"2026-01-01T00:00:00Z","fingerprint":"/a.txt","revision":null,"type":"file","content":null,"mode":null,"uid":null,"gid":null,"atime":null,"ctime":null,"birthtime":null,"dev":null,"extra":{}}',
    )
  })

  it('reads the row JSON Python writes', async () => {
    const c = await redis()
    await c.set(
      `${prefix}mirage:idx:entry:/b.txt`,
      '{"name":"b.txt","size":null,"modified":null,"fingerprint":"/b.txt","revision":null,"type":"file","content":null,"mode":null,"uid":null,"gid":null,"atime":null,"ctime":null,"birthtime":null,"dev":null,"extra":{"size_bytes":9}}',
    )
    const r = await store.get('/b.txt')
    expect(r.entry?.type).toBe(FileType.FILE)
    expect(r.entry?.size).toBeNull()
    expect(r.entry?.extra).toEqual({ size_bytes: 9 })
  })

  it('put + get round-trips entry metadata', async () => {
    const extra = { drive_id: 'drive-a', nested: { slug: 'alpha', tags: ['x', 'y'] } }
    await store.put(
      '/a',
      new FileStat({ name: 'a', type: FileType.FILE, fingerprint: 'id-a', extra }),
    )
    const r = await store.get('/a')
    expect(r.entry?.fingerprint).toBe('id-a')
    expect(r.entry?.name).toBe('a')
    expect(r.entry?.extra).toEqual(extra)
  })

  it('setDir + get round-trips metadata and default empty extra', async () => {
    const extra = { attachment: { url: 'https://example.test/file', size: 42 } }
    await store.setDir('/dir', [
      [
        'with-extra',
        new FileStat({ name: 'with-extra', type: FileType.FILE, fingerprint: 'id-extra', extra }),
      ],
      ['without-extra', entry('id-empty', 'without-extra')],
    ])

    expect((await store.get('/dir/with-extra')).entry?.extra).toEqual(extra)
    expect((await store.get('/dir/without-extra')).entry?.extra).toEqual({})
  })

  it('setDir stores entries and listDir preserves insertion (readdir) order', async () => {
    await store.setDir('/', [
      ['b', entry('id-b', 'b')],
      ['a', entry('id-a', 'a')],
    ])
    const list = await store.listDir('/')
    expect(list.entries).toEqual(['/b', '/a'])
  })

  it('clear wipes everything under prefix', async () => {
    await store.put('/a', entry('id-a', 'a'))
    await store.setDir('/', [['a', entry('id-a', 'a')]])
    await store.clear()
    expect((await store.get('/a')).status).toBe(LookupStatus.NOT_FOUND)
    expect((await store.listDir('/')).status).toBe(LookupStatus.NOT_FOUND)
  })
})

describe('Redis client protocol', () => {
  function client() {
    const pipeline: ReturnType<RedisClientLike['multi']> = {
      eval: vi.fn(),
      set: vi.fn(),
      del: vi.fn(),
      exec: vi.fn().mockResolvedValue([]),
    }
    const value: RedisClientLike = {
      get: vi.fn().mockResolvedValue(null),
      mGet: vi.fn().mockResolvedValue([null, null, null]),
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(0),
      multi: () => pipeline,
      eval: vi.fn().mockResolvedValue([[], []]),
      exists: vi.fn().mockResolvedValue(0),
      scanIterator: () => {
        throw new Error('unexpected scan')
      },
      connect: vi.fn().mockResolvedValue(undefined),
      quit: vi.fn().mockResolvedValue(undefined),
      isOpen: true,
    }
    return { value, pipeline }
  }

  it.each([0, 1])('conditional replacement passes exact wire bytes to CAS: %s', async (result) => {
    const { value, pipeline } = client()
    const old = entry('old', 'a')
    const raw = ' { "type": "file", "name": "a", "fingerprint": "old" } '
    vi.mocked(value.get).mockResolvedValue(raw)
    vi.mocked(value.eval).mockResolvedValue(result)
    const store = new RedisIndexCacheStore({ client: value })
    expect(await store.replaceIfUnchanged('/a', JSON.stringify(old), entry('confirmed', 'a'))).toBe(
      result === 1,
    )
    expect(value.get).toHaveBeenCalledTimes(1)
    expect(value.eval).toHaveBeenCalledTimes(1)
    const call = vi.mocked(value.eval).mock.calls[0]
    if (call === undefined) throw new Error('missing CAS call')
    expect(call[1].keys).toEqual(vi.mocked(value.get).mock.calls[0])
    expect(call[1].arguments[0]).toBe(raw)
    const replacement = call[1].arguments[1]
    if (replacement === undefined) throw new Error('missing CAS replacement')
    expect((JSON.parse(replacement) as { fingerprint: string }).fingerprint).toBe('confirmed')
    expect(value.set).not.toHaveBeenCalled()
    expect(pipeline.exec).not.toHaveBeenCalled()
  })

  it.each([null, JSON.stringify(entry('other', 'a'))])(
    'conditional replacement skips absent or changed rows: %s',
    async (raw) => {
      const { value } = client()
      vi.mocked(value.get).mockResolvedValue(raw)
      const store = new RedisIndexCacheStore({ client: value })
      expect(
        await store.replaceIfUnchanged(
          '/a',
          JSON.stringify(entry('old', 'a')),
          entry('confirmed', 'a'),
        ),
      ).toBe(false)
      expect(value.eval).not.toHaveBeenCalled()
    },
  )

  it('retains failed seeds for a close retry', async () => {
    const { value, pipeline } = client()
    vi.mocked(pipeline.exec).mockRejectedValueOnce(new Error('retry'))
    vi.mocked(value.get).mockResolvedValue('g')
    vi.mocked(value.mGet).mockResolvedValue(['d'])
    const store = new RedisIndexCacheStore({ client: value })
    store.seed(
      new Map([['/a', entry('a', 'a')]]),
      new Map([['/', ['/a']]]),
      new Date(Date.now() + 3600000),
    )
    await expect(store.close()).rejects.toThrow('retry')
    await store.close()
    await store.close()
    expect(pipeline.exec).toHaveBeenCalledTimes(2)
    const writes = vi.mocked(pipeline.set).mock.calls
    expect(writes.slice(0, 1)).toEqual(writes.slice(1))
    const scripts = vi.mocked(pipeline.eval).mock.calls
    expect(scripts).toHaveLength(4)
    expect(scripts[0]).toEqual(scripts[2])
    expect(scripts[1]?.[0]).toEqual(scripts[3]?.[0])
    expect(scripts[1]?.[1].keys).toEqual(scripts[3]?.[1].keys)
    expect(scripts[1]?.[1].arguments.slice(0, -1)).toEqual(scripts[3]?.[1].arguments.slice(0, -1))
    expect(scripts[1]?.[1].arguments.at(-1)).toBeTruthy()
    expect(scripts[3]?.[1].arguments.at(-1)).toBeTruthy()
    expect(value.quit).not.toHaveBeenCalled()
  })

  it('flushes a seed once across concurrent readers', async () => {
    const { value, pipeline } = client()
    vi.mocked(value.mGet).mockResolvedValue(['d'])
    const store = new RedisIndexCacheStore({ client: value })
    store.seed(
      new Map([['/a', entry('a', 'a')]]),
      new Map([['/', ['/a']]]),
      new Date(Date.now() + 3600000),
    )
    await Promise.all([store.get('/a'), store.get('/a')])
    expect(pipeline.exec).toHaveBeenCalledTimes(1)
  })

  it('retries a failed initializer shared by parallel directory refills', async () => {
    const { value } = client()
    let rejectRead: (error: Error) => void = () => undefined
    const read = new Promise<string | null>((_resolve, reject) => {
      rejectRead = reject
    })
    vi.mocked(value.get).mockReturnValueOnce(read)
    const store = new RedisIndexCacheStore({ client: value })
    const pending = Promise.allSettled([store.setDir('/one', []), store.setDir('/two', [])])
    await vi.waitFor(() => {
      expect(value.get).toHaveBeenCalledTimes(1)
    })
    rejectRead(new Error('retry'))
    const results = await pending
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected'])
    expect(value.get).toHaveBeenCalledTimes(1)
    await expect(store.setDir('/one', [])).resolves.toEqual([])
    expect(value.get).toHaveBeenCalledTimes(3)
  })

  it('keeps listings stale when their generation key is evicted', async () => {
    const { value } = client()
    const raw = JSON.stringify({
      entries: [],
      folders: [],
      expires_at: 4102444800,
      generation: 'old:dir',
    })
    vi.mocked(value.mGet).mockResolvedValue([raw, null, 'dir'])
    const store = new RedisIndexCacheStore({ client: value })
    expect((await store.listDir('/old')).status).toBe(LookupStatus.EXPIRED)
    await store.setDir('/new', [])
    const generation = vi.mocked(value.set).mock.calls[0]?.[1]
    expect(generation).toBeDefined()
    expect(generation).not.toBe('old')
    expect(value.eval).toHaveBeenCalled()
    vi.mocked(value.mGet).mockResolvedValue([raw, generation ?? null, 'dir'])
    expect((await store.listDir('/old')).status).toBe(LookupStatus.EXPIRED)
  })

  it('reads a row without a version key as unversioned', async () => {
    const { value } = client()
    vi.mocked(value.mGet).mockResolvedValue([
      JSON.stringify({
        entries: ['/d/a'],
        folders: [0],
        expires_at: 4102444800,
        generation: 'g:d',
      }),
      'g',
      'd',
    ])
    const store = new RedisIndexCacheStore({ client: value })
    const listing = await store.listDir('/d')
    expect(listing.entries).toEqual(['/d/a'])
    expect(listing.version).toBeNull()
  })

  it('reads a listing and its invalidation generation in one request', async () => {
    const { value } = client()
    vi.mocked(value.mGet).mockResolvedValue([
      JSON.stringify({ entries: [], folders: [], expires_at: 4102444800, generation: 'g:d' }),
      'g',
      'd',
    ])
    const store = new RedisIndexCacheStore({ client: value })
    expect((await store.listDir('/')).entries).toEqual([])
    expect(value.mGet).toHaveBeenCalledTimes(1)
    expect(value.mGet).toHaveBeenCalledWith([
      'mirage:index:mirage:idx:directory:/',
      'mirage:index:mirage:idx:generation',
      'mirage:index:mirage:idx:generation:/',
    ])
    expect(value.get).not.toHaveBeenCalled()
  })
})

function row(name: string, fingerprint = name): FileStat {
  return new FileStat({ name, type: FileType.FILE, fingerprint })
}

const LISTED: [string, FileStat][] = [
  ['a', row('a')],
  ['b', row('b')],
]

type StoreWrite = (store: RedisIndexCacheStore) => Promise<unknown>

const COUNTING = {
  seed: (store) => {
    store.seed(
      new Map([['/d/c', row('c')]]),
      new Map([['/d', ['/d/a', '/d/b', '/d/c']]]),
      new Date(Date.now() + 60000),
    )
    return Promise.resolve()
  },
  addEntry: (store) => store.addEntry('/d/c', row('c')),
  setDir: (store) => store.setDir('/d', [['a', row('a')]]),
  setPartialDir: (store) => store.setPartialDir('/d', [['c', row('c')]]),
  invalidateEntry: (store) => store.invalidateEntry('/d/a'),
  invalidateDir: (store) => store.invalidateDir('/d'),
  invalidatePrefix: (store) => store.invalidatePrefix('/d'),
  invalidate: (store) => store.invalidate(),
  clear: (store) => store.clear(),
} satisfies Record<string, StoreWrite>

const NOT_COUNTING = {
  put: (store) => store.put('/d/a', row('a', 'new')),
  replaceIfUnchanged: async (store) => {
    expect(await store.replaceIfUnchanged('/d/a', JSON.stringify(row('a')), row('a', 'new'))).toBe(
      true,
    )
  },
} satisfies Record<string, StoreWrite>

type StoreRead =
  | 'ttl'
  | 'clock'
  | 'scopeSnapshot'
  | 'get'
  | 'getMany'
  | 'listDir'
  | 'reportGone'
  | 'entries'
  | 'listedThisCommand'
  | 'holdsSubtree'
  | 'close'

type Classified = keyof typeof COUNTING | keyof typeof NOT_COUNTING | StoreRead
const CLASSIFIED: [
  Exclude<keyof RedisIndexCacheStore, Classified>,
  Exclude<Classified, keyof RedisIndexCacheStore>,
] extends [never, never]
  ? true
  : false = true

describe.skipIf(skip)('RedisIndexCacheStore listing reads in one command', () => {
  const prefix = `mirage:idx:test:${String(Date.now())}:${Math.random().toString(36).slice(2)}:`
  let store: RedisIndexCacheStore
  let peer: RedisIndexCacheStore

  beforeEach(async () => {
    store = new RedisIndexCacheStore({ url: REDIS_URL ?? '', keyPrefix: prefix, ttl: 60 })
    peer = new RedisIndexCacheStore({ url: REDIS_URL ?? '', keyPrefix: prefix, ttl: 60 })
    await store.clear()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await store.clear()
    await store.close()
    await peer.close()
  })

  it.each(Object.keys(NOT_COUNTING) as (keyof typeof NOT_COUNTING)[])(
    'refreshes row batches after own and peer %s writes',
    async (method) => {
      for (const writer of [store, peer]) {
        await store.setDir('/d', LISTED)
        const sent = await mGets()
        await runInCommandScope(async () => {
          await store.listDir('/d')
          expect((await store.get('/d/a')).entry?.fingerprint).not.toBe('new')
          await NOT_COUNTING[method](writer)
          expect((await store.get('/d/a')).entry?.fingerprint).toBe('new')
          await store.get('/d/b')
        })
        expect(sent.mock.calls).toHaveLength(3)
        vi.restoreAllMocks()
      }
    },
  )

  it('keeps the siblings of a written row batched', async () => {
    await store.setDir('/d', LISTED)
    const sent = await mGets()
    await runInCommandScope(async () => {
      await store.listDir('/d')
      for (const name of ['a', 'b']) {
        const path = `/d/${name}`
        const before = (await store.get(path)).entry
        if (before == null) throw new Error(`missing ${path}`)
        expect(
          await store.replaceIfUnchanged(
            path,
            JSON.stringify(before),
            before.with({ fingerprint: 'new' }),
          ),
        ).toBe(true)
      }
    })
    expect(sent.mock.calls).toHaveLength(2)
  })

  it('reads external row changes at the next command', async () => {
    await store.setDir('/d', LISTED)
    await runInCommandScope(async () => {
      await store.listDir('/d')
      await store.get('/d/a')
    })
    const c = await redis()
    await c.set(`${prefix}${ENTRY_PREFIX}/d/a`, JSON.stringify(row('a', 'external')))
    await runInCommandScope(async () => {
      await store.listDir('/d')
      expect((await store.get('/d/a')).entry?.fingerprint).toBe('external')
    })
  })

  async function redis(): Promise<RedisClientLike> {
    return (store as unknown as { client: () => Promise<RedisClientLike> }).client()
  }

  async function mGets(): Promise<{ mock: { calls: unknown[] } }> {
    return vi.spyOn(await redis(), 'mGet')
  }

  it.each(Object.keys(COUNTING) as (keyof typeof COUNTING)[])(
    'sees a listing write by %s in the same command',
    async (method) => {
      await store.setDir('/d', LISTED)
      const [before, after] = await runInCommandScope(async () => {
        const first = await store.listDir('/d')
        await COUNTING[method](store)
        return [first, await store.listDir('/d')] as const
      })
      expect(after).toEqual(await peer.listDir('/d'))
      expect(after).not.toEqual(before)
    },
  )

  it.each(Object.keys(NOT_COUNTING) as (keyof typeof NOT_COUNTING)[])(
    'keeps the listing read across a row write by %s',
    async (method) => {
      await store.setDir('/d', LISTED)
      const sent = await mGets()
      const [before, after] = await runInCommandScope(async () => {
        const first = await store.listDir('/d')
        await NOT_COUNTING[method](store)
        return [first, await store.listDir('/d')] as const
      })
      expect(after).toEqual(before)
      expect(sent.mock.calls).toHaveLength(1)
      expect((await store.get('/d/a')).entry?.fingerprint).toBe('new')
    },
  )

  it('classifies every store method', () => {
    expect(CLASSIFIED).toBe(true)
  })

  it('keeps the listing read across a write on another keyspace', async () => {
    const other = new RedisIndexCacheStore({ url: REDIS_URL ?? '', keyPrefix: `${prefix}other:` })
    await store.setDir('/d', LISTED)
    const sent = await mGets()
    try {
      await runInCommandScope(async () => {
        await store.listDir('/d')
        await other.setDir('/d', [['z', row('z')]])
        await store.listDir('/d')
      })
    } finally {
      await other.clear()
      await other.close()
    }
    expect(sent.mock.calls).toHaveLength(1)
  })

  it('ends a listing read in a command at its expiry on the store clock', async () => {
    const clock = new ManualClock(4_000_000_000)
    const timed = new RedisIndexCacheStore({
      url: REDIS_URL ?? '',
      keyPrefix: prefix,
      ttl: 60,
      clock,
    })
    try {
      await timed.setDir('/d', LISTED)
      const after = await runInCommandScope(async () => {
        expect((await timed.listDir('/d')).entries).toEqual(['/d/a', '/d/b'])
        clock.advance(60)
        return timed.listDir('/d')
      })
      expect(after.status).toBe(LookupStatus.EXPIRED)
    } finally {
      await timed.close()
    }
  })

  it('sees a write by a peer store on the same keyspace', async () => {
    await store.setDir('/d', LISTED)
    const after = await runInCommandScope(async () => {
      await store.listDir('/d')
      await peer.invalidateEntry('/d/a')
      return store.listDir('/d')
    })
    expect(after.partialEntries).toEqual(['/d/b'])
  })

  it('sees a peer store seed once it is flushed', async () => {
    await store.setDir('/d', LISTED)
    const after = await runInCommandScope(async () => {
      await COUNTING.seed(peer)
      await store.listDir('/d')
      await peer.get('/d/c')
      return store.listDir('/d')
    })
    expect(after.entries).toEqual(['/d/a', '/d/b', '/d/c'])
  })

  it('does not keep a read made during an unfinished write', async () => {
    await store.setDir('/d', LISTED)
    const c = await redis()
    const evaluate = c.eval.bind(c)
    let entered!: () => void
    const entering = new Promise<void>((resolve) => (entered = resolve))
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    vi.spyOn(c, 'eval').mockImplementation(async (script, options) => {
      entered()
      await released
      return evaluate(script, options)
    })
    const after = await runInCommandScope(async () => {
      const writing = store.invalidateEntry('/d/a')
      await entering
      expect((await store.listDir('/d')).entries).toEqual(['/d/a', '/d/b'])
      release()
      await writing
      return store.listDir('/d')
    })
    expect(after.partialEntries).toEqual(['/d/b'])
  })

  it('reads a missing or expired listing each time', async () => {
    await store.setDir('/d', LISTED)
    await store.invalidate()
    const sent = await mGets()
    await runInCommandScope(async () => {
      for (const [folder, status] of [
        ['/missing', LookupStatus.NOT_FOUND],
        ['/d', LookupStatus.EXPIRED],
      ] as const) {
        for (let n = 0; n < 2; n++) expect((await store.listDir(folder)).status).toBe(status)
      }
    })
    expect(sent.mock.calls).toHaveLength(4)
  })
})
