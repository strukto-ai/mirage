import { record, startOp } from '@struktoai/mirage-core/observe/context'
import { VFSName } from '@struktoai/mirage-core/types'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { enoent } from '@struktoai/mirage-core/errors/fs'
import { ByteSpool } from '@struktoai/mirage-core/io/spool'
import type { ByteSource } from '@struktoai/mirage-core/io/types'
import { SystemIdSource } from '@struktoai/mirage-core/utils/ids'
import type { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { MAX_UPLOAD_CHUNKS, UPLOAD_CHUNK_SIZE } from './constants.ts'
import { davRequest, davUrl, uploadsUrl } from './dav.ts'
import { isNotFound, nextcloudKey } from './util.ts'

/**
 * Upload a spooled file through Nextcloud's chunked upload: an upload folder,
 * one PUT per chunk sliced from the spool's body, then a MOVE of its `.file`
 * onto the destination. A failed upload's folder is deleted. Mirrors
 * Python's `_chunked`.
 */
async function chunked(
  accessor: NextcloudAccessor,
  path: PathSpec,
  spool: ByteSpool,
  uploads: string,
): Promise<void> {
  const folder = `${uploads}/mirage-${new SystemIdSource().uuid7()}`
  const target = { Destination: davUrl(accessor, path) }
  const headers = { ...target, 'OC-Total-Length': String(spool.size) }
  const part = Math.max(UPLOAD_CHUNK_SIZE, Math.ceil(spool.size / MAX_UPLOAD_CHUNKS))
  const send = async (
    method: string,
    url: string,
    sent: Record<string, string>,
    body?: Uint8Array<ArrayBuffer> | Blob,
  ): Promise<void> => {
    const answer = await davRequest(accessor, method, url, sent, body)
    if (!answer.ok) throw new Error(`Nextcloud ${method} returned HTTP ${String(answer.status)}`)
  }
  await send('MKCOL', folder, target)
  try {
    const body = (await spool.body('fetch')) as Uint8Array<ArrayBuffer> | Blob
    for (let start = 0, number = 1; start < spool.size; start += part, number++) {
      const chunk = `${folder}/${String(number).padStart(5, '0')}`
      await send('PUT', chunk, headers, body.slice(start, start + part))
    }
    await send('MOVE', `${folder}/.file`, headers)
  } catch (error) {
    try {
      await davRequest(accessor, 'DELETE', folder)
    } catch (cleanup) {
      console.debug(`Could not delete Nextcloud upload ${folder}`, cleanup)
    }
    throw error
  }
}

/**
 * Write a file, spooled first so its size picks the upload: past one chunk it
 * goes up in chunks where the mount's URL names its user, else in one PUT
 * through opendal. Either way the missing parents are made.
 */
export async function write(
  accessor: NextcloudAccessor,
  path: PathSpec,
  data: ByteSource,
): Promise<void> {
  const key = nextcloudKey(path)
  const uploads = uploadsUrl(accessor)
  const spool = new ByteSpool()
  try {
    await spool.fill(data)
    const timer = startOp()
    try {
      const op = await accessor.operator()
      if (uploads !== null && spool.size > UPLOAD_CHUNK_SIZE) {
        const parent = key.slice(0, Math.max(0, key.lastIndexOf('/')))
        if (parent !== '') await op.createDir(`${parent}/`)
        await chunked(accessor, path, spool, uploads)
      } else {
        const bytes = await spool.read(0, spool.size)
        await op.write(key, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
      }
    } catch (error) {
      if (isNotFound(error)) throw enoent(path)
      throw error
    }
    record('write', path.virtual, VFSName.NEXTCLOUD, spool.size, timer)
  } finally {
    await spool.close()
  }
}
