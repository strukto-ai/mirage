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

import { toIsoZ } from '../../utils/dates.ts'
import type { S3Accessor } from '../../accessor/s3.ts'
import type { S3Config } from '../../vfs/s3/config.ts'
import { VFSName } from '../../types.ts'
import { eacces } from '../../errors/fs.ts'
import { rstripSlash } from '../../utils/slash.ts'
import type { KnownVersions, WriteCondition } from '../../cache/context.ts'
import {
  type ChildEntry,
  type ObjectMeta,
  type ObjectStoreConnection,
  type ObjectStoreDriver,
  type TreeEntry,
  ConditionLost,
} from '../object_store/driver.ts'
import {
  CONDITION_LOST_CODES,
  createS3Client,
  isConditionLost,
  isNotFoundError,
  loadS3Module,
  streamToBuffer,
  type S3Module,
} from './client.ts'
import { SCOPE_ERROR } from './constants.ts'

const DELETE_BATCH = 1000

type Send = (cmd: unknown) => Promise<Record<string, unknown>>

/** One open S3 client plus the module and config that shaped it. */
export interface S3Conn {
  send: Send
  mod: S3Module
  config: S3Config
}

interface Listing {
  CommonPrefixes?: { Prefix?: string }[]
  Contents?: { Key?: string; Size?: number; LastModified?: Date | string; ETag?: string }[]
  IsTruncated?: boolean
  NextContinuationToken?: string
}

function isoOf(modified: Date | string | undefined): string {
  if (modified instanceof Date) return toIsoZ(modified)
  return typeof modified === 'string' ? modified : ''
}

async function* listPages(conn: S3Conn, input: Record<string, unknown>): AsyncIterable<Listing> {
  let continuationToken: string | undefined
  do {
    const page: Record<string, unknown> = { ...input }
    if (continuationToken !== undefined) page.ContinuationToken = continuationToken
    const resp = (await conn.send(new conn.mod.ListObjectsV2Command(page))) as Listing
    yield resp
    continuationToken = resp.IsTruncated === true ? resp.NextContinuationToken : undefined
  } while (continuationToken !== undefined)
}

function keyPrefixOf(accessor: S3Accessor): string {
  return accessor.config.keyPrefix ?? ''
}

async function connect(accessor: S3Accessor): Promise<ObjectStoreConnection<S3Conn>> {
  const { config } = accessor
  const mod = await loadS3Module(config)
  const client = await createS3Client(config)
  const send = (client as unknown as { send: Send }).send.bind(client)
  return {
    conn: { send, mod, config },
    close: () => {
      ;(client as unknown as { destroy?: () => void }).destroy?.()
      return Promise.resolve()
    },
  }
}

async function* listChildren(conn: S3Conn, pfx: string): AsyncIterable<ChildEntry> {
  const input = { Bucket: conn.config.bucket, Prefix: pfx, Delimiter: '/' }
  for await (const page of listPages(conn, input)) {
    for (const cp of page.CommonPrefixes ?? []) {
      const p = cp.Prefix
      if (p === undefined) continue
      const child = rstripSlash(p)
      if (child !== '') yield { key: child, kind: 'd' }
      else yield { key: p, kind: 'marker' }
    }
    for (const obj of page.Contents ?? []) {
      const key = obj.Key
      if (key === undefined) continue
      const relative = key.slice(pfx.length)
      if (relative !== '' && !relative.includes('/')) {
        yield { key, kind: 'f', size: obj.Size ?? null, modified: isoOf(obj.LastModified) }
      } else {
        yield { key, kind: 'marker' }
      }
    }
  }
}

async function* listTree(conn: S3Conn, pfx: string): AsyncIterable<TreeEntry> {
  for await (const page of listPages(conn, { Bucket: conn.config.bucket, Prefix: pfx })) {
    for (const obj of page.Contents ?? []) {
      if (obj.Key === undefined) continue
      yield { key: obj.Key, size: obj.Size ?? 0, modified: isoOf(obj.LastModified) }
    }
  }
}

async function* listSubtree(conn: S3Conn, stem: string): AsyncIterable<TreeEntry> {
  // The prefix listing also matches sibling keys sharing the stem as a
  // name prefix ("data-old" under stem "data"), so each key is checked
  // against the exact stem or the slashed subtree.
  const base = stem !== '' ? `${stem}/` : ''
  for await (const page of listPages(conn, { Bucket: conn.config.bucket, Prefix: stem })) {
    for (const obj of page.Contents ?? []) {
      const okey = obj.Key
      if (okey === undefined) continue
      if (!(okey === stem || okey.startsWith(base))) continue
      yield { key: okey, size: obj.Size ?? 0, modified: isoOf(obj.LastModified) }
    }
  }
}

