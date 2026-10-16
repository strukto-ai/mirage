import { setSpoolFactory, type SpoolStore } from '@struktoai/mirage-core/io/spool'

async function createStore(): Promise<SpoolStore> {
  const root = await navigator.storage.getDirectory()
  const directory = await root.getDirectoryHandle('.mirage-spool', { create: true })
  const name = crypto.randomUUID()
  const file = await directory.getFileHandle(name, { create: true })
  let length = 0
  let writer: FileSystemWritableFileStream | null = null
  return {
    async append(data) {
      writer ??= await file.createWritable({ keepExistingData: true })
      await writer.write({ type: 'write', position: length, data: data as Uint8Array<ArrayBuffer> })
      length += data.length
    },
    async read(offset, size) {
      if (writer !== null) {
        await writer.close()
        writer = null
      }
      return new Uint8Array(await (await file.getFile()).slice(offset, offset + size).arrayBuffer())
    },
    async body() {
      if (writer !== null) {
        await writer.close()
        writer = null
      }
      return file.getFile()
    },
    async close() {
      try {
        if (writer !== null) await writer.abort()
      } finally {
        await directory.removeEntry(name)
      }
    },
  }
}

if (
  typeof navigator !== 'undefined' &&
  typeof (navigator as { storage?: StorageManager }).storage?.getDirectory === 'function'
) {
  setSpoolFactory(createStore)
}
