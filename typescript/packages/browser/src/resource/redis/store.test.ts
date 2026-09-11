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
import { createFakeUpstash } from '../../test-utils.ts'
import { UpstashRedisStore } from './store.ts'

const ENC = new TextEncoder()
const ALL_BYTES = Uint8Array.from({ length: 256 }, (_, i) => i)

function make(options: { scanPageSize?: number; maxRequestBytes?: number } = {}) {
  const fake = createFakeUpstash(
    options.scanPageSize !== undefined ? { scanPageSize: options.scanPageSize } : {},
  )
  const store = new UpstashRedisStore({
    url: fake.url,
    token: fake.token,
    keyPrefix: 'mirage:fs:',
    fetchImpl: fake.fetch,
    ...(options.maxRequestBytes !== undefined ? { maxRequestBytes: options.maxRequestBytes } : {}),
  })
  return { fake, store }
}

function countingFetch(fake: ReturnType<typeof createFakeUpstash>, sizes: number[]): typeof fetch {
  return (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.endsWith('/pipeline') && typeof init?.body === 'string') {
      sizes.push((JSON.parse(init.body) as unknown[]).length)
    }
    return fake.fetch(input, init)
  }
}

function bodyBytesFetch(fake: ReturnType<typeof createFakeUpstash>, sizes: number[]): typeof fetch {
  return (input, init) => {
    if (typeof init?.body === 'string') sizes.push(ENC.encode(init.body).byteLength)
    return fake.fetch(input, init)
  }
}

