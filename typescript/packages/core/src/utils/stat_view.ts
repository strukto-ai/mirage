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

import { FileType, type FileStat } from '../types.ts'
import { isoTimestamp } from './dates.ts'

export type PrintfKind = 'f' | 'd' | 'l' | 'c' | 'b' | 'p' | 's'
export const TYPE_CHARS: Partial<Record<FileType, PrintfKind>> = {
  [FileType.DIRECTORY]: 'd',
  [FileType.SYMLINK]: 'l',
  [FileType.CHAR_DEVICE]: 'c',
  [FileType.BLOCK_DEVICE]: 'b',
  [FileType.FIFO]: 'p',
  [FileType.SOCKET]: 's',
}

// The one spelling of "a directory looks like drwxr-xr-x and a file
// like -rw-r--r--" for every stat translator (FUSE attrs, guest
// st_mode); mirrors mirage/utils/stat_view.py.
export const S_IFMT = 0o170000
export const S_IFDIR = 0o040000
export const S_IFCHR = 0o020000
export const S_IFREG = 0o100000
export const S_IFLNK = 0o120000
export const CHAR_MODE = S_IFCHR | 0o666
export const DIR_MODE = S_IFDIR | 0o755
export const FILE_MODE = S_IFREG | 0o644
// S_IFIFO; a pipe is created rw------- (GNU: `stat -L -c %A <(true)`).
export const FIFO_MODE = 0o010000 | 0o600
// A link is always lrwxrwxrwx: the bits on a symlink are not consulted
// by any POSIX system, so this is the one mode every translator reports
// for one (the FUSE attr fold, find's -type l row, a guest's lstat).
export const LINK_MODE = S_IFLNK | 0o777
const BASE_MODES: Record<FileType, number> = {
  [FileType.FILE]: FILE_MODE,
  [FileType.DIRECTORY]: DIR_MODE,
  [FileType.SYMLINK]: LINK_MODE,
  [FileType.CHAR_DEVICE]: CHAR_MODE,
  [FileType.FIFO]: FIFO_MODE,
  [FileType.BLOCK_DEVICE]: 0o060644,
  [FileType.SOCKET]: 0o140644,
}

const MODE_TYPES = new Map(
  Object.values(FileType).map((type) => [BASE_MODES[type] & S_IFMT, type] as const),
)

/** Read the POSIX node kind from an optional mode which may carry only permissions. */
export function modeType(mode: number | undefined): FileType | undefined {
  return mode === undefined ? undefined : MODE_TYPES.get(mode & S_IFMT)
}
// A directory is one ext4 block, the st_size GNU tools show for one,
// whatever aggregate a backend reports; ls, stat, find and FUSE all
// report this, so find -size agrees with what the listing shows.
export const DIR_SIZE = 4096

// The block size every stat translator reports: a backend has none of its
// own, and 4 KiB is what the kernel adapters answer. st_blocks counts in
// BLOCK_UNIT whatever the block size, as POSIX has it.
export const BLKSIZE = 4096
export const BLOCK_UNIT = 512

// The bits chmod sets: permissions plus setuid, setgid and sticky,
// everything but the file type.
export const ALL_MODE_BITS = 0o7777

// The largest id a uid_t or gid_t holds. chown and chgrp refuse it, which
// the kernel reads as "leave it unchanged".
export const ID_MAX = 0xffffffff

// FNV-1a, 64-bit: the same arithmetic on both hosts and in every runtime,
// so one path reports one inode whoever asks.
const FNV_OFFSET = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n
const FNV_MASK = 0xffffffffffffffffn
const ENC = new TextEncoder()

/**
 * A stable, distinct id for one name, as a stat's ino and dev: derived
 * from the name rather than counted, so two processes reading the same
 * workspace agree and a repeated stat of one path does not move. The top
 * 48 bits of the hash, which a number holds exactly. Mirrors Python's
 * `ident`.
 */
export function ident(text: string): number {
  let value = FNV_OFFSET
  for (const byte of ENC.encode(text)) value = ((value ^ BigInt(byte)) * FNV_PRIME) & FNV_MASK
  return Number(value >> 16n)
}

/**
 * A FileStat's mtime as epoch milliseconds, null when unknown.
 *
 * Delegates to `isoTimestamp` rather than re-parsing, which is the
 * whole point: an offset-less stamp is read as UTC so every translator
 * (the FUSE attr fold, the runtime bridge, python's twins) answers the
 * same epoch, instead of drifting by the host's UTC offset the way a
 * bare `Date.parse`/`new Date` does. Null (missing or unparseable
 * stamp) is distinct from 0, which is the real answer for
 * 1970-01-01T00:00:00Z; a wire with no validity channel collapses the
 * two at its own boundary.
 */
