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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IndexEntry, LookupStatus } from './config.ts'
import { REGISTRY_PAGE } from './constants.ts'
import { RedisIndexCacheStore, type RedisClientLike } from './redis.ts'

describe('RedisIndexCacheStore default keyPrefix', () => {
  it('namespaces keys under mirage:index: by default', () => {
    const store = new RedisIndexCacheStore()
    const prefix = (store as unknown as { entryPrefix: string }).entryPrefix
    expect(prefix).toBe('mirage:index:mirage:idx:entry:')
  })
})

const REDIS_URL = process.env.REDIS_URL
const skip = REDIS_URL === undefined

function entry(id: string, name: string, resourceType = 'file'): IndexEntry {
  return new IndexEntry({ id, name, resourceType })
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
    const raw = JSON.stringify(Object.fromEntries(Object.entries(old.toJSON()).reverse()), null, 2)
    await client.set(key, raw)
    const latest = old.copyWith({ size: 9 })
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
    if (peer === 'none') expect(current?.id).toBe('confirmed')
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
    expect(await members()).toEqual([''])
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
      expect(commands).toEqual([100, 101])
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

    expect((await store.get('/snapshot/a')).entry?.id).toBe('new')
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

  // The one wire format: what pydantic writes for the Python IndexEntry,
  // snake_case and every field. `test_redis.py` pins the same literal, so an
  // entry either language writes is one the other reads (#1020).
  it('writes the entry JSON Python writes', async () => {
    await store.put(
      '/a.txt',
      new IndexEntry({
        id: '/a.txt',
        name: 'a.txt',
        resourceType: 'file',
        remoteTime: '2026-01-01T00:00:00Z',
        indexTime: '2026-01-01T00:00:00Z',
        size: 6,
      }),
    )
    const c = await redis()
    expect(await c.get(`${prefix}mirage:idx:entry:/a.txt`)).toBe(
      '{"id":"/a.txt","name":"a.txt","resource_type":"file","remote_time":"2026-01-01T00:00:00Z","index_time":"2026-01-01T00:00:00Z","vfs_name":"","size":6,"extra":{}}',
    )
  })

  it('reads the entry JSON Python writes', async () => {
    const c = await redis()
    await c.set(
      `${prefix}mirage:idx:entry:/b.txt`,
      '{"id":"/b.txt","name":"b.txt","resource_type":"file","remote_time":"","index_time":"2026-01-01T00:00:00Z","vfs_name":"","size":null,"extra":{"size_bytes":9}}',
    )
    const r = await store.get('/b.txt')
    expect(r.entry?.resourceType).toBe('file')
    expect(r.entry?.indexTime).toBe('2026-01-01T00:00:00Z')
    expect(r.entry?.size).toBeNull()
    expect(r.entry?.extra).toEqual({ size_bytes: 9 })
  })

  it('put + get round-trips entry metadata', async () => {
    const extra = { drive_id: 'drive-a', nested: { slug: 'alpha', tags: ['x', 'y'] } }
    await store.put('/a', new IndexEntry({ id: 'id-a', name: 'a', resourceType: 'file', extra }))
    const r = await store.get('/a')
    expect(r.entry?.id).toBe('id-a')
    expect(r.entry?.name).toBe('a')
    expect(r.entry?.indexTime).not.toBe('')
    expect(r.entry?.extra).toEqual(extra)
  })

  it('setDir + get round-trips metadata and default empty extra', async () => {
    const extra = { attachment: { url: 'https://example.test/file', size: 42 } }
    await store.setDir('/dir', [
      [
        'with-extra',
        new IndexEntry({ id: 'id-extra', name: 'with-extra', resourceType: 'file', extra }),
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

  it('listDir NOT_FOUND when unset', async () => {
    const r = await store.listDir('/ghost')
    expect(r.status).toBe(LookupStatus.NOT_FOUND)
  })

  it('invalidateDir removes children entry', async () => {
    await store.setDir('/x', [['f', entry('id-f', 'f')]])
    await store.invalidateDir('/x')
    const r = await store.listDir('/x')
    expect(r.status).toBe(LookupStatus.NOT_FOUND)
  })

  it('setDir sets TTL based on default ttl', async () => {
    const s = new RedisIndexCacheStore(
      REDIS_URL !== undefined
        ? { url: REDIS_URL, keyPrefix: prefix, ttl: 1 }
        : { keyPrefix: prefix, ttl: 1 },
    )
    try {
      await s.setDir('/tmp', [['x', entry('id-x', 'x')]])
      expect((await s.listDir('/tmp')).entries).toEqual(['/tmp/x'])
      await new Promise((r) => setTimeout(r, 1100))
      const r = await s.listDir('/tmp')
      expect(r.status).toBe(LookupStatus.EXPIRED)
    } finally {
      await s.clear()
      await s.close()
    }
  })

  it('invalidatePrefix drops nested listings', async () => {
    await store.setDir('/chan/day', [['chat.jsonl', entry('1', 'chat.jsonl')]])
    await store.setDir('/chan/day/files', [['a.png', entry('2', 'a.png')]])
    await store.invalidatePrefix('/chan/day')
    expect((await store.listDir('/chan/day')).status).toBe(LookupStatus.NOT_FOUND)
    expect((await store.listDir('/chan/day/files')).status).toBe(LookupStatus.NOT_FOUND)
    expect((await store.get('/chan/day/files/a.png')).status).toBe(LookupStatus.NOT_FOUND)
  })

  it('invalidatePrefix respects the path boundary', async () => {
    await store.setDir('/chan/day', [['a', entry('1', 'a')]])
    await store.setDir('/chan/daytime', [['b', entry('2', 'b')]])
    await store.invalidatePrefix('/chan/day')
    expect((await store.listDir('/chan/day')).status).toBe(LookupStatus.NOT_FOUND)
    expect((await store.listDir('/chan/daytime')).entries).toEqual(['/chan/daytime/b'])
  })

  it('invalidatePrefix handles glob metacharacters', async () => {
    await store.setDir('/chan/a[1]', [['x', entry('1', 'x')]])
    await store.setDir('/chan/ab', [['y', entry('2', 'y')]])
    await store.invalidatePrefix('/chan/a[1]')
    expect((await store.listDir('/chan/a[1]')).status).toBe(LookupStatus.NOT_FOUND)
    expect((await store.listDir('/chan/ab')).entries).toEqual(['/chan/ab/y'])
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
    const raw = ' { "resource_type": "file", "name": "a", "id": "old" } '
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
    expect(IndexEntry.fromJSON(replacement).id).toBe('confirmed')
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
    expect(writes.slice(0, 2)).toEqual(writes.slice(2))
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
    const raw = JSON.stringify({ entries: [], expires_at: 4102444800, generation: 'old:dir' })
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
      JSON.stringify({ entries: ['/d/a'], expires_at: 4102444800, generation: 'g:d' }),
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
      JSON.stringify({ entries: [], expires_at: 4102444800, generation: 'g:d' }),
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
