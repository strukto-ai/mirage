import { makeGenericOps, ResourceName, type RegisteredOp } from '@struktoai/mirage-core'
import { NEXTCLOUD_IO } from '../../commands/builtin/nextcloud/io.ts'

export const NEXTCLOUD_OPS: readonly RegisteredOp[] = makeGenericOps(
  ResourceName.NEXTCLOUD,
  NEXTCLOUD_IO,
  { filetypeRead: ['.feather', '.hdf5', '.parquet'] },
)
