import { odGeneric } from '../../generic/od.ts'
import { type GenericCommand } from '../adapter.ts'
import { commandFiles, resolveOrEmpty } from '../files.ts'

export const BUILDER: GenericCommand = {
  name: 'od',
  read: true,
  fn: async (_accessor, paths, _texts, ctx) => {
    const files = commandFiles(ctx, paths)
    return odGeneric(await resolveOrEmpty(files, paths), ctx, files.read)
  },
}
