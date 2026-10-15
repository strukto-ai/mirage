import { invalidateAfterWrite, invalidateSubtree } from '@struktoai/mirage-core/cache/context'
import { liftLost, lostCount, record, startOp } from '@struktoai/mirage-core/observe/context'
import { VFSName, type PathSpec } from '@struktoai/mirage-core/types'
import { eacces, eexist, enoent } from '@struktoai/mirage-core/errors/fs'
import type { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { davRequest, davUrl } from './dav.ts'
import { isNotFound, nextcloudKey } from './util.ts'

export async function copy(
  accessor: NextcloudAccessor,
  source: PathSpec,
  destination: PathSpec,
): Promise<void> {
  const op = await accessor.operator()
  try {
    await op.copy(nextcloudKey(source), nextcloudKey(destination))
  } catch (error) {
    if (isNotFound(error)) throw enoent(source)
    throw error
  }
  await invalidateAfterWrite(destination)
}

/**
 * Copy a folder tree onto a fresh name in one WebDAV COPY. `cp -r` asks
 * this only when nothing holds `dst`, so the copy goes with
 * `Overwrite: F` and a taken name is refused, never replaced.
 */
export async function dirCopy(
  accessor: NextcloudAccessor,
  src: PathSpec,
  dst: PathSpec,
): Promise<void> {
  const upto = lostCount()
  const timer = startOp()
  const response = await davRequest(accessor, 'COPY', davUrl(accessor, src, true), {
    Destination: davUrl(accessor, dst, true),
    Depth: 'infinity',
    Overwrite: 'F',
  })
  if (response.status === 404) throw enoent(src)
  if (response.status === 409) throw enoent(dst)
  if (response.status === 412) throw eexist(dst)
  if (response.status === 403) throw eacces(dst)
  if (!response.ok) throw new Error(`Nextcloud COPY returned HTTP ${String(response.status)}`)
  record('copy_prefix', dst.virtual, VFSName.NEXTCLOUD, 0, timer)
  liftLost(dst, upto, true)
  await invalidateSubtree(dst)
}
