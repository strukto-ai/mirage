import { createHash } from 'node:crypto'
import { YieldBudget } from '@struktoai/mirage-core/io/yield_budget'
import { registerFingerprintHasher } from '@struktoai/mirage-core/cache/file/utils'

export async function nativeFingerprint(data: Uint8Array): Promise<string> {
  const hash = createHash('md5')
  const budget = new YieldBudget()
  for (let offset = 0; offset < data.byteLength; offset += 64 * 1024) {
    hash.update(data.subarray(offset, offset + 64 * 1024))
    const pending = budget.run()
    if (pending !== undefined) await pending
  }
  return hash.digest('hex')
}

registerFingerprintHasher(nativeFingerprint)
