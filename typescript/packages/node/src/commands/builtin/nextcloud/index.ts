import { makeGenericCommands } from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
import type { RegisteredCommand } from '@struktoai/mirage-core/commands/config'
import { VFSName } from '@struktoai/mirage-core/types'

export const NEXTCLOUD_COMMANDS: readonly RegisteredCommand[] = [
  ...makeGenericCommands(VFSName.NEXTCLOUD),
]
