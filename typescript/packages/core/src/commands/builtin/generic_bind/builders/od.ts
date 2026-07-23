import { odGeneric, parseCount } from '../../generic/od.ts'
import { resolveSource } from '../../utils/stream.ts'
import { type Builder, resolveGlobOf } from '../adapter.ts'

export const OD_BUILDER: Builder = {
  name: 'od',
  read: true,
  fn: async (ops, accessor, paths, _texts, opts) => {
    const index = opts.index ?? undefined
    const resolved = paths.length > 0 ? await resolveGlobOf(ops)(accessor, paths, index) : []
    const source = resolved[0] === undefined ? resolveSource(opts.stdin) : ops.readStream(accessor, resolved[0], index)
    const addressValue = opts.flags.A ?? opts.flags.address_radix
    const skipValue = opts.flags.j ?? opts.flags.skip_bytes
    const limitValue = opts.flags.N ?? opts.flags.read_bytes
    const formatValue = opts.flags.t ?? opts.flags.format
    const formats = Array.isArray(formatValue) ? formatValue : typeof formatValue === 'string' ? [formatValue] : []
    return odGeneric(
      source,
      typeof addressValue === 'string' ? addressValue : 'o',
      typeof skipValue === 'string' ? parseCount(skipValue) : 0,
      typeof limitValue === 'string' ? parseCount(limitValue) : null,
      formats,
    )
  },
}
