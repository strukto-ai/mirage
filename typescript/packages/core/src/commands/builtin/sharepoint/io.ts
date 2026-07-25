import type { SharePointAccessor } from '../../../accessor/sharepoint.ts'
import * as drive from '../../../core/sharepoint/index.ts'
import type { CommandIO } from '../generic_bind/index.ts'

export const SHAREPOINT_IO: CommandIO<SharePointAccessor> = {
  readdir: drive.readdir,
  readBytes: drive.read,
  readStream: drive.stream,
  stat: drive.stat,
  isMounted: () => true,
  local: false,
  write: drive.write,
  exists: drive.exists,
  mkdir: drive.mkdir,
  unlink: drive.unlink,
  rmdir: drive.rmdir,
  rmR: drive.rmR,
  rename: drive.rename,
  copy: drive.copy,
  dirCopy: drive.copy,
  create: drive.create,
  truncate: drive.truncate,
  find: drive.find,
  duTotal: drive.du,
  duAll: drive.duAll,
}
