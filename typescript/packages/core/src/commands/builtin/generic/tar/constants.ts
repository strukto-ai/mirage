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

// Every diagnostic below is GNU tar 1.35's own wording, pinned on
// debian:stable-slim. argp's refusals of the options and the archive's own
// diagnostics are mirage-rs's.
export const USAGE_HINT = "Try 'tar --help' or 'tar --usage' for more information."
export const EMPTY_ARCHIVE = 'tar: Cowardly refusing to create an empty archive'
// GNU normalizes an empty operand to `.` before it stats it, says so, and
// then still names the operand as typed when the stat fails (tar 1.35).
export const EMPTY_MEMBER = "tar: Substituting `.' for empty member name"
export const FATAL_TRAILER = 'tar: Error is not recoverable: exiting now'
export const SELF_DUMP = 'archive cannot contain itself; not dumped'
// The exit GNU gives an operand it could not read, and a -C it could not
// enter. Both are fatal for the whole run, not per-operand.
export const CREATE_ERROR_EXIT = 2
// What --exclude-vcs leaves out, as the manual lists it.
export const VCS_NAMES = [
  'CVS',
  'RCS',
  'SCCS',
  '.git',
  '.gitignore',
  '.gitattributes',
  '.gitmodules',
  '.svn',
  '.cvsignore',
  '.arch-ids',
  '{arch}',
  '=RELEASE-ID',
  '=meta-update',
  '=update',
  '.bzr',
  '.bzrignore',
  '.bzrtags',
  '.hg',
  '.hgignore',
  '.hgtags',
  '_darcs',
] as const
// The compressor -a picks by the archive's suffix.
export const SUFFIX_CODECS: Readonly<Record<string, string>> = {
  '.gz': 'gzip',
  '.tgz': 'gzip',
  '.taz': 'gzip',
  '.bz2': 'bzip2',
  '.tz2': 'bzip2',
  '.tbz2': 'bzip2',
  '.tbz': 'bzip2',
  '.xz': 'xz',
  '.txz': 'xz',
  '.lzma': 'xz',
  '.tlz': 'xz',
}
// The suffixes -a answers with a compressor mirage does not have.
export const SUFFIX_UNAVAILABLE: Readonly<Record<string, string>> = {
  '.Z': 'compress',
  '.taZ': 'compress',
  '.lz': 'lzip',
  '.lzo': 'lzop',
}