describe('UpstashRedisStore', () => {
  it('open seeds the root directory', async () => {
    const { store } = make()
    expect(await store.hasDir('/')).toBe(false)
    await store.open()
    expect(await store.hasDir('/')).toBe(true)
  })

  it('setFile and getFile round-trip every byte value', async () => {
    const { store } = make()
    await store.setFile('/a.bin', ALL_BYTES)
    expect(await store.getFile('/a.bin')).toEqual(ALL_BYTES)
    expect(await store.fileLen('/a.bin')).toBe(256)
  })

  it('getFile returns null for a missing file', async () => {
    const { store } = make()
    expect(await store.getFile('/nope')).toBeNull()
    expect(await store.hasFile('/nope')).toBe(false)
  })

  it('writes an empty file', async () => {
    const { store } = make()
    await store.setFile('/empty', new Uint8Array(0))
    expect(await store.hasFile('/empty')).toBe(true)
    expect(await store.fileLen('/empty')).toBe(0)
    expect(await store.getFile('/empty')).toEqual(new Uint8Array(0))
  })

  it('splits a write larger than maxRequestBytes into one set and appends', async () => {
    const { fake, store } = make({ maxRequestBytes: 100 })
    await store.setFile('/big', ALL_BYTES)
    expect(await store.getFile('/big')).toEqual(ALL_BYTES)
    expect(fake.commands.filter((c) => c === 'SET')).toHaveLength(1)
    expect(fake.commands.filter((c) => c === 'APPEND')).toHaveLength(2)
    expect(fake.commands.filter((c) => c === 'RENAME')).toHaveLength(1)
    expect(fake.keys()).toEqual(['mirage:fs:file:/big'])
  })

  it('a chunked write that fails leaves the previous content and no temp key', async () => {
    const fake = createFakeUpstash()
    let failAppend = false
    const flaky: typeof fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (failAppend && url.includes('/append/')) {
        return Promise.reject(new TypeError('network down'))
      }
      return fake.fetch(input, init)
    }
    const store = new UpstashRedisStore({
      url: fake.url,
      token: fake.token,
      keyPrefix: 'mirage:fs:',
      fetchImpl: flaky,
      maxRequestBytes: 100,
    })
    await store.setFile('/big', ENC.encode('old'))
    failAppend = true
    await expect(store.setFile('/big', ALL_BYTES)).rejects.toThrow(/cannot reach/)
    expect(await store.getFile('/big')).toEqual(ENC.encode('old'))
    expect(fake.keys()).toEqual(['mirage:fs:file:/big'])
  })

  it('a chunked write whose RENAME fails leaves the previous content and no temp key', async () => {
    const fake = createFakeUpstash()
    let failRename = false
    const flaky: typeof fetch = (input, init) => {
      if (failRename && typeof init?.body === 'string' && init.body.startsWith('["RENAME"')) {
        return Promise.reject(new TypeError('network down'))
      }
      return fake.fetch(input, init)
    }
    const store = new UpstashRedisStore({
      url: fake.url,
      token: fake.token,
      keyPrefix: 'mirage:fs:',
      fetchImpl: flaky,
      maxRequestBytes: 100,
    })
    await store.setFile('/big', ENC.encode('old'))
    failRename = true
    await expect(store.setFile('/big', ALL_BYTES)).rejects.toThrow(/cannot reach/)
    expect(await store.getFile('/big')).toEqual(ENC.encode('old'))
    expect(fake.keys()).toEqual(['mirage:fs:file:/big'])
  })

  it('matches a keyPrefix holding glob metacharacters literally', async () => {
    const fake = createFakeUpstash()
    const store = new UpstashRedisStore({
      url: fake.url,
      token: fake.token,
      keyPrefix: 'm:[ab]?:',
      fetchImpl: fake.fetch,
    })
    fake.exec(['SET', 'm:ax:file:/other', 'x'])
    await store.setFile('/mine', ENC.encode('y'))
    expect(await store.listFiles()).toEqual(['/mine'])
    await store.clear()
    expect(fake.keys()).toEqual(['m:ax:file:/other'])
  })

  it('restore writes files one by one and the side keys through pipelines', async () => {
    const fake = createFakeUpstash()
    const sizes: number[] = []
    const store = new UpstashRedisStore({
      url: fake.url,
      token: fake.token,
      keyPrefix: 'mirage:fs:',
      fetchImpl: countingFetch(fake, sizes),
    })
    await store.restore({
      files: { '/a': ENC.encode('a'), '/e': new Uint8Array(0) },
      dirs: ['/', '/d'],
      attrs: { '/a': { mode: '420' }, '/skip': {} },
      modified: { '/a': 't1' },
    })
    expect(sizes).toEqual([4])
    expect(await store.getFile('/a')).toEqual(ENC.encode('a'))
    expect(await store.hasFile('/e')).toBe(true)
    expect(await store.listDirs()).toEqual(new Set(['/', '/d']))
    expect(await store.listAttrs()).toEqual({ '/a': { mode: '420' } })
    expect(await store.listModified()).toEqual({ '/a': 't1' })
  })

  it('keeps a key with slashes, spaces, plus, percent, question mark and hash intact', async () => {
    const { fake, store } = make()
    const path = '/dir with space/a+b%2F?#.txt'
    await store.setFile(path, ENC.encode('hello'))
    expect(fake.keys()).toContain(`mirage:fs:file:${path}`)
    expect(await store.getFile(path)).toEqual(ENC.encode('hello'))
  })

  it('getFileRange slices server-side and reads to the end when size is null', async () => {
    const { store } = make()
    await store.setFile('/a.bin', ALL_BYTES)
    expect(await store.getFileRange('/a.bin', 10, 5)).toEqual(ALL_BYTES.slice(10, 15))
    expect(await store.getFileRange('/a.bin', 250, null)).toEqual(ALL_BYTES.slice(250))
    expect(await store.getFileRange('/a.bin', 300, 5)).toEqual(new Uint8Array(0))
  })

  it('getFileRange returns null for a missing file', async () => {
    const { store } = make()
    expect(await store.getFileRange('/nope', 0, 5)).toBeNull()
  })

  it('getFileRange returns empty for zero-length reads and preserves missing', async () => {
    const { store } = make()
    await store.setFile('/data', ENC.encode('payload'))
    await store.setFile('/empty', new Uint8Array(0))
    expect(await store.getFileRange('/data', 0, 0)).toEqual(new Uint8Array(0))
    expect(await store.getFileRange('/data', 4, 0)).toEqual(new Uint8Array(0))
    expect(await store.getFileRange('/empty', 0, 0)).toEqual(new Uint8Array(0))
    expect(await store.getFileRange('/empty', 4, 0)).toEqual(new Uint8Array(0))
    expect(await store.getFileRange('/missing', 0, 0)).toBeNull()
    expect(await store.getFileRange('/missing', 4, 0)).toBeNull()
  })

  it('fileLen counts bytes, not characters', async () => {
    const { store } = make()
    await store.setFile('/u.txt', ENC.encode('é'))
    expect(await store.fileLen('/u.txt')).toBe(2)
  })

  it('listFiles strips the prefix, walks every SCAN page and sorts by code point', async () => {
    const { fake, store } = make({ scanPageSize: 2 })
    for (const p of ['/b', '/a', '/sub/d', '/Z', '/c']) await store.setFile(p, ENC.encode(p))
    await store.addDir('/sub')
    expect(await store.listFiles()).toEqual(['/Z', '/a', '/b', '/c', '/sub/d'])
    expect(fake.commands.filter((c) => c === 'SCAN').length).toBeGreaterThan(1)
  })

  it('listFiles narrows by prefix', async () => {
    const { store } = make()
    await store.setFile('/sub/d', ENC.encode('d'))
    await store.setFile('/sun', ENC.encode('s'))
    expect(await store.listFiles('/sub')).toEqual(['/sub/d'])
  })

  it('tracks directories in one set', async () => {
    const { store } = make()
    await store.addDir('/a')
    await store.addDir('/a/b')
    expect(await store.hasDir('/a')).toBe(true)
    expect(await store.listDirs()).toEqual(new Set(['/a', '/a/b']))
    await store.removeDir('/a/b')
    expect(await store.hasDir('/a/b')).toBe(false)
    expect(await store.listDirs()).toEqual(new Set(['/a']))
  })

  it('stores and clears the modified timestamp', async () => {
    const { store } = make()
    expect(await store.getModified('/a')).toBeNull()
    await store.setModified('/a', '2026-09-02T00:00:00.000Z')
    expect(await store.getModified('/a')).toBe('2026-09-02T00:00:00.000Z')
    await store.delModified('/a')
    expect(await store.getModified('/a')).toBeNull()
  })

  it('stores attrs as a hash and reads them back as an object', async () => {
    const { store } = make()
    expect(await store.getAttrs('/a')).toEqual({})
    await store.setAttrs('/a', { mode: '420', uid: 'agent' })
    expect(await store.getAttrs('/a')).toEqual({ mode: '420', uid: 'agent' })
    await store.setAttrs('/a', { gid: 'default' })
    expect(await store.getAttrs('/a')).toEqual({ mode: '420', uid: 'agent', gid: 'default' })
    await store.delAttrs('/a')
    expect(await store.getAttrs('/a')).toEqual({})
  })

  it('listAttrs and listModified aggregate every path', async () => {
    const { store } = make({ scanPageSize: 2 })
    await store.setAttrs('/a', { mode: '420' })
    await store.setAttrs('/d/b', { uid: 'x' })
    await store.setModified('/a', 't1')
    await store.setModified('/d/b', 't2')
    await store.setFile('/a', ENC.encode('a'))
    expect(await store.listAttrs()).toEqual({ '/a': { mode: '420' }, '/d/b': { uid: 'x' } })
    expect(await store.listModified()).toEqual({ '/a': 't1', '/d/b': 't2' })
  })

  it('listAttrs and listModified pipeline at most 500 commands per request', async () => {
    const fake = createFakeUpstash()
    for (let i = 0; i < 1200; i++) {
      fake.exec(['HSET', `mirage:fs:attrs:/p${String(i)}`, 'mode', '420'])
      fake.exec(['SET', `mirage:fs:modified:/p${String(i)}`, 't'])
    }
    const sizes: number[] = []
    const store = new UpstashRedisStore({
      url: fake.url,
      token: fake.token,
      keyPrefix: 'mirage:fs:',
      fetchImpl: countingFetch(fake, sizes),
    })
    expect(Object.keys(await store.listAttrs())).toHaveLength(1200)
    expect(Object.keys(await store.listModified())).toHaveLength(1200)
    expect(sizes.length).toBeGreaterThanOrEqual(6)
    expect(Math.max(...sizes)).toBeLessThanOrEqual(500)
  })

  it('keeps every pipeline body under maxRequestBytes when keys are long', async () => {
    const fake = createFakeUpstash()
    const long = 'x'.repeat(200)
    for (let i = 0; i < 50; i++) {
      fake.exec(['HSET', `mirage:fs:attrs:/${long}${String(i)}`, 'mode', '420'])
    }
    const sizes: number[] = []
    const store = new UpstashRedisStore({
      url: fake.url,
      token: fake.token,
      keyPrefix: 'mirage:fs:',
      fetchImpl: bodyBytesFetch(fake, sizes),
      maxRequestBytes: 1000,
    })
    expect(Object.keys(await store.listAttrs())).toHaveLength(50)
    expect(sizes.length).toBeGreaterThan(10)
    expect(Math.max(...sizes)).toBeLessThanOrEqual(1000)
  })

  it('keeps every DEL body under maxRequestBytes when keys are long', async () => {
    const fake = createFakeUpstash()
    const long = 'x'.repeat(200)
    for (let i = 0; i < 50; i++) {
      fake.exec(['SET', `mirage:fs:file:/${long}${String(i)}`, 'v'])
    }
    const sizes: number[] = []
    const store = new UpstashRedisStore({
      url: fake.url,
      token: fake.token,
      keyPrefix: 'mirage:fs:',
      fetchImpl: bodyBytesFetch(fake, sizes),
      maxRequestBytes: 1000,
    })
    await store.clear()
    expect(fake.keys()).toEqual([])
    expect(sizes.length).toBeGreaterThan(10)
    expect(Math.max(...sizes)).toBeLessThanOrEqual(1000)
  })

  it('clear removes files, side keys and the dir set', async () => {
    const { fake, store } = make({ scanPageSize: 2 })
    await store.open()
    for (const p of ['/a', '/b', '/c']) {
      await store.setFile(p, ENC.encode(p))
      await store.setModified(p, 't')
      await store.setAttrs(p, { mode: '420' })
    }
    await store.clear()
    expect(fake.keys()).toEqual([])
  })

  it('surfaces the server error message', async () => {
    const { fake, store } = make()
    fake.exec(['HSET', 'mirage:fs:file:/h', 'field', 'value'])
    await expect(store.getFile('/h')).rejects.toThrow(/WRONGTYPE/)
  })

  it('rejects when the token is wrong', async () => {
    const { fake } = make()
    const store = new UpstashRedisStore({ url: fake.url, token: 'nope', fetchImpl: fake.fetch })
    await expect(store.hasFile('/a')).rejects.toThrow(/401/)
  })

  it('refuses to start without a url or a token', () => {
    const { fake } = make()
    expect(() => new UpstashRedisStore({ url: '', token: fake.token })).toThrow(/url/)
    expect(() => new UpstashRedisStore({ url: fake.url, token: '' })).toThrow(/token/)
  })

  it('refuses a maxRequestBytes that is not a positive integer', () => {
    const { fake } = make()
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        () => new UpstashRedisStore({ url: fake.url, token: fake.token, maxRequestBytes: bad }),
      ).toThrow(/maxRequestBytes/)
    }
  })

  it('close is a no-op that can be repeated', async () => {
    const { store } = make()
    await store.close()
    await store.close()
    await store.setFile('/after', ENC.encode('still usable'))
    expect(await store.getFile('/after')).toEqual(ENC.encode('still usable'))
  })
})

