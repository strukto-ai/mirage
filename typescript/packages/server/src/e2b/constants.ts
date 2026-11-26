import { CAPACITY } from '@struktoai/mirage-core/io/pipe'
import { FileType } from '@struktoai/mirage-core/types'

export const HOME = '/home/user'
export const ENVD_PORT = '49983'

export const PROCESS_PREFIX = '/process.Process/'
export const START = PROCESS_PREFIX + 'Start'
export const CONTROL_METHODS = ['List', 'SendInput', 'CloseStdin', 'SendSignal'] as const
export const CONNECT_STREAM = 'application/connect+json'
export const DEADLINE_MESSAGE = 'command deadline exceeded'
export const MAX_CONTROL_BODY = 2 * CAPACITY

export const CREATE = '/v2/sandboxes'
export const CONNECT = '/v2/sandboxes/:id/connect'
export const KILL = '/sandboxes/:id'
export const SET_TIMEOUT = '/sandboxes/:id/timeout'
export const HEALTH = '/health'
export const FILES = '/files'
export const RPC_PREFIX = '/filesystem.Filesystem/'
export const METHODS = ['Stat', 'ListDir', 'MakeDir', 'Move', 'Remove'] as const
export const UNSUPPORTED_LIFECYCLE_ROUTES = [
  ['GET', CREATE],
  ['GET', '/sandboxes'],
  ['GET', KILL],
  ['GET', '/sandboxes/:id/metrics'],
  ['POST', '/sandboxes/:id/pause'],
  ['POST', '/sandboxes/:id/resume'],
] as const
export const UNSUPPORTED_RPC_PATHS = [
  RPC_PREFIX + 'WatchDir',
  RPC_PREFIX + 'CreateWatcher',
  RPC_PREFIX + 'GetWatcherEvents',
  RPC_PREFIX + 'RemoveWatcher',
  PROCESS_PREFIX + 'Connect',
  PROCESS_PREFIX + 'Update',
  PROCESS_PREFIX + 'StreamInput',
]
export const RPC_PATHS: ReadonlySet<string> = new Set([
  ...METHODS.map((method) => RPC_PREFIX + method),
  ...UNSUPPORTED_RPC_PATHS,
])

// Map the SDK default to an optional saved Mirage workspace template.
export const BASE_TEMPLATE = 'base'
export const BASE_WORKSPACE_TEMPLATE = 'e2b-base'
export const DEFAULT_TIMEOUT = 300
export const ENVD_VERSION = '0.5.6'

export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024

export const TYPES: Partial<Record<FileType, string>> = {
  [FileType.FILE]: 'FILE_TYPE_FILE',
  [FileType.DIRECTORY]: 'FILE_TYPE_DIRECTORY',
  [FileType.SYMLINK]: 'FILE_TYPE_SYMLINK',
}
