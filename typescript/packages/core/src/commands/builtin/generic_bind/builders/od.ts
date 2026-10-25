import { type util } from 'zod'

import { specOf } from '../../../spec/builtins.ts'
import { FlagView, specFlagNames } from '../../../spec/flag_view.ts'
import { IOResult } from '../../../../io/types.ts'
import { byteView } from '../../../../shell/bytes.ts'
import { StreamHost, hostedStream } from '../../utils/stream_host.ts'
import { type GenericCommand } from '../adapter.ts'
import { commandFiles, resolveOrEmpty } from '../files.ts'

export const BUILDER: GenericCommand = {
  name: 'od',
  read: true,
  fn: async (_accessor, paths, _texts, ctx) => {
    const files = commandFiles(ctx, paths)
    const resolved = await resolveOrEmpty(files, paths)
    // mirage-rs reads every option in the order typed, each value as typed,
    // and the operands, which an offset or a label may end. Mirrors the
    // Python builder.
    const spec = specOf('od')
    const options = new FlagView(ctx.flags, spec)
      .occurrences(...specFlagNames(spec))
      .map(([name, value]) => [name, typeof value === 'boolean' ? value : byteView(String(value))])
    const config: Record<string, util.JSONType> = {
      options,
      operands: resolved.map((path) => byteView(path.rawPath)),
    }
    const host = new StreamHost(resolved, files.read, ctx, true, 'od')
    const io = new IOResult()
    return [hostedStream('od', config, host, io, ctx.signal), io]
  },
}