describe('UpstashRedisStore from a redis url', () => {
  it('reaches https://<host> with the password as the bearer token', async () => {
    const fake = createFakeUpstash({ url: 'https://db.upstash.io', token: 's3cret' })
    const store = new UpstashRedisStore({
      url: 'rediss://default:s3cret@db.upstash.io:6379',
      fetchImpl: fake.fetch,
    })
    expect(store.url).toBe('https://db.upstash.io')
    await store.open()
    expect(await store.hasDir('/')).toBe(true)
  })

  it('decodes a percent-encoded password', async () => {
    const fake = createFakeUpstash({ url: 'https://db.upstash.io', token: 'p@ss/w:rd' })
    const store = new UpstashRedisStore({
      url: 'rediss://default:p%40ss%2Fw%3Ard@db.upstash.io:6379',
      fetchImpl: fake.fetch,
    })
    await store.open()
    expect(await store.hasDir('/')).toBe(true)
  })

  it('takes a token beside a redis url that carries no password', async () => {
    const fake = createFakeUpstash({ url: 'https://db.upstash.io', token: 's3cret' })
    const store = new UpstashRedisStore({
      url: 'rediss://db.upstash.io:6379',
      token: 's3cret',
      fetchImpl: fake.fetch,
    })
    await store.open()
    expect(await store.hasDir('/')).toBe(true)
  })

  it('refuses a redis url with neither password nor token', () => {
    expect(() => new UpstashRedisStore({ url: 'redis://localhost:6379' })).toThrow(/password/)
  })

  it('still requires a token beside a REST url', () => {
    expect(() => new UpstashRedisStore({ url: 'https://db.upstash.io' })).toThrow(/token/)
  })

  it('refuses a scheme it cannot reach', () => {
    expect(() => new UpstashRedisStore({ url: 'ftp://db.upstash.io', token: 't' })).toThrow(
      /redis:\/\/.*https:\/\//,
    )
  })

  it('names the host when no REST listener answers', async () => {
    const fetchImpl: typeof fetch = () => Promise.reject(new TypeError('Failed to fetch'))
    const store = new UpstashRedisStore({ url: 'rediss://default:t@localhost:6379', fetchImpl })
    await expect(store.open()).rejects.toThrow(/https:\/\/localhost.*REST listener/)
  })
})
