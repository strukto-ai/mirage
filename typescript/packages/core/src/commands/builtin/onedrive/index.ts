import type { OneDriveAccessor } from '../../../accessor/onedrive.ts'
import { VFSName } from '../../../types.ts'
import type { RegisteredCommand } from '../../config.ts'
import { makeGenericCommands } from '../generic_bind/index.ts'
import { ONEDRIVE_IO } from './io.ts'

export const ONEDRIVE_COMMANDS: readonly RegisteredCommand[] = [
  ...makeGenericCommands<OneDriveAccessor>(VFSName.ONEDRIVE, ONEDRIVE_IO, {}),
]
