import { odGeneric } from '../../generic/od.ts'
import { type GenericCommand, resolveGlobOf } from '../adapter.ts'

export const BUILDER: GenericCommand = {
  name: 'od',
  read: true,
  fn: async (ops, accessor, paths, _texts, ctx) => {
    const index = ctx.index ?? undefined
    const resolved = paths.length > 0 ? await resolveGlobOf(ops)(accessor, paths, index) : []
    return odGeneric(resolved, ctx, (p) => ops.readStream(accessor, p, index))
  },
}
