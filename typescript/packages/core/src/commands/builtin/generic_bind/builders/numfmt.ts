import { numfmtGeneric } from '../../generic/numfmt.ts'
import type { Builder } from '../adapter.ts'

export const NUMFMT_BUILDER: Builder = {
  name: 'numfmt',
  fn: (_ops, _accessor, _paths, texts, opts) => numfmtGeneric(texts, opts),
}
