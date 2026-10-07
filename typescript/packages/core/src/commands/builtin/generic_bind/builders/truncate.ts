import { parseFlags, truncateGeneric } from '../../generic/truncate.ts'
import { type Builder, requireOp, resolveGlobOf, type BuilderFn } from '../adapter.ts'

const truncate: BuilderFn = async (ops, accessor, paths, _texts, opts) => {
  const flags = parseFlags(opts.flags)
  const truncateOp = requireOp(ops, 'truncate')
  const index = opts.index ?? undefined
  const resolved = await resolveGlobOf(ops)(accessor, paths, index)
  return truncateGeneric(
    resolved,
    flags,
    (path) => ops.stat(accessor, path, index),
    (path, length, noCreate) => truncateOp(accessor, path, length, noCreate),
  )
}

export const BUILDER: Builder = {
  name: 'truncate',
  write: true,
  fn: truncate,
}
