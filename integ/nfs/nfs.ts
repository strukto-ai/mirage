// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { execFile, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, basename } from 'node:path'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  checkPlatformNfs,
  FileStat,
  FileType,
  Mount,
  MountBackend,
  MountMode,
  NFSConfig,
  NFSManager,
  RAMResource,
  Workspace,
} from '@struktoai/mirage-node'

// The battery asks the OS for a port instead of taking the fixed
// default. Two batteries run back to back in one CI job, and this one
// hit EADDRINUSE on 20490 seventy-nine seconds after the Python one had
// exited with its mounts cleaned -- a race no run reproduces reliably
// and none of them should have to. The declared-mount scenario below
// still exercises the default, since a Mount({backend: nfs}) carries no
// config to override it with.
const EPHEMERAL = new NFSConfig({ port: 0 })

// The addon is not published yet, so a local build is the default and CI
// (or a developer with the crate built elsewhere) overrides it. Named
// loudly rather than resolved silently: without it every probe below
// fails with "needs the addon", which reads as a mount bug.
const BUILT_ADDON = fileURLToPath(
  new URL('../../typescript/packages/mirage-nfs/mirage_nfs_node.node', import.meta.url),
)
if (process.env.MIRAGE_NFS_ADDON === undefined) {
  process.env.MIRAGE_NFS_ADDON = BUILT_ADDON
  process.stderr.write(`MIRAGE_NFS_ADDON unset; using ${BUILT_ADDON}\n`)
}

const DEC = new TextDecoder()
type Result = Record<string, string | number | boolean | string[] | null>

// Every mountpoint this run has created, so a crash, a Ctrl-C or a hung
// battery can still force them down. A live mount whose server has gone
// is the one state that outlives the process: every access to it blocks
// in the kernel, and on macOS that reaches anything walking the mount
// table, which is Finder and df and Spotlight rather than just this
// script.
const MOUNTPOINTS = new Set<string>()

const BATTERY_TIMEOUT_SECONDS = 300
const FORCE_UMOUNT_TIMEOUT_SECONDS = 15

/**
 * Whether a mountpoint directory is gone, without stat'ing it.
 *
 * A stat of the path would be answered by the server that has just
 * stopped if the unmount had failed -- the one check that only runs
 * after something went wrong would be the one that hangs. Listing the
 * parent names the entry without ever crossing into it.
 */
function gone(path: string): boolean {
  const trimmed = path.replace(/\/+$/, '')
  if (trimmed === '') return true
  try {
    return !readdirSync(dirname(trimmed)).includes(basename(trimmed))
  } catch {
    return true
  }
}

/**
 * Force every recorded mountpoint down, synchronously.
 *
 * Sync on purpose: this runs from a signal handler and from the exit
 * path, where the event loop may be the thing that is stuck, so it
 * cannot await. `umount -f` is what makes that safe -- a plain unmount
 * asks the filesystem to flush, and the server that would answer is the
 * process being torn down.
 */
function forceUnmountAll(): void {
  for (const point of [...MOUNTPOINTS].sort()) {
    if (gone(point)) continue
    const done = spawnSync('umount', ['-f', point], {
      stdio: 'ignore',
      timeout: FORCE_UMOUNT_TIMEOUT_SECONDS * 1000,
    })
    if (done.status !== 0) {
      process.stderr.write(
        `integ/nfs: umount -f ${point} did not clear it; clear it with ` +
          `sudo umount -f ${point}\n`,
      )
    }
  }
  MOUNTPOINTS.clear()
}

/** Mount through the manager and record the mountpoint. */
async function track(
  manager: NFSManager,
  ws: Workspace,
  prefix = '/',
  mountpoint?: string,
): Promise<string> {
  const point = await manager.setup(ws, prefix, mountpoint, EPHEMERAL)
  MOUNTPOINTS.add(point)
  return point
}

/**
 * Run one command in a child process and capture its output.
 *
 * Every touch of the mountpoint must leave this process: the NFS server
 * is served BY this event loop, so a synchronous stat here would
 * deadlock the request it produces.
 */
