import type { SharePointAccessor } from '../../../accessor/sharepoint.ts'
import { read, stat } from '../../../core/sharepoint/index.ts'
import { ResourceName } from '../../../types.ts'
import type { RegisteredCommand } from '../../config.ts'
import { makeFiletypeCommands } from '../filetype_factory/factory.ts'
import { makeGenericCommands } from '../generic_bind/index.ts'
import { SHAREPOINT_IO } from './io.ts'

export const SHAREPOINT_COMMANDS: readonly RegisteredCommand[] = [
  ...makeFiletypeCommands<SharePointAccessor>({
    resource: ResourceName.SHAREPOINT,
    readBytes: read,
    statEntry: stat,
  }),
  ...makeGenericCommands<SharePointAccessor>(ResourceName.SHAREPOINT, SHAREPOINT_IO, {}),
]
