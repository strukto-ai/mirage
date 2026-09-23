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

import { rmSync } from 'node:fs'
import { readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FileStat,
  FileType,
  fuseMount,
  Mount,
  MountBackend,
  MountMode,
  parseSessionProfile,
  RAMVFS,
  Workspace,
  type Action,
  type OpsContext,
  type OpsResultContext,
  type Policy,
} from '@struktoai/mirage-node'

// Size-unknown probe: a stat wrapper simulates API-backed mounts (Linear,
// Slack, Trello, ...) whose byte size is unknown until the content is
// fetched. Over FUSE such files must stat as 0 until first open and read
// fully afterwards (see the CLAUDE.md FUSE section).
const API_CONTENT = '{"messages": 2}\n'

async function runSizelessProbe(
  result: Record<string, string | number | boolean | null>,
): Promise<void> {
  const enc = new TextEncoder()
  const api = new RAMVFS()
  api.store.dirs.add('/')
  api.store.files.set('/api.json', enc.encode(API_CONTENT))
  const ws = new Workspace({
    '/api': new Mount(api, { mode: MountMode.READ }),
  })
  const realStat = ws.vfs.stat.bind(ws.vfs)
  ws.vfs.stat = async (path) => {
    const s = await realStat(path)
    if (s.type === FileType.DIRECTORY) return s
    return new FileStat({ name: s.name, type: s.type, size: null })
  }
  const handle = await fuseMount(ws)
  const apiFile = join(handle.mountpoint, 'api', 'api.json')
  try {
    // Windows cannot query attributes without opening a handle, so
    // hydrate-on-open runs and even the pre-open stat sees the real size.
    const pre = (await stat(apiFile)).size
    const expectedPre = process.platform === 'win32' ? API_CONTENT.length : 0
    result.api_stat_preopen_ok = pre === expectedPre
    result.api_cat = (await readFile(apiFile, 'utf8')).trim()
    result.api_size_postread = (await stat(apiFile)).size
  } finally {
    await handle.unmount()
  }
}

// Policy probe: FUSE serves the workspace's op door, so a preOps deny
// (sealed path) and a postOps deny (redacted content) must both surface as
// EACCES to ordinary file APIs, while unguarded reads pass.
class SealReadsPolicy implements Policy {
  preOps(ctx: OpsContext): Action | null {
    if (!ctx.write && ctx.path.virtual.endsWith('.sealed')) {
      return { kind: 'deny', reason: 'sealed' }
    }
    return null
  }
}

class RedactReadsPolicy implements Policy {
  postOps(ctx: OpsResultContext): Action | null {
    const data = ctx.result instanceof Uint8Array ? new TextDecoder().decode(ctx.result) : null
    if (ctx.op === 'read' && data !== null && data.includes('TOPSECRET')) {
      return { kind: 'deny', reason: 'redacted' }
    }
    return null
  }
}

async function runPolicyProbe(
  result: Record<string, string | number | boolean | null>,
): Promise<void> {
  const enc = new TextEncoder()
  const res = new RAMVFS()
  res.store.dirs.add('/')
  res.store.files.set('/clean.txt', enc.encode('hello\n'))
  res.store.files.set('/secret.txt', enc.encode('TOPSECRET plans\n'))
  res.store.files.set('/x.sealed', enc.encode('nope\n'))
  const ws = new Workspace(
    { '/guarded': new Mount(res, { mode: MountMode.READ, backend: MountBackend.FUSE }) },
    { policies: [new SealReadsPolicy(), new RedactReadsPolicy()] },
  )
  try {
    await ws.fuseReady()
    const mp = ws.fuseMountpoints['/guarded']
    result.policy_clean_read = (await readFile(`${mp}/clean.txt`, 'utf8')).trim()
    try {
      await readFile(`${mp}/x.sealed`)
      result.policy_sealed_eacces = false
    } catch (err) {
      result.policy_sealed_eacces = (err as { code?: string }).code === 'EACCES'
    }
    try {
      await readFile(`${mp}/secret.txt`)
      result.policy_redact_eacces = false
    } catch (err) {
      result.policy_redact_eacces = (err as { code?: string }).code === 'EACCES'
    }
  } finally {
    await ws.close()
  }
}

