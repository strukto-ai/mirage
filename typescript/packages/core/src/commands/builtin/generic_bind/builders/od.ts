import { odGeneric, parseCount } from '../../generic/od.ts'
import { resolveSource } from '../../utils/stream.ts'
import { type Builder, resolveGlobOf } from '../adapter.ts'

async function* concatSources(sources: AsyncIterable<Uint8Array>[]): AsyncIterable<Uint8Array> {
  for (const source of sources) {
    for await (const chunk of source) yield chunk
  }
}

export const OD_BUILDER: Builder = {
  name: 'od',
  read: true,
  fn: async (ops, accessor, paths, _texts, opts) => {
    const index = opts.index ?? undefined
    const resolved = paths.length > 0 ? await resolveGlobOf(ops)(accessor, paths, index) : []
    // od defines multiple FILE operands as one concatenated input, so skip
    // and limit offsets apply across the whole run, not per file.
    const source =
      resolved.length === 0
        ? resolveSource(opts.stdin)
        : concatSources(resolved.map((p) => ops.readStream(accessor, p, index)))
    const addressValue = opts.flags.A ?? opts.flags.address_radix
    const skipValue = opts.flags.j ?? opts.flags.skip_bytes
    const limitValue = opts.flags.N ?? opts.flags.read_bytes
    const formatValue = opts.flags.t ?? opts.flags.format
    const formats = Array.isArray(formatValue)
      ? formatValue
      : typeof formatValue === 'string'
        ? [formatValue]
        : []
    return odGeneric(
      source,
      typeof addressValue === 'string' ? addressValue : 'o',
      typeof skipValue === 'string' ? parseCount(skipValue) : 0,
      typeof limitValue === 'string' ? parseCount(limitValue) : null,
      formats,
    )
  },
}
