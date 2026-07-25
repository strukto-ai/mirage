import { ONEDRIVE_IO } from '../../commands/builtin/onedrive/io.ts'
import { ResourceName } from '../../types.ts'
import { makeGenericOps } from '../generic/factory.ts'
import type { RegisteredOp } from '../registry.ts'

export const ONEDRIVE_OPS: readonly RegisteredOp[] = makeGenericOps(
  ResourceName.ONEDRIVE,
  ONEDRIVE_IO,
)
