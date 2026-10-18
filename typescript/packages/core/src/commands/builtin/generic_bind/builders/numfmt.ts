import { numfmtGeneric } from '../../generic/numfmt.ts'
import type { CommandFn } from '../../../config.ts'
import type { GenericCommand } from '../adapter.ts'

const numfmt: CommandFn = (_accessor, _paths, texts, ctx) => numfmtGeneric(texts, ctx)

export const BUILDER: GenericCommand = {
  name: 'numfmt',
  fn: numfmt,
}