async function sh(...argv: string[]): Promise<[number, string]> {
  return new Promise((resolve) => {
    execFile(
      argv[0] as string,
      argv.slice(1),
      { timeout: 20_000, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const out = `${stdout}${stderr}`.trim()
        const code = err === null ? 0 : ((err as { code?: number }).code ?? 1)
        resolve([typeof code === 'number' ? code : 1, out])
      },
    )
  })
}

async function writeThrough(path: string, text: string): Promise<number> {
  const [code] = await sh('sh', '-c', `printf '%s' '${text}' > ${path}`)
  return code
}

/** The single-server, multi-mount battery over a RAM workspace. */
async function runBattery(result: Result): Promise<void> {
  const ws = new Workspace({ '/': new RAMResource() }, { mode: MountMode.WRITE })
  await ws.execute('echo alpha > /a.txt')
  await ws.execute('mkdir /docs && echo beta > /docs/b.txt')

  const manager = new NFSManager()
  let whole = ''
  let docs = ''
  try {
    whole = await track(manager, ws, '/')
    docs = await track(manager, ws, '/docs')
    result.distinct_mounts = whole !== docs

    let out: string
    ;[, out] = await sh('cat', `${whole}/a.txt`)
    result.cat_a = out
    ;[, out] = await sh('cat', `${docs}/b.txt`)
    result.subtree_cat_b = out
    ;[, out] = await sh('ls', whole)
    result.ls_names = out
      .split(/\s+/)
      .filter((name) => name !== '' && name !== 'dev')
      .sort()

    result.write_ok = (await writeThrough(`${docs}/new.txt`, 'via-nfs')) === 0
    // One server, two exports: a write through the subtree mount is
    // visible through the whole-tree mount, because both are views of
    // the same op tree rather than two copies of it.
    ;[, out] = await sh('cat', `${whole}/docs/new.txt`)
    result.cross_mount_readback = out

    let code: number
    ;[code] = await sh('ln', '-s', 'a.txt', `${whole}/lnk`)
    result.symlink_ok = code === 0
    ;[, out] = await sh('readlink', `${whole}/lnk`)
    result.readlink = out
    ;[, out] = await sh('cat', `${whole}/lnk`)
    result.cat_through_link = out
    await sh('rm', `${whole}/lnk`)
    ;[, out] = await sh('cat', `${whole}/a.txt`)
    result.target_survives_link_rm = out
    ;[code] = await sh('sh', '-c', `mkdir ${whole}/d && mv ${whole}/docs/new.txt ${whole}/d/m.txt`)
    result.mkdir_mv_ok = code === 0

    // The wire carries an nfstime3, and an adapter that fills none
    // leaves every file dated 1970 -- which reads as a broken mount to
    // rsync, make, and any incremental copy. BSD stat spells it -f %m
    // and GNU -c %Y.
    //
    // Compared against this process's own clock rather than against a
    // floor: the file was seeded seconds ago, so its mtime is now. A
    // floor ('after 2001') passes on 1970's two failure modes as well
    // as its own -- nfstime3.seconds is a u32, so an adapter sending
    // nanoseconds saturates it and dates every file 2106-02-07, which
    // cleared a floor for months.
    let stamp: string
    ;[code, stamp] = await sh('stat', '-f', '%m', `${whole}/a.txt`)
    if (code !== 0) [code, stamp] = await sh('stat', '-c', '%Y', `${whole}/a.txt`)
    result.mtime_matches_clock = Math.abs(Number(stamp) - Date.now() / 1000) < 3600

    try {
      await track(manager, ws, '/dev', whole)
      result.collision_rejected = false
    } catch {
      result.collision_rejected = true
    }
  } finally {
    await manager.close()
  }

  // close() unmounts, then flushes what the client's final WRITEs left
  // buffered, then stops the server -- so the bytes are in the workspace
  // only if that order held.
  const io = await ws.execute('cat /d/m.txt')
  result.close_flushed = DEC.decode((io as { stdout: Uint8Array }).stdout).trim()
  result.mountpoints_cleaned = gone(whole) && gone(docs)
}

/**
 * Size-unknown files read as empty, and the mount says so.
 *
 * NFSv3 has no OPEN procedure, so there is no hydrate-on-open the way
 * FUSE has: the client stops reading at the size GETATTR reported. The
 * resource declares the limitation (which is what the warning reads)
 * and the stat wrapper stands in for one that cannot size a file
 * without fetching it.
 */
