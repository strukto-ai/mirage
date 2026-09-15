import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const run = promisify(execFile)
const require = createRequire(import.meta.url)
const { start } = require('./mirage_nfs_node.node')

// Miniature in-memory delegate: ids <-> paths, write-through store.
const files = new Map([['/hello.txt', Buffer.from('hello-from-node\n')]])
const dirs = new Set(['/', '/docs'])
files.set('/docs/n.txt', Buffer.from('nested\n'))
const links = new Map()
const byPath = new Map([['/', 1]])
const byId = new Map([[1, '/']])
let nextId = 2
const alloc = (p) => {
  if (byPath.has(p)) return byPath.get(p)
  const id = nextId++
  byPath.set(p, id)
  byId.set(id, p)
  return id
}
const join2 = (d, n) => (d === '/' ? '/' + n : d + '/' + n)
const attrsOf = (id, p) => {
  if (links.has(p))
    return { fileid: id, size: Buffer.byteLength(links.get(p)), isDir: false, isSymlink: true }
  if (dirs.has(p)) return { fileid: id, size: 0, isDir: true, isSymlink: false }
  if (files.has(p)) return { fileid: id, size: files.get(p).length, isDir: false, isSymlink: false }
  return null
}

const delegate = {
  lookup: async ({ dirId, name }) => {
    const p = join2(byId.get(dirId), name)
    if (!dirs.has(p) && !files.has(p) && !links.has(p)) return { errno: 2 }
    return { fileid: alloc(p) }
  },
  getattr: async ({ id }) => {
    const p = byId.get(id)
    const a = p && attrsOf(id, p)
    return a ?? { errno: 2, fileid: 0, size: 0, isDir: false, isSymlink: false }
  },
  setSize: async ({ id, size }) => {
    const p = byId.get(id)
    if (size !== undefined && size !== null && files.has(p))
      files.set(p, files.get(p).subarray(0, size))
    return attrsOf(id, p)
  },
  read: async ({ id, offset, count }) => {
    const p = byId.get(id)
    if (!files.has(p)) return { errno: 2 }
    return { data: files.get(p).subarray(offset, offset + count) }
  },
  write: async ({ id, offset, data }) => {
    const p = byId.get(id)
    const base = files.get(p) ?? Buffer.alloc(0)
    const end = offset + data.length
    const merged = Buffer.alloc(Math.max(base.length, end))
    base.copy(merged)
    data.copy(merged, offset)
    files.set(p, merged)
    return attrsOf(id, p)
  },
  create: async ({ dirId, name }) => {
    const p = join2(byId.get(dirId), name)
    files.set(p, Buffer.alloc(0))
    return { fileid: alloc(p) }
  },
  mkdir: async ({ dirId, name }) => {
    const p = join2(byId.get(dirId), name)
    dirs.add(p)
    return { fileid: alloc(p) }
  },
  remove: async ({ dirId, name }) => {
    const p = join2(byId.get(dirId), name)
    if (links.delete(p)) return {}
    if (dirs.delete(p)) return {}
    return files.delete(p) ? {} : { errno: 2 }
  },
  rename: async ({ fromDirId, fromName, toDirId, toName }) => {
    const src = join2(byId.get(fromDirId), fromName)
    const dst = join2(byId.get(toDirId), toName)
    if (files.has(src)) {
      files.set(dst, files.get(src))
      files.delete(src)
    }
    if (dirs.has(src)) {
      dirs.add(dst)
      dirs.delete(src)
    }
    const id = byPath.get(src)
    if (id !== undefined) {
      byPath.delete(src)
      byPath.set(dst, id)
      byId.set(id, dst)
    }
    return {}
  },
  symlink: async ({ dirId, name, target }) => {
    const p = join2(byId.get(dirId), name)
    links.set(p, target)
    return { fileid: alloc(p) }
  },
  readlink: async ({ id }) => {
    const p = byId.get(id)
    return links.has(p) ? { text: links.get(p) } : { errno: 22 }
  },
  readdir: async ({ dirId, startAfter, maxEntries }) => {
    const base = byId.get(dirId)
    const prefix = base === '/' ? '/' : base + '/'
    const names = new Set()
    for (const k of [...files.keys(), ...dirs, ...links.keys()]) {
      if (k !== base && k.startsWith(prefix)) names.add(k.slice(prefix.length).split('/')[0])
    }
    const sorted = [...names].sort()
    const out = []
    let resuming = startAfter !== 0
    for (const n of sorted) {
      const id = alloc(join2(base, n))
      if (resuming) {
        if (id === startAfter) resuming = false
        continue
      }
      out.push({ name: n, attrs: attrsOf(id, join2(base, n)) })
      if (out.length >= maxEntries) break
    }
    return { entries: out }
  },
  flushIdle: async () => ({}),
}

