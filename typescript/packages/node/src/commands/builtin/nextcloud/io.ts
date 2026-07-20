import type { CommandIO } from '@struktoai/mirage-core'
import type { NextcloudAccessor } from '../../../accessor/nextcloud.ts'
import { SCOPE_ERROR } from '../../../core/nextcloud/constants.ts'
import { copy } from '../../../core/nextcloud/copy.ts'
import { create } from '../../../core/nextcloud/create.ts'
import { du, duAll } from '../../../core/nextcloud/du.ts'
import { exists } from '../../../core/nextcloud/exists.ts'
import { find } from '../../../core/nextcloud/find.ts'
import { mkdir } from '../../../core/nextcloud/mkdir.ts'
import { read } from '../../../core/nextcloud/read.ts'
import { readdir } from '../../../core/nextcloud/readdir.ts'
import { rename } from '../../../core/nextcloud/rename.ts'
import { rmR } from '../../../core/nextcloud/rm.ts'
import { rmdir } from '../../../core/nextcloud/rmdir.ts'
import { stat } from '../../../core/nextcloud/stat.ts'
import { stream } from '../../../core/nextcloud/stream.ts'
import { truncate } from '../../../core/nextcloud/truncate.ts'
import { unlink } from '../../../core/nextcloud/unlink.ts'
import { write } from '../../../core/nextcloud/write.ts'

export const NEXTCLOUD_IO: CommandIO<NextcloudAccessor> = {
  maxGlobMatches: SCOPE_ERROR,
  readdir,
  readBytes: read,
  readStream: stream,
  stat,
  isMounted: () => true,
  local: false,
  write,
  exists,
  mkdir,
  unlink,
  rmdir,
  rmR,
  rename,
  copy,
  create,
  truncate,
  find,
  duTotal: du,
  duAll,
}
