import { SHAREPOINT_IO } from '../../commands/builtin/sharepoint/io.ts'
import { VFSName } from '../../types.ts'
import { makeGenericOps } from '../generic/factory.ts'
import type { RegisteredOp } from '../registry.ts'

export const SHAREPOINT_OPS: readonly RegisteredOp[] = makeGenericOps(
  VFSName.SHAREPOINT,
  SHAREPOINT_IO,
)
