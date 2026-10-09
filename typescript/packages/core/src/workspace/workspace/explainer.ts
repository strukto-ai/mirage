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
import type { Files } from '../files.ts'
import { Explained } from '../../policy/errors.ts'
import { Outcome, type ShellExplanation, type VfsExplanation } from '../../policy/types.ts'
import type { SetAttrFields } from '../../types.ts'
import { asyncContextIsolatesTasks } from '../../utils/async_context.ts'
import { isFsError } from '../../errors/fs.ts'

/**
 * A session's calls explained instead of run, under the session's own
 * names: `explain.shell(line)` is `session.shell(line)` and
 * `explain.vfs.<call>(...)` is `session.vfs.<call>(...)`, each answering what
 * the policies would decide.
 *
 * Nothing runs: no command, no backend or cache read, no grant spent and
 * no question put to a host. A policy deciding the call reads what it
 * reads for real, but changes nothing: its own writes are refused and its
 * own refused reads record no question. A hide never surfaces: a path the
 * session cannot see explains like any path no policy refuses. Mirrors
 * the Python `Explainer`.
 */
export class Explainer {
  constructor(
    private readonly explain: (line: string, sessionId: string) => Promise<ShellExplanation>,
    private readonly sessionId: string | null,
    private readonly files: Files,
  ) {}

  /**
   * What a line would do: its verdict, where it would run and every
   * command in it, as a tree (`Workspace.explain`).
   */
  shell(line: string): Promise<ShellExplanation> {
    return this.explain(line, this.sessionId ?? '')
  }

  /** The session's VFS calls, explained. */
  get vfs(): VfsExplainer {
    return new VfsExplainer(this.files)
  }
}

/**
 * `session.vfs` explained: each VFS call (the POSIX-shaped calls: `read`,
 * `pwrite`, `rename`, `setxattr`, ...) takes the arguments the real one
 * does and walks the same entry point (the path resolved, links followed, hides,
 * the mount mode, every policy), which stops at the gate with what it
 * would answer.
 *
 * A call the entry point answers before any policy is asked (a path that is
 * hidden or missing, a rename across mounts) explains as a call no policy
 * refuses: a dry run says what the policies decide, not whether the call
 * would otherwise succeed, which is what keeps a hide from surfacing; for
 * the same reason an explanation names no paths beyond the ones it was
 * asked about, since what the entry point resolved a path to would tell a hidden
 * one from a missing one. A rename passes two gates, its source and
 * then its destination; its explanation is the first that refuses, with
 * the answers of both. `listFiles` is judged at its listing: the entries
 * it would then stat are named only by the listing, a read a dry run does
 * not make. A restore's pending drift checks are no policy's
 * answer either: the dry run leaves them to the first call that runs, so a
 * policy reading while it decides reads the restored state.
 * Mirrors the Python `VfsExplainer`.
 */
export class VfsExplainer {
  constructor(private readonly files: Files) {}

  /** Explain `session.vfs.read`. */
  read(
    path: string,
    options: { offset?: number; size?: number | null } = {},
  ): Promise<VfsExplanation> {
    return dry('read', [path], () => this.files.read(path, options))
  }

  /** Explain `session.vfs.write`. */
  write(path: string, data: Uint8Array | string): Promise<VfsExplanation> {
    return dry('write', [path], () => this.files.write(path, data))
  }

  /** Explain `session.vfs.append`. */
  append(path: string, data: Uint8Array): Promise<VfsExplanation> {
    return dry('append', [path], () => this.files.append(path, data))
  }

  /** Explain `session.vfs.stat`; `nofollow` stats a link itself, not its target. */
  stat(path: string, opts: { nofollow?: boolean } = {}): Promise<VfsExplanation> {
    return dry('stat', [path], () => this.files.stat(path, undefined, opts))
  }

  /** Explain `session.vfs.readdir`. */
  readdir(path: string): Promise<VfsExplanation> {
    return dry('readdir', [path], () => this.files.readdir(path))
  }

  /** Explain `session.vfs.exists`, judged as the stat it makes. */
  exists(path: string): Promise<VfsExplanation> {
    return dry('exists', [path], () => this.files.stat(path))
  }

  /** Explain `session.vfs.isDir`, judged as the stat it makes. */
  isDir(path: string): Promise<VfsExplanation> {
    return dry('isDir', [path], () => this.files.stat(path))
  }

  /** Explain `session.vfs.isFile`, judged as the stat it makes. */
  isFile(path: string): Promise<VfsExplanation> {
    return dry('isFile', [path], () => this.files.stat(path))
  }

  /** Explain `session.vfs.cat`, judged as the read it makes. */
  cat(path: string): Promise<VfsExplanation> {
    return dry('cat', [path], () => this.files.read(path))
  }

