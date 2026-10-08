// A backend a deployment ships as a file and names from yaml
// (`vfs: ./wiki_backend.mjs:WikiVFS`). Two classes over one page
// store, one per half of the versioning design: WikiVFS owns its pages
// and carries them in its state, so a snapshot rebuilds the mount through
// the recorded reference with the pages as they were; FeedVFS keeps
// the default state, so a load has to be handed the live VFS and
// refuses otherwise. Must behave identically to wiki_backend.py, because
// the point of the ref form is that one deployment runs on both hosts.
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
} from '@struktoai/mirage-core'
import { rstripSlash, stripSlash } from '@struktoai/mirage-core/utils/slash'

const PAGES = { 'notes.md': 'agents just speak bash\n' }
const FEED = { 'status.md': 'All systems go.\n' }
const ENC = new TextEncoder()
const DEC = new TextDecoder()

class PageAccessor extends Accessor {
  constructor(pages) {
    super()
    this.pages = pages
  }
}

function key(path) {
  return stripSlash(path.vfsPath)
}

// One flat page store: readdir, read and stat, and write.
class PagesVFS extends BaseVFS {
  async readdir(path) {
    if (key(path) !== '') throw enotdir(path)
    const parent = rstripSlash(path.virtual)
    return Object.keys(this.accessor.pages)
      .sort()
      .map((name) => `${parent}/${name}`)
  }

  async read(path) {
    const name = key(path)
    if (name === '') throw eisdir(path)
    if (!Object.hasOwn(this.accessor.pages, name)) throw enoent(path)
    return ENC.encode(this.accessor.pages[name])
  }

  async stat(path) {
    const name = key(path)
    const trimmed = rstripSlash(path.virtual)
    const base = trimmed.slice(trimmed.lastIndexOf('/') + 1) || '/'
    if (name === '') return new FileStat({ name: base, size: null, type: FileType.DIRECTORY })
    if (!Object.hasOwn(this.accessor.pages, name)) throw enoent(path)
    const data = ENC.encode(this.accessor.pages[name])
    const fingerprint = createHash('sha256').update(data).digest('hex').slice(0, 16)
    return new FileStat({
      name: base,
      size: data.length,
      type: FileType.FILE,
      content: ContentType.TEXT,
      fingerprint,
    })
  }

  async write(path, data) {
    const name = key(path)
    if (name === '' || name.includes('/')) throw enotdir(path)
    this.accessor.pages[name] = DEC.decode(data)
  }
}

// Owned content: the pages ride the state and rebuild without help. The
// registry constructs a referenced class with the mount's config object,
// so the constructor reads its pages off that shape.
export class WikiVFS extends PagesVFS {
  constructor(config = {}) {
    const store = new PageAccessor({ ...(config.pages ?? PAGES) })
    super({ name: 'wiki', accessor: store, supportsSnapshot: true })
    this.store = store
  }

  getState() {
    return { type: this.name, pages: { ...this.store.pages } }
  }

  loadState(state) {
    this.store.pages = { ...(state.pages ?? {}) }
  }
}

// Observed content: the default state asks to be handed back live.
export class FeedVFS extends PagesVFS {
  constructor() {
    super({ name: 'feed', accessor: new PageAccessor(FEED), supportsSnapshot: true })
  }
}
