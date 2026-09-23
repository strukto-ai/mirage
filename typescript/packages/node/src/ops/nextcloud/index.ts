import { makeGenericOps } from '@struktoai/mirage-core/ops/generic/factory'
import type { RegisteredOp } from '@struktoai/mirage-core/ops/registry'
import { VFSName } from '@struktoai/mirage-core/types'
import { NEXTCLOUD_IO } from '../../commands/builtin/nextcloud/io.ts'

export const NEXTCLOUD_OPS: readonly RegisteredOp[] = makeGenericOps(
  VFSName.NEXTCLOUD,
  NEXTCLOUD_IO,
)
