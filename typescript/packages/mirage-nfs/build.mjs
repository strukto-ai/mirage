import { copyFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// cargo names a cdylib per platform; the loader always asks for
// mirage_nfs_node.node, which is what package.json's main points at.
const ARTIFACTS = {
  darwin: 'libmirage_nfs_node.dylib',
  linux: 'libmirage_nfs_node.so',
  win32: 'mirage_nfs_node.dll',
}

const here = dirname(fileURLToPath(import.meta.url))
const artifact = ARTIFACTS[process.platform]
if (artifact === undefined) {
  console.error(`mirage-nfs-node: no cargo artifact name for platform ${process.platform}`)
  process.exit(1)
}

const built = join(here, 'target', 'release', artifact)
if (!existsSync(built)) {
  console.error(`mirage-nfs-node: ${built} is missing; run cargo build --release first`)
  process.exit(1)
}

copyFileSync(built, join(here, 'mirage_nfs_node.node'))