const handle = await start(
  delegate.lookup,
  delegate.getattr,
  delegate.setSize,
  delegate.read,
  delegate.write,
  delegate.create,
  delegate.mkdir,
  delegate.remove,
  delegate.rename,
  delegate.symlink,
  delegate.readlink,
  delegate.readdir,
  delegate.flushIdle,
  '127.0.0.1',
  0,
  1,
  process.getuid(),
  process.getgid(),
  5.0,
)
const port = handle.port()
console.log(`server up on 127.0.0.1:${port}`)
const mnt = mkdtempSync(join(tmpdir(), 'mirage-nfs-ts-'))
const opts = `nolocks,vers=3,tcp,rsize=131072,actimeo=0,port=${port},mountport=${port}`
await run('mount_nfs', ['-o', opts, '127.0.0.1:/', mnt])
console.log('mount  : ok')

const checks = []
const sh = async (...argv) => {
  try {
    const { stdout } = await run(argv[0], argv.slice(1))
    return [0, stdout.trim()]
  } catch (e) {
    return [e.code ?? 1, (e.stdout ?? '').trim() + (e.stderr ?? '').trim()]
  }
}
let [c, o] = await sh('ls', mnt)
checks.push([`ls -> ${o}`, o.includes('hello.txt') && o.includes('docs')])
;[c, o] = await sh('cat', `${mnt}/hello.txt`)
checks.push([`cat -> ${o}`, o === 'hello-from-node'])
;[c, o] = await sh('cat', `${mnt}/docs/n.txt`)
checks.push([`nested -> ${o}`, o === 'nested'])
;[c, o] = await sh('sh', '-c', `echo via-ts > ${mnt}/new.txt`)
checks.push(['write', c === 0])
;[c, o] = await sh('cat', `${mnt}/new.txt`)
checks.push([`read-back -> ${o}`, o === 'via-ts'])
;[c, o] = await sh('sh', '-c', `mkdir ${mnt}/d && mv ${mnt}/new.txt ${mnt}/d/m.txt`)
checks.push(['mkdir+mv', c === 0])
;[c, o] = await sh('cat', `${mnt}/d/m.txt`)
checks.push([`moved -> ${o}`, o === 'via-ts'])
;[c, o] = await sh('ln', '-s', 'hello.txt', `${mnt}/lnk`)
checks.push(['ln -s', c === 0])
;[c, o] = await sh('readlink', `${mnt}/lnk`)
checks.push([`readlink -> ${o}`, o === 'hello.txt'])
;[c, o] = await sh('cat', `${mnt}/lnk`)
checks.push([`through link -> ${o}`, o === 'hello-from-node'])
;[c, o] = await sh('rm', `${mnt}/lnk`)
checks.push(['rm link', c === 0])
;[c, o] = await sh('cat', `${mnt}/hello.txt`)
checks.push(['target survives', o === 'hello-from-node'])

await run('umount', [mnt])
handle.stop()
for (const [line, ok] of checks) console.log((ok ? 'PASS ' : 'FAIL ') + line)
const passed = checks.every(([, ok]) => ok)
console.log(passed ? 'TS-SMOKE-OK' : 'TS-SMOKE-FAILED')
process.exitCode = passed ? 0 : 1

// No process.exit() on purpose: stop() has to release node's event loop
// by itself, and this is exactly where that regressed once -- the idle
// flusher looped forever, so its threadsafe function kept the loop
// referenced and a clean run still hung. The watchdog is unref'd, so it
// cannot hold the loop open itself; it only ever fires if something
// else does.
setTimeout(() => {
  console.log(
    'TS-SMOKE-FAILED: still running after stop(); the addon kept the event loop referenced',
  )
  process.exit(1)
}, 10_000).unref()
