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

import { Runtime } from './base.ts'
import type {
  BridgeDispatchFn,
  PrefixSource,
  RunArgs,
  RunResult,
  RuntimeLanguage,
} from './types.ts'

/**
 * A runtime that interprets one language's code inside a command.
 *
 * The engine inside a single command (python3, node): the workspace
 * splits the line, and a captured stage's code lands here as run().
 * Never the whole line; that is LineExecutor's door.
 *
 * The language it interprets is declared once, for both doors: run()
 * for a script CLI (runtimeForLanguage) and eval() for a config-borne
 * policy script (evaluatorOf). One attribute, because two would let a
 * runtime claim python at one door and js at the other, and the
 * disagreement would only surface as an unexplained 127 or a policy
 * evaluated on the wrong engine. Concrete runtimes inherit it from
 * their language tier (PythonRuntime, JsRuntime) rather than declaring
 * it per class.
 *
 * How an implementation sees workspace files is its own concern: a
 * sandboxed interpreter bridges file I/O through the workspace
 * dispatch attached here, while a host subprocess only sees the host
 * filesystem and keeps the default no-op attach.
 */
export abstract class LanguageRuntime extends Runtime {
  abstract readonly language: RuntimeLanguage

  /**
   * Late-wire workspace I/O into a user-constructed instance. The
   * workspace attaches its dispatch at construction; runtimes that
   * never touch workspace files keep the default no-op.
   */
  attach(_dispatch: BridgeDispatchFn, _listMounts: PrefixSource): void {
    // runtimes that never touch workspace files keep the no-op
  }

  /** Execute one program and return its captured outcome. */
  abstract run(args: RunArgs): Promise<RunResult>
}
