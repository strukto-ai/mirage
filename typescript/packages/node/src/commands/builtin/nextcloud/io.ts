import { VFSAdapter, appendFromRead } from '@struktoai/mirage-core/vfs/adapter'
import { rangeOf } from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
import type { CommandIO } from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
import type { NextcloudAccessor } from '../../../accessor/nextcloud.ts'
import { SCOPE_ERROR } from '../../../core/nextcloud/constants.ts'
import { copy } from '../../../core/nextcloud/copy.ts'
import { create } from '../../../core/nextcloud/create.ts'
import {
  size as nextcloudDuSize,
  entries as nextcloudDuEntries,
} from '../../../core/nextcloud/du/index.ts'
import { exists } from '../../../core/nextcloud/exists.ts'
import { find } from '../../../core/nextcloud/find.ts'
import { mkdir } from '../../../core/nextcloud/mkdir.ts'
import { read } from '../../../core/nextcloud/read.ts'
import { readdir } from '../../../core/nextcloud/readdir.ts'
import { rename } from '../../../core/nextcloud/rename.ts'
import { rmR } from '../../../core/nextcloud/rm.ts'
import { rmdir } from '../../../core/nextcloud/rmdir.ts'
import { stat } from '../../../core/nextcloud/stat.ts'
import { readStream } from '../../../core/nextcloud/stream.ts'
import { truncate } from '../../../core/nextcloud/truncate.ts'
import { unlink } from '../../../core/nextcloud/unlink.ts'
import { write } from '../../../core/nextcloud/write.ts'

export const IO: CommandIO<NextcloudAccessor> = new VFSAdapter<NextcloudAccessor>({
  read: { readdir, readBytes: read, stat },
  native: {
    readRange: rangeOf(read),
    readStream,
    exists,
    find,
    du: { size: nextcloudDuSize, entries: nextcloudDuEntries },
  },
  writes: {
    append: appendFromRead(read, write, stat),
    write,
    mkdir,
    unlink,
    rmdir,
    rmR,
    rename,
    copy,
    create,
    truncate,
  },
  maxGlobMatches: SCOPE_ERROR,
  isMounted: () => true,
  local: false,
}).toCommandIO()
