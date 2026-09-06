import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { defaultFingerprintAsync } from '@struktoai/mirage-core/cache/file/utils'
import { RAMFileCacheStore } from '@struktoai/mirage-core/cache/file/ram'
import { nativeFingerprint } from './utils.ts'

it.each([0, 1, 63, 64, 65, 65535, 65536, 65537])(
  'hashes %i bytes with native MD5',
  async (size) => {
    const data = Uint8Array.from({ length: size + 7 }, (_, i) => i % 256).subarray(7)
    const expected = createHash('md5').update(data).digest('hex')
    expect(await nativeFingerprint(data)).toBe(expected)
    expect(await defaultFingerprintAsync(data)).toBe(expected)
  },
)

it('lets timers run during a RAM cache fingerprint', async () => {
  const data = new Uint8Array(20_000_000)
  const cache = new RAMFileCacheStore()
  let fired = false
  const timer = setTimeout(() => {
    fired = true
  }, 0)
  try {
    await cache.set('/large', data)
    expect(fired).toBe(true)
    expect(await cache.isFresh('/large', createHash('md5').update(data).digest('hex'))).toBe(true)
  } finally {
    clearTimeout(timer)
  }
})
