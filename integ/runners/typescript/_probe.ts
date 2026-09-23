import {
  installFakeNavigator,
  makeMockRoot,
} from '../../../typescript/packages/browser/src/test-utils.ts'
import {
  OPFSVFS,
  Workspace as BrowserWorkspace,
} from '../../../typescript/packages/browser/src/index.ts'
import { MountMode } from '../../../typescript/packages/core/src/index.ts'
import { OPFS_IO } from '../../../typescript/packages/browser/src/commands/builtin/opfs/io.ts'

console.log('OPFS_IO.readRange defined?', OPFS_IO.readRange !== undefined)
const restore = installFakeNavigator(() => makeMockRoot())
const ws = new BrowserWorkspace({ '/data': new OPFSVFS() }, { mode: MountMode.WRITE })
await ws.vfs.writeFile('/data/n.txt', '0123456789')
const win = await ws.vfs.readFile('/data/n.txt', { offset: 2, size: 3 })
console.log('vfs.readFile(2,3):', JSON.stringify(new TextDecoder().decode(win)))
const dis = (await ws.dispatch('read', '/data/n.txt', [], { offset: 2, size: 3 })) as Uint8Array
console.log('dispatch(2,3):', JSON.stringify(new TextDecoder().decode(dis)))
await ws.close()
restore()