async function runSizeless(result: Result): Promise<void> {
  class SizelessRAM extends RAMResource {
    override readonly sizesAlwaysKnown: boolean = false
  }
  const ws = new Workspace({ '/': new SizelessRAM() }, { mode: MountMode.WRITE })
  await ws.execute('echo hidden-content > /api.json')
  const realStat = ws.fs.stat.bind(ws.fs)
  ws.fs.stat = async (path: string) => {
    const row = await realStat(path)
    if (row.type === FileType.DIRECTORY) return row
    return new FileStat({ name: row.name, type: row.type, size: null })
  }

  const warnings: string[] = []
  const realWarn = console.warn.bind(console)
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(' '))
  }

  const manager = new NFSManager()
  try {
    const mnt = await track(manager, ws, '/')
    const [, empty] = await sh('cat', `${mnt}/api.json`)
    result.sizeless_reads_empty = empty === ''
    let [code, size] = await sh('stat', '-f', '%z', `${mnt}/api.json`)
    if (code !== 0) [code, size] = await sh('stat', '-c', '%s', `${mnt}/api.json`)
    result.sizeless_stat_zero = size === '0'
  } finally {
    await manager.close()
    console.warn = realWarn
  }
  result.sizeless_warned = warnings.some((line) => line.includes('read as empty'))
}

/**
 * Multi-chunk md5 round-trip through a kernel mount.
 *
 * A 1 MiB copy arrives as dozens of WRITEs, and the macOS client has
 * been observed issuing them out of order and overlapping -- the
 * behavior that silently corrupts nfsserve's own demo example. The
 * read-back happens BEFORE any flush, so it exercises the overlay path
 * over the full chunk set; the workspace check after close proves the
 * merged flush stored the same bytes.
 */
async function runBigfile(result: Result): Promise<void> {
  const payload = Buffer.concat(
    Array.from({ length: 4096 }, () => Buffer.from(Array.from({ length: 256 }, (_, i) => i))),
  )
  const want = createHash('md5').update(payload).digest('hex')
  const hostDir = mkdtempSync(join(tmpdir(), 'mirage-nfs-big-'))
  const src = join(hostDir, 'src.bin')
  const back = join(hostDir, 'back.bin')
  writeFileSync(src, payload)

  const ws = new Workspace({ '/': new RAMResource() }, { mode: MountMode.WRITE })
  const manager = new NFSManager()
  try {
    const mnt = await track(manager, ws, '/')
    const [inCode] = await sh('cp', src, `${mnt}/big.bin`)
    result.bigfile_cp_in = inCode === 0
    const [outCode] = await sh('cp', `${mnt}/big.bin`, back)
    result.bigfile_cp_out = outCode === 0
    result.bigfile_md5_pre_flush =
      createHash('md5').update(readFileSync(back)).digest('hex') === want
  } finally {
    await manager.close()
    // Host-side scratch, not a mountpoint: nothing unmounts it, so the
    // run that made it is the run that removes it.
    rmSync(hostDir, { recursive: true, force: true })
  }
  // Verified at the ops tier, not through the executor: `cat` is the
  // agent surface and its output is capped by the post gate (a 1 MiB
  // file comes back truncated by design), while readFile(raw) answers
  // the stored bytes themselves.
  const stored = await ws.fs.readFile('/big.bin', { raw: true })
  result.bigfile_md5_persisted =
    createHash('md5').update(Buffer.from(stored)).digest('hex') === want
}

/**
 * A Mount declaring backend=nfs is served by the workspace itself.
 *
 * The declaration is kicked off by the constructor and awaited by the
 * first `execute`, so this also pins that an nfs mount never shows up in
 * the fuse view.
 */
