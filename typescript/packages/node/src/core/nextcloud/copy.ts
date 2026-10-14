import { liftLost, lostCount, record, startOp } from '@struktoai/mirage-core/observe/context'
import { VFSName, type PathSpec } from '@struktoai/mirage-core/types'
import { eacces, eexist, enoent, fsError } from '@struktoai/mirage-core/errors/fs'
import type { NextcloudAccessor } from '../../accessor/nextcloud.ts'
import { davRequest, davUrl } from './dav.ts'
import { parser, records } from './search/response.ts'
import type { XmlRecord } from './search/types.ts'
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
}

/**
 * The first failure a COPY's multistatus reports for a member of the tree,
 * 500 when it names none. Mirrors Python's `failed_status`.
 */
function failedStatus(text: string): number {
  const tree = parser.parse(text) as XmlRecord
  const statuses = records(tree.multistatus)
    .flatMap((multistatus) => records(multistatus.response))
    .flatMap((answer) => [answer.status, ...records(answer.propstat).map((group) => group.status)])
  for (const status of statuses) {
    const code = typeof status === 'string' ? Number(status.trim().split(/\s+/)[1]) : Number.NaN
    if (code >= 300) return code
  }
  return 500
}

/**
 * Copy a folder tree onto a fresh name in one WebDAV COPY. `cp -r` asks
 * this only when nothing holds `dst`, so the copy goes with
 * `Overwrite: F` and a taken name is refused, never replaced. A multistatus
 * answer is a tree copied in part, refused for its first failed member.
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
  let status = response.status
  if (status === 207) {
    status = failedStatus(await response.text())
  }
  if (status === 404) throw enoent(src)
  if (status === 409) throw enoent(dst)
  if (status === 412) throw eexist(dst)
  if (status === 403 || status === 423) throw eacces(dst)
  if (response.status === 207) throw fsError(dst, 'EIO')
  if (!response.ok) throw new Error(`Nextcloud COPY returned HTTP ${String(response.status)}`)
  record('copy_prefix', dst.virtual, VFSName.NEXTCLOUD, 0, timer)
  liftLost(dst, upto, true)
}
