import { type IdSource, SystemIdSource } from '../utils/ids.ts'

/** Mint the id an execution's records name, from `ids` or the system source. */
export function newExecutionId(ids: IdSource = new SystemIdSource()): string {
  return `exec_${ids.uuid7()}`
}
