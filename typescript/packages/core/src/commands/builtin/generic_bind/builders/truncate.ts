import { truncateGeneric } from '../../generic/truncate.ts'
import { specOf } from '../../../spec/builtins.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { type Builder, requireOp, resolveGlobOf } from '../adapter.ts'

export const TRUNCATE_BUILDER: Builder = {
  name: 'truncate',
  write: true,
  fn: async (ops, accessor, paths, _texts, opts) => {
    const sizeValue = new FlagView(opts.flags, specOf('truncate')).asStr('size')
    if (sizeValue === undefined) {
      throw new Error("truncate: you must specify either '--size' or '-s'")
    }
    const truncate = requireOp(ops.truncate, 'truncate')
    const index = opts.index ?? undefined
    const resolved = await resolveGlobOf(ops)(accessor, paths, index)
    return truncateGeneric(
      resolved,
      sizeValue,
      (path) => ops.stat(accessor, path, index),
      (path, length) => truncate(accessor, path, length),
    )
  },
}