export function mtimeMs(st: FileStat): number | null {
  const seconds = isoTimestamp(st.modified)
  return seconds === null ? null : seconds * 1000
}

/** A FileStat's atime as epoch milliseconds, null when unknown. */
export function atimeMs(st: FileStat): number | null {
  const seconds = isoTimestamp(st.atime)
  return seconds === null ? null : seconds * 1000
}

/** Whether a FileStat describes a directory. */
export function isDir(st: FileStat): boolean {
  return st.type === FileType.DIRECTORY
}

/** Whether a FileStat describes a symlink. */
export function isLink(st: FileStat): boolean {
  return st.type === FileType.SYMLINK
}

/** Whether a FileStat describes a character device. */
export function isCharDevice(st: FileStat): boolean {
  return st.type === FileType.CHAR_DEVICE
}

/** Whether a FileStat describes a FIFO. */
export function isFifo(st: FileStat): boolean {
  return st.type === FileType.FIFO
}

/** Encode a character device's logical major:minor for guest stat. */
export function deviceRdev(st: FileStat): number {
  const values = st.extra.device_numbers
  if (
    !Array.isArray(values) ||
    values.length !== 2 ||
    !values.every((value) => Number.isInteger(value))
  ) {
    return 0
  }
  return (Number(values[0]) << 8) | Number(values[1])
}

/**
 * The st_mode a stat consumer should report for one FileStat.
 *
 * The type bits come from the entry's kind and the permission bits from
 * the namespace overlay when a chmod put one there, which is what makes
 * a metadata write visible to a guest and to a mount alike. A backend
 * that reports no mode keeps the default rw-r--r-- / rwxr-xr-x pair
 * (rw------- for a FIFO); there are no permissions to read on an object
 * store.
 *
 * A link is the exception in both halves: its type bits are S_IFLNK and
 * its permission bits are always 0777, because no POSIX system consults
 * the bits on a symlink. An overlay mode a `chmod -h` wrote is
 * therefore not reported here (ownership is, since `chown -h` does
 * change what `ls -l` shows). Mirrors python's posix_mode.
 */
export function posixMode(st: FileStat): number {
  if (isLink(st)) return LINK_MODE
  const base = BASE_MODES[st.type]
  if (st.mode === null) return base
  return (base & ~ALL_MODE_BITS) | (st.mode & ALL_MODE_BITS)
}

function permTriplet(bits: number, special?: string): string {
  const execBit =
    special !== undefined
      ? bits & 1
        ? special.toLowerCase()
        : special.toUpperCase()
      : bits & 1
        ? 'x'
        : '-'
  return (bits & 4 ? 'r' : '-') + (bits & 2 ? 'w' : '-') + execBit
}

/** Render POSIX type and permission bits as an ls or SFTP long listing. */
export function fileMode(mode: number): string {
  const type = modeType(mode)
  return (
    (type === undefined ? '?' : (TYPE_CHARS[type] ?? '-')) +
    permTriplet(mode >> 6, mode & 0o4000 ? 's' : undefined) +
    permTriplet(mode >> 3, mode & 0o2000 ? 's' : undefined) +
    permTriplet(mode, mode & 0o1000 ? 't' : undefined)
  )
}

/**
 * The byte size a stat consumer should report, 0 when unknown.
 *
 * A directory is always `DIR_SIZE`, whatever aggregate a backend put in
 * `size` (Graph folders report a subtree total there); an unknown file
 * size is 0 and rides the unknown-size machinery above.
 */
export function contentSize(st: FileStat): number {
  if (isDir(st)) return DIR_SIZE
  return st.size ?? 0
}

/**
 * Whether a listing has no size to show for one FileStat. A directory shows
 * `DIR_SIZE` and a FIFO, which stores nothing, 0 (as GNU's `stat` and `ls -l`
 * do); any other entry its rendered length. Mirrors python's size_unknown.
 */
export function sizeUnknown(st: FileStat): boolean {
  return st.size === null && !isDir(st) && !isFifo(st)
}

/**
 * The id an owner or group names as a number: ASCII digits after an optional
 * `+`, the form `chown`, `id` and `find -user` read as a number, leading
 * zeros and all; null for anything else or an id past `ID_MAX`. Mirrors
 * python's id_number.
 */
export function idNumber(text: string): number | null {
  const digits = text.startsWith('+') ? text.slice(1) : text
  if (!/^[0-9]+$/.test(digits)) return null
  const significant = digits.replace(/^0+/, '')
  if (significant.length > String(ID_MAX).length) return null
  const id = Number(significant || '0')
  return id <= ID_MAX ? id : null
}
