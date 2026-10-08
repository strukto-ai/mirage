import {
  Accessor, BaseVFS, FileStat, FileType, PathSpec, Workspace,
  checkReadContract, eisdir, enoent, enotdir,
} from '@struktoai/mirage-node'

const enc = new TextEncoder()

function keyOf(path: PathSpec): string {
  return path.vfsPath.split('/').filter(Boolean).join('/')
}

class ResourceClient extends Accessor {
  readonly files = new Map([['hello.txt', enc.encode('Hello from my resource!\n')]])
}

class ResourceVFS extends BaseVFS<ResourceClient> {
  constructor(client: ResourceClient) {
    super({ name: 'resource', accessor: client })
  }

  override async read(path: PathSpec): Promise<Uint8Array> {
    const key = keyOf(path)
    if (key === '') throw eisdir(path)
    const data = this.accessor.files.get(key)
    if (data === undefined) throw enoent(path)
    return data
  }

  override async readdir(path: PathSpec): Promise<string[]> {
    if (keyOf(path) !== '') {
      await this.read(path)
      throw enotdir(path)
    }
    return [...this.accessor.files.keys()].sort().map(name => path.child(name))
  }

  override async stat(path: PathSpec): Promise<FileStat> {
    const name = path.virtual.split('/').filter(Boolean).pop() ?? '/'
    if (keyOf(path) === '') return new FileStat({ name, type: FileType.DIRECTORY })
    const data = await this.read(path)
    return new FileStat({ name, type: FileType.FILE, size: data.length })
  }
}

async function main(): Promise<void> {
  const vfs = new ResourceVFS(new ResourceClient())
  await checkReadContract(vfs, {
    file: new PathSpec({ virtual: '/resource/hello.txt', directory: '/resource', vfsPath: 'hello.txt' }),
    directory: new PathSpec({ virtual: '/resource', directory: '/', vfsPath: '' }),
    missing: new PathSpec({ virtual: '/resource/missing', directory: '/resource', vfsPath: 'missing' }),
    content: enc.encode('Hello from my resource!\n'),
  })
  const ws = new Workspace({ '/resource': vfs })
  try {
    const result = await ws.shell('cat /resource/hello.txt')
    if (result.exitCode !== 0) throw new Error('starter mount failed')
  } finally {
    await ws.close()
  }
}

await main()
