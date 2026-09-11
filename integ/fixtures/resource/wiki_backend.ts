// The TypeScript-source spelling of wiki_backend.mjs, loaded through
// Node's type stripping: strip-only, so no parameter properties, enums or
// namespaces here. Same two classes, same behaviour as the .py and .mjs
// twins.
import { createHash } from 'node:crypto'
import {
  Accessor,
  type CommandIO,
  ContentType,
  eisdir,
  enoent,
  enotdir,
  FileStat,
  FileType,
  GenericResource,
  type PathSpec,
  streamFromBytes,
} from '@struktoai/mirage-core'

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
  return path.resourcePath.replace(/^\/+|\/+$/g, '')
}

function readdir(accessor: PageAccessor, path: PathSpec): Promise<string[]> {
  if (key(path) !== '') throw enotdir(path)
  const parent = path.virtual.replace(/\/+$/, '')
  return Promise.resolve(
    Object.keys(accessor.pages)
      .sort()
      .map((name) => `${parent}/${name}`),
  )
}

function readBytes(accessor: PageAccessor, path: PathSpec): Promise<Uint8Array> {
  const name = key(path)
  if (name === '') throw eisdir(path)
  if (!Object.hasOwn(accessor.pages, name)) throw enoent(path)
  return Promise.resolve(ENC.encode(accessor.pages[name]))
}

function stat(accessor: PageAccessor, path: PathSpec): Promise<FileStat> {
  const name = key(path)
  const trimmed = path.virtual.replace(/\/+$/, '')
  const base = trimmed.slice(trimmed.lastIndexOf('/') + 1) || '/'
  if (name === '') {
    return Promise.resolve(new FileStat({ name: base, size: null, type: FileType.DIRECTORY }))
  }
  if (!Object.hasOwn(accessor.pages, name)) throw enoent(path)
  const data = ENC.encode(accessor.pages[name])
  const fingerprint = createHash('sha256').update(data).digest('hex').slice(0, 16)
  return Promise.resolve(
    new FileStat({
      name: base,
      size: data.length,
      type: FileType.FILE,
      content: ContentType.TEXT,
      fingerprint,
    }),
  )
}

function write(accessor: PageAccessor, path: PathSpec, data: Uint8Array): Promise<void> {
  const name = key(path)
  if (name === '' || name.includes('/')) throw enotdir(path)
  accessor.pages[name] = DEC.decode(data)
  return Promise.resolve()
}

function makeIO(): CommandIO<PageAccessor> {
  return {
    readdir,
    readBytes,
    readStream: (a, p, i) => streamFromBytes(readBytes, a, p, i),
    stat,
    write,
    isMounted: () => true,
    local: false,
  }
}

// Owned content: the pages ride the state and rebuild without help. The
// registry constructs a referenced class with the mount's config object,
// so the constructor reads its pages off that shape.
export class WikiResource extends GenericResource<PageAccessor> {
  readonly store: PageAccessor

  constructor(config: { pages?: Pages } = {}) {
    const store = new PageAccessor({ ...(config.pages ?? PAGES) })
    super({ name: 'wiki', accessor: store, io: makeIO(), supportsSnapshot: true })
    this.store = store
  }

  override getState(): { type: string; pages: Pages } {
    return { type: this.kind, pages: { ...this.store.pages } }
  }

  override loadState(state: { type: string; pages?: Pages }): void {
    this.store.pages = { ...(state.pages ?? {}) }
  }
}

// Observed content: the default state asks to be handed back live.
export class FeedResource extends GenericResource<PageAccessor> {
  constructor() {
    super({ name: 'feed', accessor: new PageAccessor(FEED), io: makeIO(), supportsSnapshot: true })
  }
}