// Quote-stripped ETag from a head or put response, '' when absent.
// Returned as a possibly-empty string rather than `string | null`
// because `head` needs both spellings: `fingerprint` drops an empty one
// while `extra` omits the key entirely.
function etagOf(resp: { ETag?: string }): string {
  return resp.ETag?.replace(/^"|"$/g, '') ?? ''
}

// VersionId from a head or put response, null when unversioned.
function versionOf(resp: { VersionId?: string }): string | null {
  const revision = resp.VersionId ?? null
  return revision === 'null' ? null : revision
}

async function head(conn: S3Conn, key: string): Promise<ObjectMeta | null> {
  let resp: { ContentLength?: number; LastModified?: Date; ETag?: string; VersionId?: string }
  try {
    resp = (await conn.send(
      new conn.mod.HeadObjectCommand({ Bucket: conn.config.bucket, Key: key }),
    )) as typeof resp
  } catch (err) {
    if (isNotFoundError(err)) return null
    throw err
  }
  const etag = etagOf(resp)
  return {
    size: resp.ContentLength ?? null,
    modified: resp.LastModified === undefined ? null : toIsoZ(resp.LastModified),
    fingerprint: etag !== '' ? etag : null,
    revision: versionOf(resp),
    extra: etag !== '' ? { etag } : {},
  }
}

async function get(conn: S3Conn, key: string): Promise<Uint8Array | null> {
  return (await getVersioned(conn, key))?.[0] ?? null
}

function put(conn: S3Conn, key: string, data: Uint8Array): Promise<ObjectMeta | null> {
  return putIf(conn, key, data, {})
}

// Tokens are stored unquoted (`etagOf`); the wire takes the quoted form.
function quoted(token: string): string {
  return token.startsWith('"') ? token : `"${token}"`
}

function condition(cond: WriteCondition): Record<string, string> {
  if (cond.ifMatch !== undefined) return { IfMatch: quoted(cond.ifMatch) }
  return {}
}

function isMissingBucket(err: unknown): boolean {
  const e = err as { name?: string; Code?: string }
  return e.name === 'NoSuchBucket' || e.Code === 'NoSuchBucket'
}

/**
 * Whether a conditioned request lost its condition: a version sent with
 * `If-Match` loses on a 412, and on a 404 for its key (not a missing bucket),
 * since AWS answers that way for a key deleted since it was read. Mirrors
 * python's `_lost_condition`.
 */
function lostCondition(err: unknown, matched: boolean): boolean {
  return isConditionLost(err) || (matched && isNotFoundError(err) && !isMissingBucket(err))
}

async function guarded<T>(key: string, call: Promise<T>, matched = false): Promise<T> {
  try {
    return await call
  } catch (err) {
    if (lostCondition(err, matched)) throw new ConditionLost([key], false, !isConditionLost(err))
    throw err
  }
}

async function putIf(
  conn: S3Conn,
  key: string,
  data: Uint8Array,
  cond: WriteCondition,
): Promise<ObjectMeta | null> {
  // The ETag is read through the same helper `head` uses, so the token a
  // write stamps and the token a later stat reports are one spelling.
  // A write carries no type of its own, so the mount's default is the one the
  // store keeps and serves back.
  const contentType = conn.config.defaultContentType
  const resp = (await guarded(
    key,
    conn.send(
      new conn.mod.PutObjectCommand({
        Bucket: conn.config.bucket,
        Key: key,
        Body: data,
        ...(contentType !== undefined && contentType !== '' ? { ContentType: contentType } : {}),
        ...condition(cond),
      }),
    ),
    cond.ifMatch !== undefined,
  )) as { ETag?: string; VersionId?: string }
  const etag = etagOf(resp)
  return {
    size: data.byteLength,
    fingerprint: etag !== '' ? etag : null,
    revision: versionOf(resp),
  }
}

async function getVersioned(
  conn: S3Conn,
  key: string,
): Promise<[Uint8Array, string | null] | null> {
  let resp: { Body?: unknown; ETag?: string }
  try {
    resp = (await conn.send(
      new conn.mod.GetObjectCommand({ Bucket: conn.config.bucket, Key: key }),
    )) as typeof resp
  } catch (err) {
    if (isNotFoundError(err)) return null
    throw err
  }
  const etag = etagOf(resp)
  return [await streamToBuffer(resp.Body), etag !== '' ? etag : null]
}

