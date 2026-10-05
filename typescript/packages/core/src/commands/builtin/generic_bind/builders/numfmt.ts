import { numfmtGeneric } from '../../generic/numfmt.ts'
import type { Builder, BuilderFn } from '../adapter.ts'

const numfmt: BuilderFn = (_ops, _accessor, _paths, texts, opts) => numfmtGeneric(texts, opts)

export const BUILDER: Builder = {
  name: 'numfmt',
  fn: numfmt,
}
