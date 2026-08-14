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

import type { Session } from './session.ts'
import { envGet } from './state.ts'

// Returns $HOME from the session env, or null when unset/empty, matching
// GNU bash (no implicit home; `cd` errors, `~` and $HOME do not expand).
// Read through the session door, not the raw env: this is HOME's own
// resolution channel ($HOME, tilde expansion, bare `cd`), so a hidden
// HOME must read as unset here too.
export function homeDir(session: Session): string | null {
  const home = envGet(session, 'HOME')
  return home !== null && home !== '' ? home : null
}

// The cwd as last spelled, falling back to the physical one. bash keeps
// two names for the working directory: the physical one it resolves to,
// and the logical one you typed to get there. Only `pwd`/`pwd -L` and
// `cd`'s own `..` read the logical name; everything that resolves an
// operand uses `session.cwd`.
//
// This is the shell's own record, deliberately not $PWD: that is an
// ordinary variable the user can assign, and bash does not read it back
// when deciding where `cd ..` goes. Clobbering $PWD and running `cd ..`
// from /data/lk still lands on /data.
export function logicalCwd(session: Session): string {
  return session.logicalCwd ?? session.cwd
}

// Points the session at `cwd` without recording a `cd`, for the callers
// that move a session from outside the shell: a snapshot restore, the
// session-store handoff, and the `workspace.cwd` setter. No typed
// spelling exists behind such a move, so the logical name is dropped
// rather than left describing wherever the session used to be, and
// $OLDPWD is untouched because no `cd` ran. $PWD does follow, since it
// names where the session is.
export function setCwd(session: Session, cwd: string): void {
  session.cwd = cwd
  session.logicalCwd = undefined
  session.env.PWD = cwd
}

// Moves the session. $OLDPWD is a straight copy of $PWD as it stands
// right now — not of the shell's own record. The two agree unless the
// user assigned to $PWD, and bash carries the assignment through: after
// `PWD=/clobber; cd /data` a following `cd -` tries /clobber and fails,
// and after `unset PWD; cd /data` $OLDPWD is empty. $PWD is then
// re-stated from the shell's record, so `cd` always repairs whatever was
// done to it. Passing no `logical` keeps the pair collapsed, which is
// what `-P` wants.
//
// bash never re-validates the logical name: deleting the symlink it was
// spelled through leaves `pwd` still printing it. Nothing here checks it.
export function changeDir(session: Session, newCwd: string, logical?: string): void {
  session.env.OLDPWD = session.env.PWD ?? ''
  session.cwd = newCwd
  session.logicalCwd = logical !== undefined && logical !== newCwd ? logical : undefined
  session.env.PWD = logicalCwd(session)
}
