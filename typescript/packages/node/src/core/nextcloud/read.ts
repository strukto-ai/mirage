import {
  enoent,
  record,
  ResourceName,
  type IndexCacheStore,
  type PathSpec,
} from '@struktoai/mirage-core'
import type { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { isNotFound, nextcloudKey } from './util.ts'

export interface NextcloudReadOptions {
  offset?: number
  size?: number
}

export async function read(
  accessor: NextcloudAccessor,
  path: PathSpec,
  _index?: IndexCacheStore,
  options: NextcloudReadOptions = {},
): Promise<Uint8Array> {
  const op = await accessor.operator()
  const readOptions: { offset?: bigint; size?: bigint } = {}
  if (options.offset !== undefined && options.offset > 0) {
    readOptions.offset = BigInt(options.offset)
  }
  if (options.size !== undefined) {
    readOptions.offset ??= 0n
    readOptions.size = BigInt(options.size)
  }
  const startMs = performance.now()
  try {
    const data =
      readOptions.offset !== undefined || readOptions.size !== undefined
        ? await op.read(nextcloudKey(path), readOptions)
        : await op.read(nextcloudKey(path))
    const bytes = new Uint8Array(data)
    record('read', path.virtual, ResourceName.NEXTCLOUD, bytes.byteLength, startMs)
    return bytes
  } catch (error) {
    if (isNotFound(error)) throw enoent(path)
    throw error
  }
}
