import { describe, expect, it } from 'vitest'
import { IOConfig } from './config.ts'

describe('IOConfig', () => {
  it('has a frozen buffer limit and a 64 KiB default', () => {
    expect(new IOConfig().bufferBytes).toBe(65536)
    const config = new IOConfig({ bufferBytes: 262144 })
    expect(config.bufferBytes).toBe(262144)
    expect(Object.isFrozen(config)).toBe(true)
  })

  it.each([null, true, '65536', 65536.5, 0, 16383, 2 ** 53])(
    'rejects invalid buffer limit %s',
    (value) => {
      expect(() => new IOConfig({ bufferBytes: value as number })).toThrow()
    },
  )

  it('rejects unknown knobs', () => {
    expect(() => new IOConfig({ chunkBytes: 16384 } as never)).toThrow()
  })
})
