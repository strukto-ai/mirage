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

import type { FsCondition } from '../errors/index.ts'

// The guest filesystem verbs, keyed by their POSIX spelling, that every
// runtime surface answers the same way. A surface maps its own idiom
// onto these keys (monty's `Path.symlink_to`, preview1's `path_symlink`,
// Emscripten's node op, python's `os.symlink`) and never decides for
// itself whether a verb is served: the tables below are the decision.
//
// The keys are python's `os` spellings in both languages, because the
// guests are python guests: pyodide and monty run python, and a wasi
// guest's libc names line up with them. A javascript guest reaching the
// same door (quickjs's `os.readdir`) is one rename away at its own
// surface, which is cheaper than keeping two vocabularies in step.
//
// ROUTED names the op door the verb needs. Several verbs share one door
// and a few need two (lstat reads the node table before the mount), so
// the value is a list, not a single op.
export const ROUTED_VERBS: Readonly<Record<string, readonly string[]>> = {
  access: ['stat'],
  chmod: ['setattr'],
  chown: ['setattr'],
  getxattr: ['getxattr'],
  lchmod: ['setattr'],
  lchown: ['setattr'],
  listdir: ['readdir'],
  listxattr: ['listxattr'],
  lstat: ['readlink', 'stat'],
  makedirs: ['mkdir'],
  mkdir: ['mkdir'],
  readlink: ['readlink'],
  remove: ['unlink'],
  removedirs: ['rmdir'],
  removexattr: ['removexattr'],
  rename: ['rename'],
  renames: ['rename'],
  replace: ['rename'],
  rmdir: ['rmdir'],
  scandir: ['readdir', 'stat'],
  setxattr: ['setxattr'],
  stat: ['stat'],
  symlink: ['symlink'],
  truncate: ['truncate'],
  unlink: ['unlink'],
  utime: ['setattr'],
  walk: ['readdir', 'stat'],
}

// REFUSED is every verb whose fact has nowhere to live. A mount stores
// content and a name plane stores links and attribute overlays; none of
// them holds a second name for one inode, a device number, or a
// filesystem-wide block count, so these cannot be faked without lying
// to the guest.
//
// `open` is the fd tier rather than a missing fact: serving it means an
// fd table with host-visible numbers, which `runtime/handles` builds for
// the runtimes and a bare os patch has no equivalent of. `chdir` is
// refused because a host process cwd cannot be a virtual path; a runtime
// whose guest has its own cwd (Emscripten does) serves it inside that
// guest and never reaches this table.
// `link`, `mkfifo` and `mknod` refuse with EPERM instead, because that
// is what link(2) and mknod(2) document for a filesystem that does not
// support the requested node (vfat answers link() exactly this way), so
// the refusal arrives in the errno real programs already handle.
export const REFUSED_VERBS: Readonly<Record<string, FsCondition>> = {
  chdir: 'ENOTSUP',
  chflags: 'ENOTSUP',
  chroot: 'ENOTSUP',
  fwalk: 'ENOTSUP',
  lchflags: 'ENOTSUP',
  link: 'EPERM',
  mkfifo: 'EPERM',
  mknod: 'EPERM',
  open: 'ENOTSUP',
  statvfs: 'ENOTSUP',
}

// Names whose path-shaped argument is not a mount-addressable path:
// string conversions, environment and sysconf keys, descriptor-to-
// descriptor transfers, and the exec and spawn families, which name a
// program for the host to run rather than a file to serve. They keep
// host behavior even when a mounted path is spelled, so a surface must
// not route or refuse them.
export const PASSTHROUGH_VERBS: ReadonlySet<string> = new Set([
  'confstr',
  'copy_file_range',
  'execl',
  'execle',
  'execlp',
  'execlpe',
  'execv',
  'execve',
  'execvp',
  'execvpe',
  'fpathconf',
  'fsdecode',
  'fsencode',
  'fspath',
  'memfd_create',
  'pathconf',
  'posix_spawn',
  'posix_spawnp',
  'putenv',
  'spawnl',
  'spawnle',
  'spawnlp',
  'spawnlpe',
  'spawnv',
  'spawnve',
  'spawnvp',
  'spawnvpe',
  'splice',
  'sysconf',
  'unsetenv',
])

export const CLASSIFIED_VERBS: ReadonlySet<string> = new Set([
  ...Object.keys(ROUTED_VERBS),
  ...Object.keys(REFUSED_VERBS),
  ...PASSTHROUGH_VERBS,
])

/**
 * The condition a surface answers for `verb`, or null when served.
 *
 * A verb absent from every table is refused too: default-deny is what
 * keeps a name nobody classified from reaching the host filesystem with
 * a mounted path in hand.
 *
 * Args:
 *   verb: the POSIX spelling of the guest verb.
 */
export function refusalOf(verb: string): FsCondition | null {
  // `Object.hasOwn`, not `in`: every inherited name on the object
  // prototype would otherwise read as classified, so `toString` would
  // route and `constructor` would come back as a refusal that is a
  // function rather than a condition.
  if (Object.hasOwn(ROUTED_VERBS, verb) || PASSTHROUGH_VERBS.has(verb)) return null
  if (!Object.hasOwn(REFUSED_VERBS, verb)) return 'ENOTSUP'
  return REFUSED_VERBS[verb] ?? 'ENOTSUP'
}
