import {
  Accessor,
  BaseVFS,
  type CLIInvocation,
  CLI,
  CLIHandler,
  CommandSpec,
  ContentType,
  eisdir,
  enoent,
  enotdir,
  FileStat,
  FileType,
  IOResult,
  MountMode,
  Argument,
  type PathSpec,
  RuntimeFiles,
  Workspace,
} from '@struktoai/mirage-node'
import { strict as assert } from 'node:assert'

const ENC = new TextEncoder()

class NotesAccessor extends Accessor {
  readonly pages: ReadonlyMap<string, string>
  readCalls = 0
  searchCalls = 0

  constructor(pages: Record<string, string>) {
    super()
    this.pages = new Map(Object.entries(pages))
  }
}

function pageBytes(accessor: NotesAccessor, path: PathSpec): Uint8Array {
  const key = path.vfsPath.replace(/^\/+|\/+$/g, '')
  if (key === '') throw eisdir(path)
  if (key.includes('/') && accessor.pages.has(key.split('/')[0])) {
    throw enotdir(path)
  }
  const page = accessor.pages.get(key)
  if (page === undefined) throw enoent(path)
  return ENC.encode(page)
}

/** A flat, read-only collection of UTF-8 pages. */
class NotesVFS extends BaseVFS<NotesAccessor> {
  constructor(pages: Record<string, string>) {
    super({
      name: 'notes',
      accessor: new NotesAccessor(pages),
      prompt: 'Read-only notes rendered as UTF-8 text files.',
      sizesAlwaysKnown: true,
    })
  }

  override async readdir(path: PathSpec): Promise<string[]> {
    if (path.vfsPath.replace(/^\/+|\/+$/g, '') !== '') {
      pageBytes(this.accessor, path)
      throw enotdir(path)
    }
    const parent = path.virtual.replace(/\/+$/, '')
    return [...this.accessor.pages.keys()].sort().map((name) => `${parent}/${name}`)
  }

  override async read(path: PathSpec): Promise<Uint8Array> {
    this.accessor.readCalls += 1
    return pageBytes(this.accessor, path)
  }

  override async stat(path: PathSpec): Promise<FileStat> {
    const name = path.virtual.replace(/\/+$/, '').split('/').pop() || '/'
    if (path.vfsPath.replace(/^\/+|\/+$/g, '') === '') {
      return new FileStat({ name, type: FileType.DIRECTORY, size: null })
    }
    return new FileStat({
      name,
      type: FileType.FILE,
      content: ContentType.TEXT,
      size: pageBytes(this.accessor, path).length,
    })
  }

  /**
   * The lines of one page holding `text`, so grep and rg skip the read. Declines
   * under -i, or for a page holding a NUL byte, which grep reports as binary.
   */
  override async linesContaining(
    path: PathSpec,
    text: string,
    opts: { ignoreCase: boolean },
  ): Promise<Uint8Array | null> {
    this.accessor.searchCalls += 1
    const page = new TextDecoder().decode(pageBytes(this.accessor, path))
    if (opts.ignoreCase || page.includes('\0')) return null
    const lines = page.split(/(?<=\n)/).filter((line) => line.includes(text))
    return ENC.encode(lines.join(''))
  }
}

async function noteInfo(inv: CLIInvocation): Promise<[Uint8Array, IOResult]> {
  const view = inv.view
  if (view?.dispatch === undefined || view.ns?.mounts == null || view.sessionView === undefined) {
    throw new Error('note-info needs workspace entry points')
  }
  const path = inv.paths[0]
  const target = view.ns.links?.resolve(path.virtual) ?? path.virtual
  const [data, result] = await view.dispatch('read', path)
  if (result.exitCode !== 0) return [new Uint8Array(), result]
  if (!(data instanceof Uint8Array)) throw new TypeError('expected file bytes')
  const mount = view.ns.mounts.rootOf(target)
  const reader = view.sessionView.get('READER') || 'anonymous'
  const header = ENC.encode(`mount=${mount} reader=${reader} bytes=${data.length}\n`)
  const output = new Uint8Array(header.length + data.length)
  output.set(header)
  output.set(data, header.length)
  return [output, result]
}

async function show(ws: Workspace, line: string): Promise<void> {
  const result = await ws.shell(line)
  if (result.exitCode !== 0) throw new Error(`${line}: ${result.stderrText}`)
  process.stdout.write(`$ ${line}\n${result.stdoutText}`)
}

async function showSearch(ws: Workspace, notes: NotesVFS): Promise<void> {
  for (const command of ['grep', 'rg']) {
    for (const [flags, pattern, calls] of [
      ['-F', 'BaseVFS', [1, 0]],
      ['-nF', 'BaseVFS', [1, 1]],
      ['-e', 'Base.*adapter', [1, 0]],
      ['-iF', 'ADAPTER', [1, 1]],
    ] as const) {
      const before = [notes.accessor.searchCalls, notes.accessor.readCalls]
      await show(ws, `${command} ${flags} '${pattern}' /notes/todo.txt`)
      assert.deepEqual(
        [notes.accessor.searchCalls - before[0], notes.accessor.readCalls - before[1]],
        calls,
      )
    }
    const readsBefore = notes.accessor.readCalls
    const missing = await ws.shell(`${command} -F absent /notes/todo.txt`)
    assert.deepEqual([missing.exitCode, missing.stdoutText, missing.stderrText], [1, '', ''])
    assert.equal(notes.accessor.readCalls, readsBefore)
  }
  console.log('Native search and scan fallbacks verified for grep and rg.')
}

async function main(): Promise<void> {
  const notes = new NotesVFS({
    'welcome.txt': 'Hello, café.\n',
    'todo.txt': 'Review the BaseVFS adapter.\n',
  })
  const ws = new Workspace(
    {
      '/notes': notes,
      '/notes/status': new NotesVFS({ 'health.txt': 'ok\n' }),
    },
    { mode: MountMode.WRITE },
  )
  try {
    ws.registerCli(
      'note-info',
      new CLI({
        spec: new CommandSpec({
          name: 'note-info',
          arguments: [new Argument('path', { type: 'path' })],
        }),
        handlers: { '': new CLIHandler({ fn: noteInfo }) },
      }),
    )
    for (const line of [
      'ln -s /notes/welcome.txt /latest',
      'ls -1 /notes',
      'cat /latest',
      'grep BaseVFS /notes/todo.txt',
      'export READER=demo; note-info /latest',
      'note-info /notes/status/health.txt',
    ]) {
      await show(ws, line)
    }
    await showSearch(ws, notes)

    const expected = ENC.encode('Hello, café.\n')
    assert.deepEqual(await ws.vfs.read('/latest'), expected)
    assert.equal((await ws.vfs.stat('/latest')).size, expected.length)
    const reader = await ws.session('reader', {
      mounts: { '/notes': MountMode.READ },
    })
    assert.deepEqual(await reader.vfs.read('/latest'), expected)

    const runtime = new RuntimeFiles((op, path) => ws.dispatch(op, path))
    assert.deepEqual(await runtime.read('/latest'), expected)
    assert.equal((await runtime.stat('/latest')).isDir, false)
    const refused = await ws.shell('echo changed > /notes/welcome.txt')
    assert.notEqual(refused.exitCode, 0)
    assert.deepEqual(await ws.vfs.read('/latest'), expected)
    console.log('Filesystem, session and runtime views agree; writes are refused.')
  } finally {
    await ws.close()
  }
}

await main()
