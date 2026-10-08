import { genericCommands } from '@struktoai/mirage-core/commands/builtin/generic_bind/index'
import type { Command } from '@struktoai/mirage-core/commands/config'
import { VFSName } from '@struktoai/mirage-core/types'

export const NEXTCLOUD_COMMANDS: readonly Command[] = [...genericCommands(VFSName.NEXTCLOUD)]
