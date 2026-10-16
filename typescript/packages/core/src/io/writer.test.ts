import { describe, expect, it } from 'vitest'
import { CHUNK_SIZE } from './cooperative.ts'
import { CAPACITY } from './pipe.ts'
import { ByteWriter } from './writer.ts'

describe('ByteWriter', () => {
  it('waits for capacity and commit', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let committed = false
    let size = 0
    const writer = new ByteWriter(async (source) => {
      await gate
      for await (const chunk of source as AsyncIterable<Uint8Array>) size += chunk.length
      committed = true
    })
    let accepted = false
    const pending = writer.write(new Uint8Array(CAPACITY + CHUNK_SIZE)).then(() => {
      accepted = true
    })
    await Promise.resolve()
    expect(accepted).toBe(false)
    expect(writer.pipe.bufferedBytes).toBeLessThanOrEqual(CAPACITY)
    expect(committed).toBe(false)
    release()
    await pending
    expect(committed).toBe(false)
    await writer.finish()
    expect(committed).toBe(true)
    expect(size).toBe(CAPACITY + CHUNK_SIZE)
  })

  it('aborts without committing', async () => {
    let entered!: () => void
    const seen = new Promise<void>((resolve) => {
      entered = resolve
    })
    let committed = false
    let closed = false
    const writer = new ByteWriter(async (source) => {
      try {
        for await (const chunk of source as AsyncIterable<Uint8Array>) {
          expect(chunk.length).toBe(1)
          entered()
        }
        committed = true
      } finally {
        closed = true
      }
    })
    await writer.write(new Uint8Array([1]))
    await seen
    await writer.abort()
    expect(closed).toBe(true)
    expect(committed).toBe(false)
  })

  it('wakes a blocked producer on upload failure', async () => {
    const error = new Error('upload failed')
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const writer = new ByteWriter(async () => {
      await gate
      throw error
    })
    const pending = writer.write(new Uint8Array(CAPACITY * 2))
    release()
    await expect(pending).rejects.toBe(error)
    await writer.abort()
  })
})
