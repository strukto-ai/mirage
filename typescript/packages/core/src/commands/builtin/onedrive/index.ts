import type { OneDriveAccessor } from '../../../accessor/onedrive.ts'
import { read, stat } from '../../../core/onedrive/index.ts'
import { ResourceName } from '../../../types.ts'
import type { RegisteredCommand } from '../../config.ts'
import { makeFiletypeCommands } from '../filetype_factory/factory.ts'
import { makeGenericCommands } from '../generic_bind/index.ts'
import { ONEDRIVE_IO } from './io.ts'

export const ONEDRIVE_COMMANDS: readonly RegisteredCommand[] = [
  ...makeFiletypeCommands<OneDriveAccessor>({
    resource: ResourceName.ONEDRIVE,
    readBytes: read,
    statEntry: stat,
  }),
  ...makeGenericCommands<OneDriveAccessor>(ResourceName.ONEDRIVE, ONEDRIVE_IO, {}),
]
