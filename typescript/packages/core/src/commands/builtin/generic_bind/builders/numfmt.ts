import { numfmtGeneric } from '../../generic/numfmt.ts'
import type { GenericCommand, GenericCommandFn } from '../adapter.ts'

const numfmt: GenericCommandFn = (_ops, _accessor, _paths, texts, opts) =>
  numfmtGeneric(texts, opts)

export const BUILDER: GenericCommand = {
  name: 'numfmt',
  fn: numfmt,
}
