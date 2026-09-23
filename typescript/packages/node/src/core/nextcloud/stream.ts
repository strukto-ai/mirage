import type { IndexCacheStore } from '@struktoai/mirage-core/cache/index/store'
import { recordStream } from '@struktoai/mirage-core/observe/context'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { enoent } from '@struktoai/mirage-core/utils/errors'
import type { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { DEFAULT_CHUNK_SIZE } from './constants.ts'
import { read } from './read.ts'
import { isNotFound, nextcloudKey } from './util.ts'

export function rangeRead(
  accessor: NextcloudAccessor,
  path: PathSpec,
  start: number,
  end: number,
): Promise<Uint8Array> {
  return read(accessor, path, undefined, { offset: start, size: end - start })
}

export async function* stream(
  accessor: NextcloudAccessor,
  path: PathSpec,
  _index?: IndexCacheStore,
  chunkSize = DEFAULT_CHUNK_SIZE,
): AsyncIterable<Uint8Array> {
  const op = await accessor.operator()
  const rec = recordStream('read', path.virtual, accessor.vfsName)
  let reader
  try {
    reader = await op.reader(nextcloudKey(path))
  } catch (error) {
    if (isNotFound(error)) throw enoent(path)
    throw error
  }
  const buffer = Buffer.alloc(chunkSize)
  for (;;) {
    const size = Number(await reader.read(buffer))
    if (size <= 0) break
    const chunk = new Uint8Array(buffer.subarray(0, size))
    if (rec !== null) rec.bytes += chunk.byteLength
    yield chunk
  }
}
