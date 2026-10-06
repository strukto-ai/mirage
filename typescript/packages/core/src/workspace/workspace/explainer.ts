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

import { runExplaining } from '../../context/session_context.ts'
import type { Ops } from '../../ops/ops.ts'
import { Explained } from '../../policy/errors.ts'
import { Outcome, type Explanation } from '../../policy/types.ts'
import { isFsError } from '../../utils/errors.ts'
import type { Workspace } from './workspace.ts'

/**
 * A session's calls explained instead of run, under the session's own
 * names: `explain.shell(line)` is `session.shell(line)` and
 * `explain.vfs.<op>(...)` is `session.vfs.<op>(...)`, each answering what
 * the policies would decide.
 *
 * Nothing runs: no command, no backend or cache read, no grant spent and
 * no question put to a host. A hide never surfaces: a path the session
 * cannot see explains like any path no policy refuses. Mirrors the Python
 * `Explainer`.
 */
export class Explainer {
  constructor(
    private readonly ws: Workspace,
    private readonly sessionId: string | null,
    private readonly ops: Ops,
  ) {}

  /**
   * What a line would do: one explanation per command the gate reads,
   * with every policy's answer and the line's placement
   * (`Workspace.explain`).
   */
  shell(line: string): Promise<Explanation[]> {
    return this.ws.explain(line, this.sessionId ?? '')
  }

  /** The session's file ops, explained. */
  get vfs(): VfsExplainer {
    return new VfsExplainer(this.ops)
  }
}

/**
 * `session.vfs` explained: each op takes the arguments the real one does
 * and walks the same door (the path resolved, links followed, hides, the
 * mount mode, every policy), which stops at the op gate with what it
 * would answer.
 *
 * An op the door answers before any policy is asked (a path that is
 * hidden or missing, a rename across mounts) explains as an op no policy
 * refuses: a dry run says what the policies decide, not whether the call
 * would otherwise succeed, which is what keeps a hide from surfacing; for
 * the same reason an op's explanation names no paths beyond the `argv` it
 * was asked about, since what the door resolved a path to would tell a
 * hidden one from a missing one. A rename passes two gates, its source and
 * then its destination; its explanation is the first that refuses, with
 * the answers of both.
 * Mirrors the Python `VfsExplainer`.
 */
export class VfsExplainer {
  constructor(private readonly ops: Ops) {}

  /** Explain `session.vfs.read`. */
  read(
    path: string,
    options: { offset?: number; size?: number | null } = {},
  ): Promise<Explanation> {
    return dry('read', [path], () => this.ops.read(path, options))
  }

  /** Explain `session.vfs.write`. */
  write(path: string, data: Uint8Array | string): Promise<Explanation> {
    return dry('write', [path], () => this.ops.write(path, data))
  }

  /** Explain `session.vfs.append`. */
  append(path: string, data: Uint8Array): Promise<Explanation> {
    return dry('append', [path], () => this.ops.append(path, data))
  }

  /** Explain `session.vfs.stat`; `nofollow` stats a link itself, not its target. */
  stat(path: string, opts: { nofollow?: boolean } = {}): Promise<Explanation> {
    return dry('stat', [path], () => this.ops.stat(path, undefined, opts))
  }

  /** Explain `session.vfs.readdir`. */
  readdir(path: string): Promise<Explanation> {
    return dry('readdir', [path], () => this.ops.readdir(path))
  }

  /** Explain `session.vfs.exists`, which is the stat it makes. */
  exists(path: string): Promise<Explanation> {
    return dry('stat', [path], () => this.ops.stat(path))
  }

  /** Explain `session.vfs.mkdir`. */
  mkdir(path: string): Promise<Explanation> {
    return dry('mkdir', [path], () => this.ops.mkdir(path))
  }

  /** Explain `session.vfs.rmdir`. */
  rmdir(path: string): Promise<Explanation> {
    return dry('rmdir', [path], () => this.ops.rmdir(path))
  }

  /** Explain `session.vfs.unlink`. */
  unlink(path: string): Promise<Explanation> {
    return dry('unlink', [path], () => this.ops.unlink(path))
  }

  /** Explain `session.vfs.rename`. */
  rename(src: string, dst: string): Promise<Explanation> {
    return dry('rename', [src, dst], () => this.ops.rename(src, dst))
  }

  /** Explain `session.vfs.truncate`. */
  truncate(path: string, length: number): Promise<Explanation> {
    return dry('truncate', [path], () => this.ops.truncate(path, length))
  }
}

/**
 * Walk one op through its door as a dry run and say what its gates
 * answered. Throws when the op returned, since it then ran past its gate,
 * which no door may let it do.
 */
async function dry(
  op: string,
  argv: readonly string[],
  call: () => Promise<unknown>,
): Promise<Explanation> {
  const trace: Explanation[] = []
  let ran = false
  try {
    await runExplaining(trace, call)
    ran = true
  } catch (err) {
    if (!(err instanceof Explained) && (trace.length > 0 || !isFsError(err))) throw err
  }
  if (ran) throw new Error(`${op} ran past its gate in a dry run`)
  const shown = trace.find((e) => e.error !== '') ?? trace[trace.length - 1]
  if (shown === undefined) {
    return {
      command: op,
      argv,
      outcome: Outcome.ALLOW,
      rule: null,
      reason: '',
      source: '',
      matchedPath: null,
      paths: [],
      exitCode: 0,
      stderr: '',
      refusal: null,
      answers: [],
      placement: [],
      runtime: '',
      error: '',
    }
  }
  return {
    ...shown,
    command: op,
    argv,
    paths: [],
    answers: trace.flatMap((e) => e.answers),
  }
}
