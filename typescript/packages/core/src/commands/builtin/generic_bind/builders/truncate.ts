import { truncateGeneric } from '../../generic/truncate.ts'
import { type Builder, resolveGlobOf } from '../adapter.ts'

export const TRUNCATE_BUILDER: Builder = {
  name: 'truncate',
  write: true,
  fn: async (ops, accessor, paths, _texts, opts) => {
    const sizeValue = opts.flags.s ?? opts.flags.size
    if (typeof sizeValue !== 'string') {
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