async function runWorkspaceBackend(result: Result): Promise<void> {
  const ws = new Workspace(
    { '/data': new Mount(new RAMResource(), { backend: MountBackend.NFS }) },
    { mode: MountMode.WRITE },
  )
  let point = ''
  try {
    await ws.execute('echo declared > /data/w.txt')
    await ws.execute('mkdir -p /data/docs && echo nested > /data/docs/n.txt')
    await ws.nfsReady()
    point = ws.nfsMountpoints['/data'] ?? ''
    MOUNTPOINTS.add(point)
    let out: string
    ;[, out] = await sh('cat', `${point}/w.txt`)
    result.workspace_backend_cat = out
    result.workspace_backend_not_fuse = Object.keys(ws.fuseMountpoints).length === 0

    const docs = await ws.addNfsMount('/data/docs')
    MOUNTPOINTS.add(docs)
    result.workspace_backend_distinct = docs !== point
    ;[, out] = await sh('cat', `${docs}/n.txt`)
    result.workspace_backend_second = out
  } finally {
    await ws.close()
  }
  result.workspace_backend_cleaned = Object.keys(ws.nfsMountpoints).length === 0 && gone(point)
}

/**
 * A scoped mount serves its session's grants, not the workspace's.
 *
 * The narrowing has to survive the whole round trip -- kernel client,
 * server, adapter, op door -- so it is asserted through a real mount
 * rather than at the adapter, where a passing test would only prove the
 * wrapper was called.
 */
async function runSessionScope(result: Result): Promise<void> {
  const ws = new Workspace({ '/data': new RAMResource() }, { mode: MountMode.WRITE })
  await ws.execute('echo seed > /data/a.txt')
  ws.createSession('agent', { mounts: { '/data': 'read' } })
  let openPoint = ''
  try {
    openPoint = await ws.addNfsMount('/data', undefined, EPHEMERAL)
    MOUNTPOINTS.add(openPoint)
    const scoped = await ws.addNfsMount('/data', undefined, EPHEMERAL, 'agent')
    MOUNTPOINTS.add(scoped)
    result.session_distinct_mounts = scoped !== openPoint

    const [, out] = await sh('cat', `${scoped}/a.txt`)
    result.session_read = out
    let code: number
    ;[code] = await sh('sh', '-c', `echo blocked > ${scoped}/new.txt 2>/dev/null`)
    result.session_write_refused = code !== 0
    ;[code] = await sh('sh', '-c', `echo allowed > ${openPoint}/ok.txt`)
    result.unscoped_write_ok = code === 0
  } finally {
    await ws.close()
  }
  result.session_cleaned = Object.keys(ws.nfsMountpoints).length === 0
}

/** Every scenario, in order. */
async function runAll(result: Result): Promise<void> {
  try {
    checkPlatformNfs('win32')
    result.win32_refused = false
  } catch {
    result.win32_refused = true
  }

  await runBattery(result)
  await runWorkspaceBackend(result)
  await runSessionScope(result)
  await runSizeless(result)
  await runBigfile(result)
}

/**
 * Run the battery under a deadline, and never leave a mount behind.
 *
 * A hung scenario has to end as a failed run rather than as a live mount
 * with no server, so the whole battery is bounded and the teardown runs
 * whatever the outcome.
 */
async function main(): Promise<void> {
  const result: Result = {}
  let deadline: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      runAll(result),
      new Promise<never>((_keep, fail) => {
        deadline = setTimeout(() => {
          fail(new Error(`nfs battery outlived ${String(BATTERY_TIMEOUT_SECONDS)}s`))
        }, BATTERY_TIMEOUT_SECONDS * 1000)
      }),
    ])
  } finally {
    clearTimeout(deadline)
    forceUnmountAll()
  }
  // The exit is for stdout, not for the server: node's stdout is
  // asynchronous when it is a pipe, which is how CI runs this
  // (`... | check_json.py`), and a pending write is dropped by
  // process.exit() -- so the write is awaited first. The server itself
  // releases the event loop on close() and needs no help.
  await new Promise<void>((flushed) => {
    process.stdout.write(JSON.stringify(result) + '\n', () => {
      flushed()
    })
  })
  process.exit(0)
}

// Sync handlers (see forceUnmountAll), installed before anything mounts,
// so an interrupt at any point in the run still clears the mounts.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    forceUnmountAll()
    process.exit(signal === 'SIGINT' ? 130 : 143)
  })
}

main().catch((err: unknown) => {
  process.stderr.write(String(err) + '\n')
  forceUnmountAll()
  process.exit(1)
})
