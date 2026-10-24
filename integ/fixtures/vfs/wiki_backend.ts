// The TypeScript-source spelling of wiki_backend.mjs, loaded through
// Node's type stripping: strip-only, so no parameter properties, enums or
// namespaces here. Same two classes, same behaviour as the .py and .mjs
// twins.
import { createHash } from 'node:crypto'
import {
  Accessor,
  BaseVFS,
  ContentType,
  eisdir,
  enoent,
  enotdir,
  FileStat,
  FileType,
  type PathSpec,
} from '@struktoai/mirage-core'
import { type ByteSource, materialize } from '@struktoai/mirage-core/io/types'
import { rstripSlash, stripSlash } from '@struktoai/mirage-core/utils/slash'

type Pages = Record<string, string>

const PAGES: Pages = { 'notes.md': 'agents just speak bash\n' }
const FEED: Pages = { 'status.md': 'All systems go.\n' }
const ENC = new TextEncoder()
const DEC = new TextDecoder()

class PageAccessor extends Accessor {
  pages: Pages
  constructor(pages: Pages) {
    super()
    this.pages = pages
  }
}

function key(path: PathSpec): string {
  return stripSlash(path.vfsPath)
}

function row(name: string, page: string): FileStat {
  const data = ENC.encode(page)
  const fingerprint = createHash('sha256').update(data).digest('hex').slice(0, 16)
  return new FileStat({
    name,
    size: data.length,
    type: FileType.FILE,
    content: ContentType.TEXT,
    fingerprint,
  })
}

// One flat page store: readdir, read and stat, and write.
class PagesVFS extends BaseVFS<PageAccessor> {
  override async readdir(path: PathSpec): Promise<FileStat[]> {
    if (key(path) !== '') throw enotdir(path)
    return Object.keys(this.accessor.pages)
      .sort()
      .map((name) => row(name, this.accessor.pages[name] ?? ''))
  }

  override async read(path: PathSpec): Promise<Uint8Array> {
    const name = key(path)
    if (name === '') throw eisdir(path)
    if (!Object.hasOwn(this.accessor.pages, name)) throw enoent(path)
    return ENC.encode(this.accessor.pages[name])
  }

  override async stat(path: PathSpec): Promise<FileStat> {
    const name = key(path)
    const trimmed = rstripSlash(path.virtual)
    const base = trimmed.slice(trimmed.lastIndexOf('/') + 1) || '/'
    if (name === '') return new FileStat({ name: base, size: null, type: FileType.DIRECTORY })
    if (!Object.hasOwn(this.accessor.pages, name)) throw enoent(path)
    return row(base, this.accessor.pages[name] ?? '')
  }

  override async write(path: PathSpec, data: ByteSource): Promise<void> {
    const name = key(path)
    if (name === '' || name.includes('/')) throw enotdir(path)
    this.accessor.pages[name] = DEC.decode(await materialize(data))
  }
}

// Owned content: the pages ride the state and rebuild without help. The
// registry constructs a referenced class with the mount's config object,
// so the constructor reads its pages off that shape.
export class WikiVFS extends PagesVFS {
  readonly store: PageAccessor

  constructor(config: { pages?: Pages } = {}) {
    const store = new PageAccessor({ ...(config.pages ?? PAGES) })
    super({ name: 'wiki', accessor: store, supportsSnapshot: true })
    this.store = store
  }

  override getState(): { type: string; pages: Pages } {
    return { type: this.name, pages: { ...this.store.pages } }
  }

  override loadState(state: { type: string; pages?: Pages }): void {
    this.store.pages = { ...(state.pages ?? {}) }
  }
}

// Observed content: the default state asks to be handed back live.
export class FeedVFS extends PagesVFS {
  constructor() {
    super({ name: 'feed', accessor: new PageAccessor(FEED), supportsSnapshot: true })
  }
}
