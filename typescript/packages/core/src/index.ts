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

// The package's front door, and only that: the names a program reaches
// for first. Everything else in core is reached by module path, the way
// `mirage.resource.s3` is in Python -- the `./*` subpath map means no
// symbol needs a line here to be importable.
//
// So do not add a name because something inside the repo wants it; that
// something should name the module instead, and check_barrel_surface.py
// fails the build when it does not. The same gate holds this list to its
// consumers in both directions -- a line nothing imports, and an import of
// a name no line carries -- which the 1500-line version of this file never
// did. It is a repo-root script rather than knip because knip's project
// root is typescript/, which leaves the consumers out of view.

export { Accessor } from './accessor/base.ts'
export { defaultFingerprint } from './cache/file/utils.ts'
export { IndexEntry } from './cache/index/config.ts'
export type { RedisIndexConfig } from './cache/index/config.ts'
export { RedisIndexCacheStore } from './cache/index/redis.ts'
export type { CommandIO } from './commands/builtin/generic_bind/index.ts'
export { streamFromBytes } from './commands/builtin/utils/wrap.ts'
export { DISCORD } from './commands/cli/builtin/discord/index.ts'
export { GH } from './commands/cli/builtin/gh/index.ts'
export { GIT } from './commands/cli/builtin/git/index.ts'
export { GWS } from './commands/cli/builtin/gws/index.ts'
export { LINEAR } from './commands/cli/builtin/linear/index.ts'
export { NTN } from './commands/cli/builtin/ntn/index.ts'
export { SLACK } from './commands/cli/builtin/slack/index.ts'
export { registerCliSpec } from './commands/cli/specs.ts'
export { CLISpec } from './commands/cli/types.ts'
export type { CLIInvocation } from './commands/cli/types.ts'
export { command } from './commands/config.ts'
export type { CommandFnResult, CommandOpts } from './commands/config.ts'
export { CommandSpec, Operand, Option, SPECS, specOf } from './commands/spec/index.ts'
export { MemoryOAuthClientProvider } from './core/notion/_oauth.ts'
export { IOResult } from './io/types.ts'
export { OpsRegistry } from './ops/registry.ts'
export type {
  Action,
  CommandContext,
  ExecuteResultContext,
  OpsContext,
  OpsResultContext,
  Policy,
} from './policy/index.ts'
export { Outcome, Scope } from './policy/index.ts'
export { ProvisionResult } from './provision/types.ts'
export type { Resource } from './resource/base.ts'
export { ChromaResource } from './resource/chroma/chroma.ts'
export { normalizeDatabricksVolumeConfig } from './resource/databricks_volume/config.ts'
export { DevResource } from './resource/dev/dev.ts'
export { DifyResource } from './resource/dify/dify.ts'
export { GenericResource } from './resource/generic.ts'
export { Mem0Resource } from './resource/mem0/mem0.ts'
export { OneDriveResource } from './resource/onedrive/onedrive.ts'
export { QdrantResource } from './resource/qdrant/qdrant.ts'
export { RAMResource } from './resource/ram/ram.ts'
export { secretStr, z } from './resource/secrets.ts'
export { SharePointResource } from './resource/sharepoint/sharepoint.ts'
export { Runtime } from './runtime/base.ts'
export type { RuntimeEntry } from './runtime/base.ts'
export { EvalError } from './runtime/errors.ts'
export { EVALUATOR, LINE_EXECUTOR } from './runtime/mixin.ts'
export type { Evaluator, LineExecutor } from './runtime/mixin.ts'
export { ScriptSource } from './runtime/routing/index.ts'
export { buildRuntime } from './runtime/table.ts'
export type { EvalResult, EvalValue, RunResult } from './runtime/types.ts'
export { JobConsole } from './shell/console/index.ts'
export type { ConsoleFactory } from './shell/job_table/index.ts'
export {
  ConsistencyPolicy,
  ContentType,
  DriftPolicy,
  FileChangeKind,
  FileEvent,
  FileStat,
  FileType,
  Limit,
  MountBackend,
  MountMode,
  OnExceed,
  PathSpec,
  ResourceName,
} from './types.ts'
export type { WalkEntry } from './types.ts'
export { eisdir, enoent, enotdir } from './utils/errors.ts'
export { snakeToCamel } from './utils/normalize.ts'
export { ListingDeltaHook, RAMWatchQueue, Watcher } from './watch/index.ts'
export { SessionStore } from './workspace/session/store.ts'
export { ContentDriftError } from './workspace/snapshot/drift.ts'
export { toStateDict } from './workspace/snapshot/state.ts'
export { S3WorkspaceStateStore } from './workspace/store/s3.ts'
export { Workspace } from './workspace/workspace/workspace.ts'
export type { MountSpec } from './workspace/workspace/workspace.ts'
