import { SHAREPOINT_IO } from '../../commands/builtin/sharepoint/io.ts'
import { ResourceName } from '../../types.ts'
import { makeGenericOps } from '../generic/factory.ts'
import type { RegisteredOp } from '../registry.ts'
import { liveIdentityOp } from './identity.ts'

export const SHAREPOINT_OPS: readonly RegisteredOp[] = [
  ...makeGenericOps(ResourceName.SHAREPOINT, SHAREPOINT_IO),
  liveIdentityOp,
]