async function copyIf(
  conn: S3Conn,
  srcKey: string,
  dstKey: string,
  cond: WriteCondition,
): Promise<boolean> {
  try {
    await conn.send(
      new conn.mod.CopyObjectCommand({
        Bucket: conn.config.bucket,
        CopySource: `${conn.config.bucket}/${srcKey}`,
        Key: dstKey,
        ...condition(cond),
      }),
    )
  } catch (err) {
    // A 404 is lost only while the source is still there.
    let lost = isConditionLost(err)
    if (!lost && cond.ifMatch !== undefined && isNotFoundError(err) && !isMissingBucket(err)) {
      try {
        lost = (await head(conn, srcKey)) !== null
      } catch (probeErr) {
        console.debug(`source probe failed for ${srcKey}: ${String(probeErr)}`)
      }
    }
    if (lost) throw new ConditionLost([dstKey], false, !isConditionLost(err))
    throw err
  }
  return true
}

async function deleteIf(conn: S3Conn, key: string, cond: WriteCondition): Promise<void> {
  await guarded(
    key,
    conn.send(
      new conn.mod.DeleteObjectCommand({
        Bucket: conn.config.bucket,
        Key: key,
        ...condition(cond),
      }),
    ),
  )
}

/**
 * Which end of a refused copy changed: S3 answers 412 for either condition,
 * so the destination is looked up, and one no longer at the version sent is
 * the end that lost; otherwise the source's pin did. Only a refusal pays for
 * the lookup. Mirrors python's `_copy_loser`.
 */
async function copyLoser(
  conn: S3Conn,
  srcKey: string,
  dstKey: string,
  cond: WriteCondition,
): Promise<ConditionLost> {
  try {
    if (cond.ifMatch !== undefined) {
      const meta = await head(conn, dstKey)
      if (meta === null || quoted(meta.fingerprint ?? '') !== quoted(cond.ifMatch)) {
        return new ConditionLost([dstKey], false, meta === null)
      }
    }
    return new ConditionLost([srcKey], false, (await head(conn, srcKey)) === null)
  } catch (err) {
    // Unknown which end changed: the source is named, and both keep their versions.
    console.debug(`copy loser lookup failed for ${dstKey}: ${String(err)}`)
    return new ConditionLost([srcKey])
  }
}

async function moveFileIf(
  conn: S3Conn,
  srcKey: string,
  dstKey: string,
  cond: WriteCondition,
  source: string | null,
): Promise<boolean> {
  // Pin the source to the agent's version, else to this lookup's.
  let pinned = source
  if (pinned === null) {
    const meta = await head(conn, srcKey)
    if (meta === null) return false
    pinned = meta.fingerprint ?? ''
  }
  const match = quoted(pinned)
  try {
    await conn.send(
      new conn.mod.CopyObjectCommand({
        Bucket: conn.config.bucket,
        CopySource: `${conn.config.bucket}/${srcKey}`,
        Key: dstKey,
        CopySourceIfMatch: match,
        ...condition(cond),
      }),
    )
  } catch (err) {
    if (!lostCondition(err, true)) throw err
    throw await copyLoser(conn, srcKey, dstKey, cond)
  }
  try {
    await guarded(
      srcKey,
      conn.send(
        new conn.mod.DeleteObjectCommand({
          Bucket: conn.config.bucket,
          Key: srcKey,
          IfMatch: match,
        }),
      ),
      true,
    )
  } catch (err) {
    if (err instanceof ConditionLost) throw new ConditionLost(err.keys, true, err.gone)
    throw err
  }
  return true
}

/**
 * Each listing page under `pfx`, every key with the version it is measured
 * against: the version the agent read where there is one, else the
 * listing's, one page at a time.
 * Mirrors python's `_known_pages`.
 */
async function* knownPages(
  conn: S3Conn,
  pfx: string,
  known: KnownVersions,
): AsyncIterable<[string, string][]> {
  for await (const page of listPages(conn, { Bucket: conn.config.bucket, Prefix: pfx })) {
    const listed: [string, string][] = []
    for (const obj of page.Contents ?? []) {
      if (obj.Key !== undefined) listed.push([obj.Key, quoted(obj.ETag ?? '')])
    }
    if (listed.length === 0) continue
    const versions = await known(listed.map(([key]) => key))
    yield listed.map(([key, token]) => {
      const version = versions.get(key)
      return [key, version !== undefined ? quoted(version) : token]
    })
  }
}