// Link-removal probe: FUSE used to drop a link straight into the namespace
// table, at a layer no policy or session view covers, so a preOps deny never
// fired on one and the removal left no OpRecord. Routing the removal through
// the op door is exactly what makes the two answers below differ, and unlink
// is a LINK_ENTRY_OPS member so the door answers a link path itself.
class PinLinksPolicy implements Policy {
  preOps(ctx: OpsContext): Action | null {
    if (ctx.op === 'unlink' && ctx.path.virtual.endsWith('.pinned')) {
      return { kind: 'deny', reason: 'pinned' }
    }
    return null
  }
}

async function runLinkProbe(
  result: Record<string, string | number | boolean | null>,
): Promise<void> {
  const enc = new TextEncoder()
  const res = new RAMVFS()
  res.store.dirs.add('/')
  res.store.files.set('/f.txt', enc.encode('body\n'))
  const ws = new Workspace(
    { '/data': new Mount(res, { mode: MountMode.WRITE }) },
    { policies: [new PinLinksPolicy()] },
  )
  // Seeded before the mount goes live: creating a link through the mountpoint
  // would depend on libfuse's symlink argument order, which is the adapter's
  // business, not this probe's.
  await ws.shell('ln -s f.txt /data/lk.pinned')
  await ws.shell('ln -s f.txt /data/lk.plain')
  const handle = await fuseMount(ws)
  const mp = handle.mountpoint
  try {
    // A denied removal must FAIL and leave the link where it was. Keyed
    // on the refusal, not on an errno, because Windows cannot report
    // one: DeleteFile only sets FileDispositionInformation, so the deny
    // lands when the handle closes and unlink resolves on a removal that
    // never happened. The strict EACCES is therefore required only where
    // it is observable, and the surviving link is the proof everywhere.
    let raised: string | null = null
    try {
      await unlink(`${mp}/data/lk.pinned`)
    } catch (err) {
      raised = (err as { code?: string }).code === 'EACCES' ? 'eacces' : 'other'
    }
    const survives = ws.namespace.isLink('/data/lk.pinned')
    result.link_policy_unlink_refused =
      survives && (raised === 'eacces' || process.platform === 'win32')
    result.link_policy_survives = survives
    // An unguarded link still goes, and only the link: unlink(2) on a symlink
    // leaves the pointee alone.
    await unlink(`${mp}/data/lk.plain`)
    result.link_plain_unlink_ok = !ws.namespace.isLink('/data/lk.plain')
    result.link_target_survives = (await readFile(`${mp}/data/f.txt`, 'utf8')).trim()
  } finally {
    await handle.unmount()
    await ws.close()
  }
}

// Per-mount FUSE: two mounts exposed at distinct OS paths simultaneously. Reads
// go through the real kernel -> FUSE handler. Async fs APIs are required: the
// mounts' napi callbacks run on the single Node event loop, so a *sync* read
// would block the loop that has to service the callback and deadlock.
async function absent(attempt: () => Promise<unknown>): Promise<boolean> {
  try {
    await attempt()
    return false
  } catch (err) {
    return (err as { code?: string }).code === 'ENOENT'
  }
}

// A session-bound kernel mount answers as its shell does. The
// session's profile hides /data/vault and caps /data at read. Through
// the kernel the hidden directory is absent: a read under it and a
// create under it both answer ENOENT and the listing omits it; the cap
// refuses a write and leaves the file as it was. The shell door run as
// the same session gives every answer the same way, and the host's own
// door still reads the hidden file, so the hide is the session's and
// not the mount's.
async function runSessionProbe(
  result: Record<string, string | number | boolean | null>,
): Promise<void> {
  const enc = new TextEncoder()
  const dec = new TextDecoder()
  const res = new RAMVFS()
  res.store.dirs.add('/')
  res.store.dirs.add('/vault')
  res.store.files.set('/pub.txt', enc.encode('pub\n'))
  res.store.files.set('/vault/secret.txt', enc.encode('secret\n'))
  const ws = new Workspace({ '/data': new Mount(res, { mode: MountMode.WRITE }) })
  const session = ws.createSession('agent', {
    profile: parseSessionProfile({
      paths: { hide: ['/data/vault'] },
      mounts: { '/data': 'read' },
    }),
  })
  const hidden = await ws.shell('cat /data/vault/secret.txt', { sessionId: 'agent' })
  result.session_shell_hidden_exit = hidden.exitCode
  const listing = await ws.shell('ls /data', { sessionId: 'agent' })
  result.session_shell_listing = dec.decode(listing.stdout).trim()
  const capped = await ws.shell('echo x > /data/pub.txt', { sessionId: 'agent' })
  result.session_shell_write_refused = capped.exitCode !== 0
  result.session_host_reads_hidden = (await ws.vfs.readFileText('/data/vault/secret.txt')).trim()
  const handle = await fuseMount(ws, { session })
  const data = join(handle.mountpoint, 'data')
  try {
    result.session_kernel_visible_read = (await readFile(`${data}/pub.txt`, 'utf8')).trim()
    result.session_kernel_listing = (await readdir(data)).sort().join(',')
    result.session_kernel_hidden_absent = await absent(() => readFile(`${data}/vault/secret.txt`))
    result.session_kernel_create_under_hidden_absent = await absent(() =>
      writeFile(`${data}/vault/new.txt`, 'x\n'),
    )
    // The cap's refusal is an errno the adapter picks; what is pinned
    // is that the write fails and the body survives.
    let refused = false
    try {
      await writeFile(`${data}/pub.txt`, 'x\n')
    } catch {
      refused = true
    }
    result.session_kernel_write_refused =
      refused && (await readFile(`${data}/pub.txt`, 'utf8')) === 'pub\n'
  } finally {
    await handle.unmount()
    await ws.close()
  }
}

