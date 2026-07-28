import type { SharePointAccessor } from '../../../accessor/sharepoint.ts'
import { ResourceName } from '../../../types.ts'
import type { RegisteredCommand } from '../../config.ts'
import { makeGenericCommands } from '../generic_bind/index.ts'
import { SHAREPOINT_IO } from './io.ts'

export const SHAREPOINT_COMMANDS: readonly RegisteredCommand[] = [
  ...makeGenericCommands<SharePointAccessor>(ResourceName.SHAREPOINT, SHAREPOINT_IO, {}),
]
