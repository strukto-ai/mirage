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

import { classify } from './classify.ts'
import type { FsCondition, PosixErrno } from './types.ts'

// Linux-canonical numbers: core is runtime-agnostic and has no host
// errno module to ask (python's posix.py resolves per platform). A
// kernel adapter that must speak its host's dialect keeps its own
// condition -> number table (node/src/mount/errors.ts reads node:os);
// what lives here once is the canonical numbering and the strerror
// phrases every message renderer shares.
export const POSIX: Record<FsCondition, PosixErrno> = {
  EBADF: { errno: 9, phrase: 'Bad file descriptor' },
  ENOENT: { errno: 2, phrase: 'No such file or directory' },
  ENOTDIR: { errno: 20, phrase: 'Not a directory' },
  EISDIR: { errno: 21, phrase: 'Is a directory' },
  EEXIST: { errno: 17, phrase: 'File exists' },
  EACCES: { errno: 13, phrase: 'Permission denied' },
  EPERM: { errno: 1, phrase: 'Operation not permitted' },
  ENOTEMPTY: { errno: 39, phrase: 'Directory not empty' },
  EXDEV: { errno: 18, phrase: 'Invalid cross-device link' },
  ENOTSUP: { errno: 95, phrase: 'Operation not supported' },
  ELOOP: { errno: 40, phrase: 'Too many levels of symbolic links' },
  EINVAL: { errno: 22, phrase: 'Invalid argument' },
  EIO: { errno: 5, phrase: 'Input/output error' },
  EBUSY: { errno: 16, phrase: 'Device or resource busy' },
  EROFS: { errno: 30, phrase: 'Read-only file system' },
  EFBIG: { errno: 27, phrase: 'File too large' },
  EDQUOT: { errno: 122, phrase: 'Disk quota exceeded' },
  EPIPE: { errno: 32, phrase: 'Broken pipe' },
  NO_XATTR: { errno: 61, phrase: 'No data available' },
  STALE_WRITE: { errno: 116, phrase: 'changed since it was read; read it again before writing' },
}

/** The canonical POSIX errno for a condition. */
export function posixErrno(condition: FsCondition): number {
  return POSIX[condition].errno
}

/** The strerror text for a condition. */
export function posixPhrase(condition: FsCondition): string {
  return POSIX[condition].phrase
}

// Linux's number for each errno name, whatever the host, so a recorded
// error reads the same from either host on any platform (macOS ENOSPC
// matches, its ENAMETOOLONG is 63). The names after ECANCELED share a
// number with one before them and are never the name a number renders as.
export const ERRNO_NUMBERS: Readonly<Record<string, number>> = {
  EPERM: 1,
  ENOENT: 2,
  ESRCH: 3,
  EINTR: 4,
  EIO: 5,
  ENXIO: 6,
  E2BIG: 7,
  ENOEXEC: 8,
  EBADF: 9,
  ECHILD: 10,
  EAGAIN: 11,
  ENOMEM: 12,
  EACCES: 13,
  EFAULT: 14,
  ENOTBLK: 15,
  EBUSY: 16,
  EEXIST: 17,
  EXDEV: 18,
  ENODEV: 19,
  ENOTDIR: 20,
  EISDIR: 21,
  EINVAL: 22,
  ENFILE: 23,
  EMFILE: 24,
  ENOTTY: 25,
  ETXTBSY: 26,
  EFBIG: 27,
  ENOSPC: 28,
  ESPIPE: 29,
  EROFS: 30,
  EMLINK: 31,
  EPIPE: 32,
  EDOM: 33,
  ERANGE: 34,
  EDEADLK: 35,
  ENAMETOOLONG: 36,
  ENOLCK: 37,
  ENOSYS: 38,
  ENOTEMPTY: 39,
  ELOOP: 40,
  ENOMSG: 42,
  EIDRM: 43,
  ENODATA: 61,
  ETIME: 62,
  EREMOTE: 66,
  ENOLINK: 67,
  EPROTO: 71,
  EBADMSG: 74,
  EOVERFLOW: 75,
  EILSEQ: 84,
  EUSERS: 87,
  ENOTSOCK: 88,
  EDESTADDRREQ: 89,
  EMSGSIZE: 90,
  EPROTOTYPE: 91,
  ENOPROTOOPT: 92,
  EPROTONOSUPPORT: 93,
  ENOTSUP: 95,
  EAFNOSUPPORT: 97,
  EADDRINUSE: 98,
  EADDRNOTAVAIL: 99,
  ENETDOWN: 100,
  ENETUNREACH: 101,
  ENETRESET: 102,
  ECONNABORTED: 103,
  ECONNRESET: 104,
  ENOBUFS: 105,
  EISCONN: 106,
  ENOTCONN: 107,
  ESHUTDOWN: 108,
  ETIMEDOUT: 110,
  ECONNREFUSED: 111,
  EHOSTDOWN: 112,
  EHOSTUNREACH: 113,
  EALREADY: 114,
  EINPROGRESS: 115,
  ESTALE: 116,
  EDQUOT: 122,
  ECANCELED: 125,
  EWOULDBLOCK: 11,
  EDEADLOCK: 35,
  EOPNOTSUPP: 95,
  ENOATTR: 61,
}

const ERRNO_NAMES = new Map<number, string>(
  Object.entries(ERRNO_NUMBERS)
    .reverse()
    .map(([name, number]) => [number, name]),
)

/**
 * The number Linux gives an error's errno, null for an error that carries
 * none or one Linux has no number for. Reads the raw error, before any
 * restamp: a Node error by its `code`, one of mirage's by its condition.
 */
export function errnoOf(err: unknown): number | null {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string' && Object.hasOwn(ERRNO_NUMBERS, code)) return ERRNO_NUMBERS[code] ?? null
  const condition = classify(err)
  return condition === null ? null : posixErrno(condition)
}

/** The errno name of a Linux errno number, null for one it lacks. */
export function errnoName(errno: number): string | null {
  return ERRNO_NAMES.get(errno) ?? null
}