async function main(): Promise<void> {
  const result: Record<string, string | number | boolean | null> = {}
  const enc = new TextEncoder()
  const data = new RAMVFS()
  data.store.dirs.add('/')
  data.store.files.set('/a.txt', enc.encode('alpha\n'))
  const logs = new RAMVFS()
  logs.store.dirs.add('/')
  logs.store.files.set('/b.txt', enc.encode('beta\n'))

  // Non-existent pinned path: the mount must create it (mirrors the CLI flow).
  const pinned = join(tmpdir(), `mirage-fuse-data-${String(process.pid)}`)
  rmSync(pinned, { recursive: true, force: true })
  // Mount through the public per-mount Mount spec (what examples/users write):
  // /data pins its mountpoint and overrides the workspace default to WRITE;
  // /logs gets a generated mountpoint and inherits the default READ.
  const ws = new Workspace({
    '/data': new Mount(data, {
      mode: MountMode.WRITE,
      backend: MountBackend.FUSE,
      mountpoint: pinned,
    }),
    '/logs': new Mount(logs, { backend: MountBackend.FUSE }),
  })
  try {
    await ws.fuseReady()
    const dataMp = ws.fuseMountpoints['/data']
    const logsMp = ws.fuseMountpoints['/logs']

    result.data_cat_a = (await readFile(`${dataMp}/a.txt`, 'utf8')).trim()
    result.logs_cat_b = (await readFile(`${logsMp}/b.txt`, 'utf8')).trim()
    result.logs_size_b = (await stat(`${logsMp}/b.txt`)).size
    // A shorter overwrite must truncate. Under libfuse 3 the kernel hands
    // O_TRUNC to open instead of sending a truncate first, and a mount
    // that ignored the flag kept the old tail (#1032).
    await writeFile(`${dataMp}/t.txt`, 'AAAAAAAAAAAAAAAAAAAA\n')
    await writeFile(`${dataMp}/t.txt`, 'BB\n')
    result.overwrite_short_size = (await stat(`${dataMp}/t.txt`)).size
    result.overwrite_short_body = (await readFile(`${dataMp}/t.txt`, 'utf8')).trim()
    result.data_pinned = dataMp === pinned
    result.distinct_mounts = dataMp !== logsMp

    const [, , dataMode] = await ws.resolve('/data')
    const [, , logsMode] = await ws.resolve('/logs')
    result.data_mode_is_write = dataMode === MountMode.WRITE
    result.logs_mode_is_read = logsMode === MountMode.READ

    let singular = false
    try {
      void ws.fuseMountpoint
    } catch {
      singular = true
    }
    result.singular_raises_multi = singular

    let collision = false
    try {
      await ws.addFuseMount('/collide', pinned)
    } catch {
      collision = true
    }
    result.collision_rejected = collision
  } finally {
    await ws.close()
  }
  await runSizelessProbe(result)
  await runPolicyProbe(result)
  await runLinkProbe(result)
  await runSessionProbe(result)
  process.stdout.write(JSON.stringify(result) + '\n')
}

main().catch((err: unknown) => {
  process.stderr.write(String(err) + '\n')
  process.exit(1)
})
