import {
  makeFiletypeCommands,
  makeGenericCommands,
  ResourceName,
  type RegisteredCommand,
} from '@struktoai/mirage-core'
import type { NextcloudAccessor } from '../../../accessor/nextcloud.ts'
import { read } from '../../../core/nextcloud/read.ts'
import { stat } from '../../../core/nextcloud/stat.ts'
import { NEXTCLOUD_IO } from './io.ts'

export const NEXTCLOUD_COMMANDS: readonly RegisteredCommand[] = [
  ...makeFiletypeCommands<NextcloudAccessor>({
    resource: ResourceName.NEXTCLOUD,
    readBytes: read,
    statEntry: stat,
  }),
  ...makeGenericCommands<NextcloudAccessor>(ResourceName.NEXTCLOUD, NEXTCLOUD_IO),
]
