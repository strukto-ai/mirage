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

/**
 * Who owns what a mount shows when a row names its owner by name (the
 * kernel wants numbers): the mounting user. Windows has none. Mirrors
 * Python's OWNER.
 */
export const OWNER = {
  uid: typeof process.getuid === 'function' ? process.getuid() : 0,
  gid: typeof process.getgid === 'function' ? process.getgid() : 0,
}

/**
 * The files an NFS server keeps open between reads: NFS has no open or
 * close, so a read opens its file and later reads reuse that handle. Past
 * this many, the least recently read one no read is using is released.
 * Mirrors Python's OPEN_HANDLES.
 */
export const OPEN_HANDLES = 64

/**
 * A client port below this one is bound by root. Linux's own NFS server
 * takes only those by default (its `secure` export option), so on Linux,
 * where mounting needs root, an unprivileged local user cannot reach the
 * served tree by speaking NFS to it directly. Mirrors Python's
 * RESERVED_PORTS.
 */
export const RESERVED_PORTS = 1024