  /**
   * Explain `session.vfs.listFiles`, judged as the readdir it makes; the
   * entries it would then stat are named only by that read, which a dry run
   * does not make.
   */
  listFiles(path: string): Promise<VfsExplanation> {
    return dry('listFiles', [path], () => this.files.readdir(path))
  }

  /** Explain `session.vfs.pwrite`. */
  pwrite(path: string, data: Uint8Array, offset: number): Promise<VfsExplanation> {
    return dry('pwrite', [path], () => this.files.pwrite(path, data, offset))
  }

  /** Explain `session.vfs.create`. */
  create(path: string): Promise<VfsExplanation> {
    return dry('create', [path], () => this.files.create(path))
  }

  /** Explain `session.vfs.symlink`: a link at `path` pointing to `target`. */
  symlink(path: string, target: string): Promise<VfsExplanation> {
    return dry('symlink', [path], () => this.files.symlink(path, target))
  }

  /** Explain `session.vfs.readlink`. */
  readlink(path: string): Promise<VfsExplanation> {
    return dry('readlink', [path], () => this.files.readlink(path))
  }

  /** Explain `session.vfs.setattr`. */
  setattr(path: string, attrs: SetAttrFields = {}): Promise<VfsExplanation> {
    return dry('setattr', [path], () => this.files.setattr(path, attrs))
  }

  /** Explain `session.vfs.getxattr`. */
  getxattr(path: string, name: string, opts: { nofollow?: boolean } = {}): Promise<VfsExplanation> {
    return dry('getxattr', [path], () => this.files.getxattr(path, name, opts))
  }

  /** Explain `session.vfs.listxattr`. */
  listxattr(path: string, opts: { nofollow?: boolean } = {}): Promise<VfsExplanation> {
    return dry('listxattr', [path], () => this.files.listxattr(path, opts))
  }

  /** Explain `session.vfs.setxattr`. */
  setxattr(
    path: string,
    name: string,
    value: Uint8Array,
    opts: { create?: boolean; replace?: boolean; nofollow?: boolean } = {},
  ): Promise<VfsExplanation> {
    return dry('setxattr', [path], () => this.files.setxattr(path, name, value, opts))
  }

  /** Explain `session.vfs.removexattr`. */
  removexattr(
    path: string,
    name: string,
    opts: { nofollow?: boolean } = {},
  ): Promise<VfsExplanation> {
    return dry('removexattr', [path], () => this.files.removexattr(path, name, opts))
  }

  /** Explain `session.vfs.mkdir`. */
  mkdir(path: string): Promise<VfsExplanation> {
    return dry('mkdir', [path], () => this.files.mkdir(path))
  }

  /** Explain `session.vfs.rmdir`. */
  rmdir(path: string): Promise<VfsExplanation> {
    return dry('rmdir', [path], () => this.files.rmdir(path))
  }

  /** Explain `session.vfs.unlink`. */
  unlink(path: string): Promise<VfsExplanation> {
    return dry('unlink', [path], () => this.files.unlink(path))
  }

  /** Explain `session.vfs.rename`. */
  rename(src: string, dst: string): Promise<VfsExplanation> {
    return dry('rename', [src, dst], () => this.files.rename(src, dst))
  }

  /** Explain `session.vfs.truncate`. */
  truncate(path: string, length: number): Promise<VfsExplanation> {
    return dry('truncate', [path], () => this.files.truncate(path, length))
  }
}

/**
 * Walk one VFS call through its entry point as a dry run and say what its gates
 * answered. Throws when the call returned, since it then ran past its
 * gate, which no entry point may let it do, and on a runtime whose async context
 * does not isolate tasks, where the dry run would reach another task's
 * calls.
 */
async function dry(
  call: string,
  paths: readonly string[],
  run: () => Promise<unknown>,
): Promise<VfsExplanation> {
  if (!asyncContextIsolatesTasks) {
    throw new Error(`explain.vfs.${call} needs a runtime that isolates async tasks`)
  }
  const trace: VfsExplanation[] = []
  let ran = false
  try {
    await runExplaining(trace, run)
    ran = true
  } catch (err) {
    if (!(err instanceof Explained) && (trace.length > 0 || !isFsError(err))) throw err
  }
  if (ran) throw new Error(`${call} ran past its gate in a dry run`)
  const shown = trace.find((e) => e.error !== '') ?? trace[trace.length - 1]
  if (shown === undefined) {
    return {
      call,
      paths,
      outcome: Outcome.ALLOW,
      reason: '',
      source: '',
      answers: [],
      refusal: null,
      error: '',
    }
  }
  return { ...shown, call, paths, answers: trace.flatMap((e) => e.answers) }
}
