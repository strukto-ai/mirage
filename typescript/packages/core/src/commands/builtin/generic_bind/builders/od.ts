import { odGeneric, parseCount } from '../../generic/od.ts'
import { specOf } from '../../../spec/builtins.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { type GenericCommand, resolveGlobOf } from '../adapter.ts'

export const BUILDER: GenericCommand = {
  name: 'od',
  read: true,
  fn: async (ops, accessor, paths, _texts, ctx) => {
    const index = ctx.index ?? undefined
    const resolved = paths.length > 0 ? await resolveGlobOf(ops)(accessor, paths, index) : []
    const fl = new FlagView(ctx.flags, specOf('od'))
    // asStr, not a truthiness test: an explicitly empty value is an
    // invalid argument to GNU, not an absent flag.
    const skipValue = fl.asStr('skip_bytes')
    const limitValue = fl.asStr('read_bytes')
    return odGeneric(
      resolved,
      (p) => ops.readStream(accessor, p, index),
      ctx.stdin,
      fl.asStr('address_radix') ?? 'o',
      skipValue !== undefined ? parseCount(skipValue, '-j') : 0,
      limitValue !== undefined ? parseCount(limitValue, '-N') : null,
      fl.occurrences('format', 'c').map(([name, value]) => (name === 'c' ? 'c' : String(value))),
    )
  },
}
