import { parseFlags, truncateGeneric } from '../../generic/truncate.ts'
import type { CommandFn } from '../../../config.ts'
import type { GenericCommand } from '../adapter.ts'
import { commandFiles } from '../files.ts'

const truncate: CommandFn = async (_accessor, paths, _texts, ctx) => {
  const files = commandFiles(ctx, paths)
  const flags = parseFlags(ctx.flags)
  return truncateGeneric(await files.resolveGlob(paths), flags, files.stat, files.truncate)
}

export const BUILDER: GenericCommand = {
  name: 'truncate',
  write: true,
  fn: truncate,
}
