import type { SharePointAccessor } from '../../../accessor/sharepoint.ts'
import { VFSName } from '../../../types.ts'
import type { RegisteredCommand } from '../../config.ts'
import { makeGenericCommands } from '../generic_bind/index.ts'
import { SHAREPOINT_IO } from './io.ts'

export const SHAREPOINT_COMMANDS: readonly RegisteredCommand[] = [
  ...makeGenericCommands<SharePointAccessor>(VFSName.SHAREPOINT, SHAREPOINT_IO, {}),
]
