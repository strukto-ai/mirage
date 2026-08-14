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

import type { LinkView } from '../../../ops/types.ts'
import { FileType, type PathSpec } from '../../../types.ts'

// Whether an operand typed with a trailing slash names a symlink.
export function isSlashedLink(p: PathSpec, links: LinkView | null): boolean {
  return links !== null && p.rawPath.endsWith('/') && links.statAt(p.virtual) !== null
}

// GNU's refusal for an `rm` operand that is a slashed symlink.
//
// A link typed with a trailing slash is refused, never followed: the
// dispatcher deliberately left the link entry in place so the command can
// report it rather than delete what the slash was protecting. GNU splits the
// wording by what the slash resolved to and whether -r was given: a directory
// without -r is EISDIR and -f does not suppress it, everything else is ENOTDIR
// and -f does.
//
// Returns null when the operand is not a slashed link, or when -f silences the
// refusal; the caller then proceeds as usual.
export async function rmLinkRefusal(
  p: PathSpec,
  links: LinkView | null,
  opts: { recursive: boolean; force: boolean },
): Promise<string | null> {
  if (!isSlashedLink(p, links) || links === null) return null
  const target = await links.targetStat(p.virtual)
  if (target !== null && target.type === FileType.DIRECTORY && !opts.recursive) {
    return `rm: cannot remove '${p.rawPath}': Is a directory`
  }
  if (opts.force) return null
  return `rm: cannot remove '${p.rawPath}': Not a directory`
}

// GNU's refusal for a `mkdir` operand occupied by a symlink.
//
// mkdir(2) lstats the name it is about to create, so a symlink sitting there is
// EEXIST however it was spelled: no backend can see the link, so the name plane
// has to answer. -p is satisfied only when the link already leads to a
// directory; pointing at a file or at nothing still collides (GNU
// `mkdir -p dangle` is "File exists", not a fresh directory at the link's
// target).
//
// `taken` says the name is already occupied by a link, so the caller must not
// create anything; `message` is the line to report (null when -p is already
// satisfied and the operand is simply skipped).
export async function mkdirLinkRefusal(
  p: PathSpec,
  links: LinkView | null,
  opts: { parents: boolean },
): Promise<{ taken: boolean; message: string | null }> {
  if (links?.statAt(p.virtual) == null) {
    return { taken: false, message: null }
  }
  const target = await links.targetStat(p.virtual)
  if (opts.parents && target !== null && target.type === FileType.DIRECTORY) {
    return { taken: true, message: null }
  }
  return {
    taken: true,
    message: `mkdir: cannot create directory '${p.rawPath}': File exists`,
  }
}
