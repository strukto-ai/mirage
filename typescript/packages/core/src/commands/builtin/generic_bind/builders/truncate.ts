import { parseFlags, truncateGeneric } from '../../generic/truncate.ts'
import { IOResult } from '../../../../io/types.ts'
import type { CommandFn } from '../../../config.ts'
import type { GenericCommand } from '../adapter.ts'
import { commandFiles } from '../files.ts'
import { type FileStat, PathSpec } from '../../../../types.ts'
import { linksOf } from '../../utils/links.ts'

const truncate: CommandFn = async (_accessor, paths, _texts, ctx) => {
  const flags = parseFlags(ctx.flags)
  if (flags instanceof IOResult) return [null, flags]
  const files = commandFiles(ctx, paths)
  const links = linksOf(ctx)
  const followed = (path: PathSpec): Promise<FileStat> =>
    files.stat(links === undefined ? path : PathSpec.fromStrPath(links.resolve(path.virtual)))
  return truncateGeneric(
    await files.resolveGlob(paths),
    flags,
    files.stat,
    files.truncate,
    followed,
  )
}

export const BUILDER: GenericCommand = {
  name: 'truncate',
  write: true,
  fn: truncate,
}