/** The error for keys a DeleteObjects refused in the body of its 200. */
function refused(failed: readonly string[]): Error {
  return eacces(
    `/${failed[0] ?? ''}`,
    `S3 refused to delete ${String(failed.length)} object(s), starting at '${failed[0] ?? ''}'`,
  )
}

/**
 * Delete each listed key only while it is the version listed, returning the
 * keys a newer write changed (kept) and the keys the store refused for
 * another reason. A refusal comes back per key in the body of a 200.
 */
async function deleteBatch(
  conn: S3Conn,
  keys: readonly [string, string][],
): Promise<[[string, string][], string[]]> {
  const lost: [string, string][] = []
  const failed: string[] = []
  for (let start = 0; start < keys.length; start += DELETE_BATCH) {
    const batch = keys.slice(start, start + DELETE_BATCH)
    const sent = new Map(batch)
    const resp = (await conn.send(
      new conn.mod.DeleteObjectsCommand({
        Bucket: conn.config.bucket,
        Delete: { Objects: batch.map(([Key, ETag]) => ({ Key, ETag })) },
      }),
    )) as { Errors?: { Key?: string; Code?: string }[] }
    for (const err of resp.Errors ?? []) {
      const key = err.Key ?? ''
      if (CONDITION_LOST_CODES.has(err.Code ?? '')) lost.push([key, sent.get(key) ?? ''])
      else failed.push(key)
    }
  }
  return [lost, failed]
}

/**
 * Raise for the keys a prefix op kept: lost keys first, so the caller drops
 * their cached copies and keeps the versions they were measured on, then
 * keys the store refused. Mirrors Python's `_raise_kept`.
 */
function raiseKept(lost: readonly [string, string][], failed: readonly string[]): void {
  if (lost.length > 0) {
    throw new ConditionLost(
      lost.map(([key]) => key),
      false,
      false,
      new Map(lost),
    )
  }
  if (failed.length > 0) throw refused(failed)
}

async function deletePrefixIf(conn: S3Conn, pfx: string, known: KnownVersions): Promise<void> {
  const lost: [string, string][] = []
  const failed: string[] = []
  for await (const listed of knownPages(conn, pfx, known)) {
    const [pageLost, pageFailed] = await deleteBatch(conn, listed)
    lost.push(...pageLost)
    failed.push(...pageFailed)
  }
  raiseKept(lost, failed)
}

async function movePrefixIf(
  conn: S3Conn,
  srcPfx: string,
  dstPfx: string,
  known: KnownVersions,
): Promise<boolean> {
  let found = false
  const lost: [string, string][] = []
  const moved: [string, string][] = []
  for await (const listed of knownPages(conn, srcPfx, known)) {
    found = true
    for (const [key, token] of listed) {
      try {
        await conn.send(
          new conn.mod.CopyObjectCommand({
            Bucket: conn.config.bucket,
            CopySource: `${conn.config.bucket}/${key}`,
            Key: `${dstPfx}${key.slice(srcPfx.length)}`,
            CopySourceIfMatch: token,
          }),
        )
      } catch (err) {
        if (!lostCondition(err, true)) throw err
        // A source gone (404) keeps no version: nothing newer to guard.
        lost.push([key, isConditionLost(err) ? token : ''])
        continue
      }
      moved.push([key, token])
    }
  }
  const [deleteLost, failed] = await deleteBatch(conn, moved)
  raiseKept([...lost, ...deleteLost], failed)
  return found
}

async function deleteFile(conn: S3Conn, key: string): Promise<void> {
  await conn.send(new conn.mod.DeleteObjectCommand({ Bucket: conn.config.bucket, Key: key }))
}

async function deletePrefix(conn: S3Conn, pfx: string): Promise<void> {
  for await (const page of listPages(conn, { Bucket: conn.config.bucket, Prefix: pfx })) {
    const keys = (page.Contents ?? [])
      .map((obj) => obj.Key)
      .filter((k): k is string => k !== undefined)
      .map((k) => ({ Key: k }))
    if (keys.length > 0) {
      const resp = (await conn.send(
        new conn.mod.DeleteObjectsCommand({
          Bucket: conn.config.bucket,
          Delete: { Objects: keys },
        }),
      )) as { Errors?: { Key?: string }[] }
      // A refused key comes back in the body of a 200.
      const failed = (resp.Errors ?? []).map((e) => e.Key ?? '')
      if (failed.length > 0) throw refused(failed)
    }
  }
}

