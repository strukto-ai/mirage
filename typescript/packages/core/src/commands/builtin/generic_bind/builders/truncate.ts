import { parseFlags, truncateGeneric } from '../../generic/truncate.ts'
import { type GenericCommand, requireOp, resolveGlobOf, type GenericCommandFn } from '../adapter.ts'

const truncate: GenericCommandFn = async (ops, accessor, paths, _texts, ctx) => {
  const flags = parseFlags(ctx.flags)
  const truncateOp = requireOp(ops.truncate, 'truncate')
  const index = ctx.index ?? undefined
  const resolved = await resolveGlobOf(ops)(accessor, paths, index)
  return truncateGeneric(
    resolved,
    flags,
    (path) => ops.stat(accessor, path, index),
    (path, length, noCreate) => truncateOp(accessor, path, length, noCreate),
  )
}

export const BUILDER: GenericCommand = {
  name: 'truncate',
  write: true,
  fn: truncate,
}
