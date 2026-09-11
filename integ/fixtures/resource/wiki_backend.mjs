// A backend a deployment ships as a file and names from yaml
// (`resource: ./wiki_backend.mjs:WikiResource`). Two classes over one page
// store, one per half of the versioning design: WikiResource owns its pages
// and carries them in its state, so a snapshot rebuilds the mount through
// the recorded reference with the pages as they were; FeedResource keeps
// the default state, so a load has to be handed the live resource and
// refuses otherwise. Must behave identically to wiki_backend.py, because
// the point of the ref form is that one deployment runs on both hosts.
import { createHash } from 'node:crypto'
import {
  Accessor,
  ContentType,
  eisdir,
  enoent,
  enotdir,
  FileStat,
  FileType,
  GenericResource,
  streamFromBytes,
} from '@struktoai/mirage-core'

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
  return path.resourcePath.replace(/^\/+|\/+$/g, '')
}

function readdir(accessor, path) {
  if (key(path) !== '') throw enotdir(path)
  const parent = path.virtual.replace(/\/+$/, '')
  return Promise.resolve(
    Object.keys(accessor.pages)
      .sort()
      .map((name) => `${parent}/${name}`),
  )
}

function readBytes(accessor, path) {
  const name = key(path)
  if (name === '') throw eisdir(path)
  if (!Object.hasOwn(accessor.pages, name)) throw enoent(path)
  return Promise.resolve(ENC.encode(accessor.pages[name]))
}

function stat(accessor, path) {
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

function write(accessor, path, data) {
  const name = key(path)
  if (name === '' || name.includes('/')) throw enotdir(path)
  accessor.pages[name] = DEC.decode(data)
  return Promise.resolve()
}

function makeIO() {
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
export class WikiResource extends GenericResource {
  constructor(config = {}) {
    const store = new PageAccessor({ ...(config.pages ?? PAGES) })
    super({ name: 'wiki', accessor: store, io: makeIO(), supportsSnapshot: true })
    this.store = store
  }

  getState() {
    return { type: this.kind, pages: { ...this.store.pages } }
  }

  loadState(state) {
    this.store.pages = { ...(state.pages ?? {}) }
  }
}

// Observed content: the default state asks to be handed back live.
export class FeedResource extends GenericResource {
  constructor() {
    super({ name: 'feed', accessor: new PageAccessor(FEED), io: makeIO(), supportsSnapshot: true })
  }
}