async function copyFile(conn: S3Conn, srcKey: string, dstKey: string): Promise<boolean> {
  await conn.send(
    new conn.mod.CopyObjectCommand({
      Bucket: conn.config.bucket,
      CopySource: `${conn.config.bucket}/${srcKey}`,
      Key: dstKey,
    }),
  )
  return true
}

async function moveFile(conn: S3Conn, srcKey: string, dstKey: string): Promise<boolean> {
  // The source is classified before anything is copied rather than by
  // letting CopyObject fail: stores disagree about a missing source (S3
  // and MinIO even spell the code differently, and a lenient
  // S3-compatible store accepts the copy and writes nothing), and on that
  // last one an error-driven fallback would delete a source whose copy
  // never landed. Only a classified not-found answers false; every other
  // failure propagates rather than reading as a directory.
  try {
    await conn.send(new conn.mod.HeadObjectCommand({ Bucket: conn.config.bucket, Key: srcKey }))
  } catch (err) {
    if (!isNotFoundError(err)) throw err
    return false
  }
  await copyFile(conn, srcKey, dstKey)
  await conn.send(new conn.mod.DeleteObjectCommand({ Bucket: conn.config.bucket, Key: srcKey }))
  return true
}

/**
 * Relocate every key under `srcPfx` to the matching key under `dstPfx`.
 *
 * A directory is a key prefix plus the empty marker object mkdir writes,
 * and listing on the prefix returns both, so one walk moves the marker
 * and the whole subtree together. Returns whether any key was found
 * under the source prefix.
 */
async function movePrefix(conn: S3Conn, srcPfx: string, dstPfx: string): Promise<boolean> {
  const { bucket } = conn.config
  const moved: { Key: string }[] = []
  for await (const page of listPages(conn, { Bucket: bucket, Prefix: srcPfx })) {
    for (const obj of page.Contents ?? []) {
      if (obj.Key === undefined) continue
      await conn.send(
        new conn.mod.CopyObjectCommand({
          Bucket: bucket,
          CopySource: `${bucket}/${obj.Key}`,
          Key: `${dstPfx}${obj.Key.slice(srcPfx.length)}`,
        }),
      )
      moved.push({ Key: obj.Key })
    }
  }
  if (moved.length === 0) return false
  // Deleted only after every copy landed: a partial move that dropped the
  // source would lose the entries that had not been copied yet.
  const failed: string[] = []
  for (let start = 0; start < moved.length; start += DELETE_BATCH) {
    const resp = (await conn.send(
      new conn.mod.DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: moved.slice(start, start + DELETE_BATCH) },
      }),
    )) as { Errors?: { Key?: string }[] }
    // DeleteObjects reports a refused key in the body of a 200, so a
    // response that throws nothing can still have deleted nothing.
    // Ignoring it would leave the source tree in place beside the copy
    // and call the move a success.
    for (const err of resp.Errors ?? []) failed.push(err.Key ?? '')
  }
  if (failed.length > 0) {
    // Both trees survive, which is what GNU mv leaves behind when the
    // unlink half fails after the copy half succeeded. EACCES because a
    // refused delete is a lock or a policy in practice, and because it is
    // an fs error: mv reports the operand and keeps going instead of
    // aborting the whole command line.
    throw eacces(
      `/${srcPfx}`,
      `S3 refused to delete ${String(failed.length)} source object(s) after ` +
        `copying, starting at '${failed[0] ?? ''}'`,
    )
  }
  return true
}

async function probePrefix(conn: S3Conn, pfx: string): Promise<boolean> {
  const resp = (await conn.send(
    new conn.mod.ListObjectsV2Command({
      Bucket: conn.config.bucket,
      Prefix: pfx,
      Delimiter: '/',
      MaxKeys: 1,
    }),
  )) as { CommonPrefixes?: unknown[]; Contents?: unknown[] }
  return (resp.CommonPrefixes ?? []).length > 0 || (resp.Contents ?? []).length > 0
}

export const DRIVER: ObjectStoreDriver<S3Accessor, S3Conn> = {
  vfs: VFSName.S3,
  scopeError: SCOPE_ERROR,
  keyPrefixOf,
  connect,
  listChildren,
  listTree,
  listSubtree,
  head,
  get,
  put,
  deleteFile,
  deletePrefix,
  moveFile,
  movePrefix,
  copyFile,
  probePrefix,
  putIf,
  getVersioned,
  copyIf,
  deleteIf,
  moveFileIf,
  movePrefixIf,
  deletePrefixIf,
  isNotFound: isNotFoundError,
}
