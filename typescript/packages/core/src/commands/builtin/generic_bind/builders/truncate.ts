import { truncateGeneric } from '../../generic/truncate.ts'
import { specOf } from '../../../spec/builtins.ts'
import { FlagView } from '../../../spec/types.ts'
import { type Builder, resolveGlobOf } from '../adapter.ts'

export const TRUNCATE_BUILDER: Builder = {
  name: 'truncate',
  write: true,
  requirements: ['truncate'],
  fn: async (ops, accessor, paths, _texts, opts) => {
    const sizeValue = new FlagView(opts.flags, specOf('truncate')).asStr('size')
    if (sizeValue === undefined) {
      throw new Error("truncate: you must specify either '--size' or '-s'")
    }
    const { truncate } = ops
    if (truncate === undefined) throw new Error('truncate: backend provides no truncate op')
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
