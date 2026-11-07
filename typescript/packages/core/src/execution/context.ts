import { LineId } from './types.ts'
import { type IdSource, SystemIdSource } from '../utils/ids.ts'

/** Mint a line's id, from `ids` or the system source. */
export function newLineId(ids: IdSource = new SystemIdSource()): LineId {
  return new LineId(`line_${ids.uuid7()}`)
}
