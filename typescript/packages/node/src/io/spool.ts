import { openAsBlob } from 'node:fs'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setSpoolFactory, type SpoolStore } from '@struktoai/mirage-core/io/spool'

async function createStore(): Promise<SpoolStore> {
  const directory = await mkdtemp(join(tmpdir(), 'mirage-spool-'))
  try {
    const file = await open(join(directory, 'data'), 'w+')
    let length = 0
    return {
      async append(data) {
        let offset = 0
        while (offset < data.length) {
          const { bytesWritten } = await file.write(data, offset, data.length - offset, length)
          if (bytesWritten === 0) throw new Error('spool write made no progress')
          offset += bytesWritten
          length += bytesWritten
        }
      },
      async read(offset, size) {
        const buffer = new Uint8Array(Math.max(0, Math.min(size, length - offset)))
        let count = 0
        while (count < buffer.length) {
          const { bytesRead } = await file.read(
            buffer,
            count,
            buffer.length - count,
            offset + count,
          )
          if (bytesRead === 0) break
          count += bytesRead
        }
        return buffer.subarray(0, count)
      },
      async body(kind) {
        return kind === 'fetch'
          ? openAsBlob(join(directory, 'data'))
          : file.createReadStream({ start: 0, autoClose: false })
      },
      async close() {
        try {
          await file.close()
        } finally {
          await rm(directory, { recursive: true, force: true })
        }
      },
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

setSpoolFactory(createStore)
