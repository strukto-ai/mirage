import { odGeneric, parseCount } from '../../generic/od.ts'
import { resolveSource } from '../../utils/stream.ts'
import { specOf } from '../../../spec/builtins.ts'
import { FlagView } from '../../../spec/types.ts'
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
    const fl = new FlagView(opts.flags, specOf('od'))
    // asStr, not a truthiness test: an explicitly empty value is an
    // invalid argument to GNU, not an absent flag.
    const skipValue = fl.asStr('skip_bytes')
    const limitValue = fl.asStr('read_bytes')
    return odGeneric(
      source,
      fl.asStr('address_radix') ?? 'o',
      skipValue !== undefined ? parseCount(skipValue, '-j') : 0,
      limitValue !== undefined ? parseCount(limitValue, '-N') : null,
      fl.asList('format'),
    )
  },
}
