import {
  installFakeNavigator,
  makeMockRoot,
} from '../../../typescript/packages/browser/tests/test-utils.ts'
import {
  OPFSVFS,
  Workspace as BrowserWorkspace,
} from '../../../typescript/packages/browser/src/index.ts'
import { MountMode } from '../../../typescript/packages/core/src/index.ts'
import { IO } from '../../../typescript/packages/browser/src/commands/builtin/opfs/io.ts'

console.log('IO.readRange defined?', IO.readRange !== undefined)
const restore = installFakeNavigator(() => makeMockRoot())
const ws = new BrowserWorkspace({ '/data': new OPFSVFS() }, { mode: MountMode.WRITE })
await ws.vfs.write('/data/n.txt', '0123456789')
const win = await ws.vfs.read('/data/n.txt', { offset: 2, size: 3 })
console.log('vfs.read(2,3):', JSON.stringify(new TextDecoder().decode(win)))
const dis = (await ws.dispatch('read', '/data/n.txt', [], { offset: 2, size: 3 })) as Uint8Array
console.log('dispatch(2,3):', JSON.stringify(new TextDecoder().decode(dis)))
await ws.close()
restore()
