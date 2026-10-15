import type { WandbAccessor } from '../../accessor/wandb.ts'
import { FileStat, FileType, type PathSpec } from '../../types.ts'
import { enoent } from '../../errors/fs.ts'
import { parts } from './pathing.ts'
/** A path's stat: the row its parent's listing names. */
export function stat(
  accessor: WandbAccessor,
  path: PathSpec,
  entry: FileStat | null = null,
): Promise<FileStat> {
  if (parts(accessor, path).length === 0) {
    return Promise.resolve(new FileStat({ name: '/', type: FileType.DIRECTORY, size: 0 }))
  }
  if (entry === null) return Promise.reject(enoent(path))
  return Promise.resolve(entry)
}
