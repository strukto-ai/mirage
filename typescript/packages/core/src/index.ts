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

export { VERSION } from './version.ts'
export {
  CommandSafeguard,
  type CommandSafeguardInit,
  ConsistencyPolicy,
  type CopyFn,
  type CopyStrategy,
  DriftPolicy,
  FileStat,
  type FileStatInit,
  FileType,
  type FindFn,
  MountMode,
  type MoveFn,
  type MoveStrategy,
  type NativeCopy,
  type NativeMove,
  OnExceed,
  PathSpec,
  type PathSpecInit,
  type PolymorphicReadFn,
  type PolymorphicReadResult,
  type PrimitiveCopy,
  type PrimitiveMove,
  type ReadBytesFn,
  type ReaddirFn,
  type ReadStreamFn,
  ResourceName,
  type StatFn,
} from './types.ts'
export {
  captureFingerprints,
  checkDrift,
  ContentDriftError,
  type FingerprintEntry,
  liveOnlyMountPrefixes,
} from './workspace/snapshot/drift.ts'
export { applyStateDict, buildMountArgs, toStateDict } from './workspace/snapshot/state.ts'
export type {
  CacheEntrySnapshot,
  ExecutionRecordSnapshot,
  FingerprintEntrySnapshot,
  JobSnapshot,
  MountSnapshot,
  ResourceState,
  SessionSnapshot,
  WorkspaceStateDict,
} from './workspace/snapshot/types.ts'
export { BaseResource, type FindOptions, type Resource, throwUnsupported } from './resource/base.ts'
export {
  hasRedactedSecret,
  REDACTED_SECRET,
  redactConfigWithSchema,
  resourceStateRequiresOverride,
  secretSchema,
  secretStr,
  type SecretStr,
} from './resource/secrets.ts'
export { z } from 'zod'
export { RAMResource } from './resource/ram/ram.ts'
export { RAMStore } from './resource/ram/store.ts'
export { DevResource } from './resource/dev/dev.ts'
export { DevStore, DevFiles } from './resource/dev/store.ts'
export {
  type ExecuteOptions,
  ExecuteResult,
  type MountSpec,
  Workspace,
  type WorkspaceOptions,
} from './workspace/workspace.ts'
export { WorkspaceRunner } from './workspace/runner.ts'
export {
  createShellParser,
  type ShellNode,
  type ShellParser,
  type ShellParserConfig,
} from './shell/parse.ts'
export {
  op,
  type OpFn,
  type OpKwargs,
  type OpOptions,
  OpsRegistry,
  type RegisteredOp,
  registerOp,
} from './ops/registry.ts'
export { RAM_OPS } from './ops/ram/index.ts'
export { makeGenericOps } from './ops/generic/factory.ts'
export { extractWriteData } from './ops/write_args.ts'
export { RAM_COMMANDS } from './commands/builtin/ram/index.ts'
export {
  DEFAULT_COMMAND_SAFEGUARDS,
  FALLBACK_SAFEGUARD,
  resolveAcrossMounts,
  resolveSafeguard,
} from './commands/safeguard.ts'
export { CommandTimeoutError, SafeguardExceededError } from './commands/builtin/utils/safeguard.ts'
export { GENERAL_COMMANDS } from './commands/builtin/general/index.ts'
export { GENERAL_BC } from './commands/builtin/general/bc.ts'
export { GENERAL_CURL } from './commands/builtin/general/curl.ts'
export { GENERAL_DATE } from './commands/builtin/general/date.ts'
export { GENERAL_EXPR } from './commands/builtin/general/expr.ts'
export { GENERAL_SEQ } from './commands/builtin/general/seq.ts'
export { GENERAL_WGET } from './commands/builtin/general/wget.ts'
export { S3_COMMANDS } from './commands/builtin/s3/index.ts'
export {
  AMBIGUOUS_NAMES,
  CommandSpec,
  type CommandSpecInit,
  Operand,
  type OperandInit,
  OperandKind,
  Option,
  type OptionInit,
  ParsedArgs,
  type ParsedArgsInit,
  parseCommand,
  parseToKwargs,
  specOf,
  SPECS,
} from './commands/spec/index.ts'
export { type ByteSource, IOResult, type IOResultInit, materialize } from './io/types.ts'
export { CachableAsyncIterator } from './io/cachable_iterator.ts'
export {
  asyncChain,
  closeQuietly,
  drain,
  exitOnEmpty,
  mergeStdoutStderr,
  quietMatch,
  wrapCachableStreams,
  yieldBytes,
} from './io/stream.ts'
export { OpRecord, type OpRecordInit } from './observe/record.ts'
export { LogEntry, type LogEntryInit } from './observe/log_entry.ts'
export { type EventDict, Observer } from './observe/observer.ts'
export { type ObserverStore, RAMObserverStore } from './observe/store.ts'
export { NamespaceStore, type NodeFields } from './workspace/mount/namespace/store.ts'
export { RAMNamespaceStore } from './workspace/mount/namespace/ram.ts'
export { HISTORY_PREFIX, HistoryViewResource } from './resource/history/history.ts'
export {
  record,
  recordStream,
  revisionFor,
  runWithRecording,
  runWithRevisions,
  setVirtualPrefix,
} from './observe/context.ts'
export { guessType } from './utils/filetype.ts'
export { newSessionId, newWorkspaceId, uuid7 } from './utils/ids.ts'
export { Accessor, NOOPAccessor, RAMAccessor } from './accessor/index.ts'
export { cat as featherCat, describe as featherDescribe } from './core/filetype/feather.ts'
export { cat as hdf5Cat, describe as hdf5Describe } from './core/filetype/hdf5.ts'
export { cat as parquetCat, describe as parquetDescribe } from './core/filetype/parquet.ts'
export {
  makeFiletypeCommands,
  type FiletypeCommandsOptions,
} from './commands/builtin/filetype_factory/factory.ts'
export {
  type Builder,
  type BuilderFn,
  type CommandIO,
  type MakeGenericCommandsOptions,
  defaultProvision,
  makeCopyProvision,
  makeFileReadProvision,
  makeGenericCommands,
  makeHeadTailProvision,
  makeJqProvision,
  makeResolveGlob,
  makeSearchProvision,
  makeSedProvision,
  makeTransformProvision,
  metadataProvision,
  pureProvision,
  resolveGlobOf,
  withDefaultProvisions,
  writeMetadataProvision,
} from './commands/builtin/generic_bind/index.ts'
export {
  FILETYPE_ENTRIES,
  type FiletypeEntry,
  type FiletypeModule,
  type FiletypeReadBytesFn,
  type StatEntryFn,
} from './commands/builtin/filetype_factory/extensions.ts'
export { numberLines } from './commands/builtin/generic/cat.ts'
export { CUT_OPEN_END, cutBytes, cutStream, parseCutRanges } from './commands/builtin/cut_helper.ts'
export { cutGeneric } from './commands/builtin/generic/cut.ts'
export { tacGeneric } from './commands/builtin/generic/tac.ts'
export { nlGeneric } from './commands/builtin/generic/nl.ts'
export { trGeneric } from './commands/builtin/generic/tr.ts'
export { uniqGeneric } from './commands/builtin/generic/uniq.ts'
export { xxdGeneric } from './commands/builtin/generic/xxd.ts'
export { base64Generic } from './commands/builtin/generic/base64_cmd.ts'
export { revGeneric } from './commands/builtin/generic/rev.ts'
export { sortGeneric } from './commands/builtin/generic/sort.ts'
export { shufGeneric } from './commands/builtin/generic/shuf.ts'
export { stringsGeneric } from './commands/builtin/generic/strings.ts'
export { tsortGeneric } from './commands/builtin/generic/tsort.ts'
export { foldGeneric } from './commands/builtin/generic/fold.ts'
export { lookGeneric } from './commands/builtin/generic/look.ts'
export { expandGeneric } from './commands/builtin/generic/expand.ts'
export { unexpandGeneric } from './commands/builtin/generic/unexpand.ts'
export { md5Generic } from './commands/builtin/generic/md5.ts'
export { columnGeneric } from './commands/builtin/generic/column.ts'
export { pasteGeneric } from './commands/builtin/generic/paste.ts'
export { zcatGeneric } from './commands/builtin/generic/zcat.ts'
export { zgrepGeneric } from './commands/builtin/generic/zgrep.ts'
export { cmpGeneric } from './commands/builtin/generic/cmp.ts'
export { commGeneric } from './commands/builtin/generic/comm.ts'
export { joinGeneric } from './commands/builtin/generic/join.ts'
export { gzipGeneric } from './commands/builtin/generic/gzip.ts'
export { gunzipGeneric } from './commands/builtin/generic/gunzip.ts'
export { iconvGeneric } from './commands/builtin/generic/iconv.ts'
export { sedGeneric } from './commands/builtin/generic/sed.ts'
export { teeGeneric } from './commands/builtin/generic/tee.ts'
export { splitGeneric } from './commands/builtin/generic/split.ts'
export { csplitGeneric } from './commands/builtin/generic/csplit.ts'
export { mktempGeneric } from './commands/builtin/generic/mktemp.ts'
export { patchGeneric } from './commands/builtin/generic/patch.ts'
export { unzipGeneric } from './commands/builtin/generic/unzip.ts'
export { zipGeneric } from './commands/builtin/generic/zip_cmd.ts'
export { tarGeneric } from './commands/builtin/generic/tar.ts'
export { realpathGeneric } from './commands/builtin/generic/realpath.ts'
export { findGeneric, findSizeMtimeError, invalidFindArg } from './commands/builtin/generic/find.ts'
export { walkFind } from './core/generic/find.ts'
export { statGeneric } from './commands/builtin/generic/stat.ts'
export { diffGeneric } from './commands/builtin/generic/diff.ts'
export { duGeneric } from './commands/builtin/generic/du.ts'
export { treeGeneric } from './commands/builtin/generic/tree.ts'
export { lsGeneric } from './commands/builtin/generic/ls.ts'
export { fileGeneric } from './commands/builtin/generic/file.ts'
export { sha256sumGeneric } from './commands/builtin/generic/sha256sum.ts'
export { jqGeneric } from './commands/builtin/generic/jq.ts'
export { grepGeneric } from './commands/builtin/generic/grep.ts'
export { rgGeneric } from './commands/builtin/generic/rg.ts'
export { cpGeneric } from './commands/builtin/generic/cp.ts'
export { mvGeneric } from './commands/builtin/generic/mv.ts'
export { awkGeneric } from './commands/builtin/generic/awk.ts'
export { catGeneric } from './commands/builtin/generic/cat.ts'
export { headGeneric } from './commands/builtin/generic/head.ts'
export { tailGeneric } from './commands/builtin/generic/tail.ts'
export { wcGeneric } from './commands/builtin/generic/wc.ts'
export { readlinkGeneric } from './commands/builtin/generic/readlink.ts'
export { fmtGeneric } from './commands/builtin/generic/fmt.ts'
export { headStream } from './commands/builtin/generic/head.ts'
export { basenameFn } from './commands/builtin/generic/basename.ts'
export { dirnameFn } from './commands/builtin/generic/dirname.ts'
export { gnuBasename, gnuDirname, norm, parent, posixNormpath, resolvePath } from './utils/path.ts'
export { shlexSplit } from './utils/shlex.ts'
export {
  DEFAULT_MAX_GLOB_MATCHES,
  expandPattern,
  hasGlob,
  isWordShaped,
  resolveGlobWith,
  spellMatch,
} from './utils/glob_walk.ts'
export { detectFileType, FILE_MIME_MAP, formatFileResult } from './commands/builtin/file_helper.ts'
export {
  type AggregateResult,
  concatAggregate,
  headerAggregate,
  prefixAggregate,
  wcAggregate,
} from './commands/builtin/aggregators.ts'
export {
  compilePattern,
  escapeRegex,
  type GrepLinesOptions,
  grepLines,
  type GrepStreamOptions,
  grepStream,
  patternArg,
} from './commands/builtin/grep_helper.ts'
export { grepContextLines } from './commands/builtin/grep_context.ts'
export {
  rgFolderFiletype,
  type RgFolderFiletypeOptions,
  rgFull,
  type RgFullOptions,
  rgMatchesFilter,
  TYPE_EXTENSIONS,
} from './commands/builtin/rg_helper.ts'
export type {
  AsyncReadBytesFn,
  AsyncReaddirFn,
  AsyncStatFn,
} from './commands/builtin/utils/types.ts'
export {
  compareKeys,
  parseKeyOptions,
  sortAndDedupe,
  sortKey,
  splitSortLines,
  type SortKeyOptions,
} from './commands/builtin/sort_helper.ts'
export { countNewlines, parseN, tailBytes } from './commands/builtin/tail_helper.ts'
export { AsyncLineIterator } from './io/async_line_iterator.ts'
export { readStdinAsync, resolveSource, wrapBytes } from './commands/builtin/utils/stream.ts'
export { formatLsLong, humanSize } from './commands/builtin/utils/formatting.ts'
export {
  formatOptionalRecords,
  formatRecordText,
  formatRecords,
} from './commands/builtin/utils/output.ts'
export { grepFilesOnly, grepRecursive } from './commands/builtin/grep_helper.ts'
export { interpretEscapes } from './commands/builtin/utils/escapes.ts'
export {
  deflateRaw,
  gunzip,
  gzip,
  inflateRaw,
  registerCompressionCodec,
  getCompressionCodec,
  type CompressionCodec,
} from './utils/compress.ts'
export { decodeBase64, encodeBase64 } from './utils/base64.ts'
export { md5, md5Hex, sha256, sha256Hex } from './utils/hash.ts'
export {
  evalJsonlStream,
  isJsonlPath,
  isStreamableJsonlExpr,
  jqEval,
  parseJsonAuto,
  parseJsonPath,
} from './core/jq/index.ts'
export { DiffOpTag } from './commands/builtin/diff_types.ts'
export { edScript, normalDiff, unifiedDiff } from './commands/builtin/diff_helper.ts'
export {
  AwkBlock,
  AwkBoolOp,
  AwkBuiltin,
  AwkCmpOp,
  CMP_OP_PATTERN,
  FIELD_PREFIX,
  PRINT_STMT,
} from './commands/builtin/generic/awk_types.ts'
export { awkStream } from './commands/builtin/generic/awk_helper.ts'
export {
  executeProgram,
  executeProgram as sedExecuteProgram,
  parseOneCommand,
  parseOneCommand as sedParseOneCommand,
  parseProgram,
  parseProgram as sedParseProgram,
  translateReplacement,
  type SedCommand,
} from './commands/builtin/sed_helper.ts'
export { readTar, type TarEntry, writeTar } from './commands/builtin/tar_helper.ts'
export {
  cut as featherCut,
  grep as featherGrep,
  head as featherHead,
  stat as featherStat,
  tail as featherTail,
  wc as featherWc,
} from './core/filetype/feather.ts'
export {
  cut as hdf5Cut,
  grep as hdf5Grep,
  head as hdf5Head,
  stat as hdf5Stat,
  tail as hdf5Tail,
  wc as hdf5Wc,
} from './core/filetype/hdf5.ts'
export {
  cut as parquetCut,
  grep as parquetGrep,
  head as parquetHead,
  stat as parquetStat,
  tail as parquetTail,
  wc as parquetWc,
} from './core/filetype/parquet.ts'
export { Precision, ProvisionResult, type ProvisionResultInit } from './provision/types.ts'
export { IndexEntry, type IndexEntryInit, ResourceType } from './cache/index/config.ts'
export { drainBudget, type FileCache, validateMaxDrainBytes } from './cache/file/mixin.ts'
export { CacheEntry, type CacheEntryInit } from './cache/file/entry.ts'
export { defaultFingerprint, parseLimit } from './cache/file/utils.ts'
export { RAMFileCacheStore } from './cache/file/ram.ts'
export { applyIo, readFingerprint } from './cache/file/io.ts'
export {
  LookupStatus,
  type IndexConfig,
  type ListResult,
  type LookupResult,
  type RedisIndexConfig,
} from './cache/index/config.ts'
export { IndexCacheStore } from './cache/index/store.ts'
export { RAMIndexCacheStore } from './cache/index/ram.ts'
export { CacheManager } from './cache/manager.ts'
export {
  activeCacheManager,
  invalidateAfterUnlink,
  invalidateAfterWrite,
  runWithCacheManager,
  type CacheInvalidator,
} from './cache/context.ts'
export {
  RedisIndexCacheStore,
  type RedisClientLike,
  type RedisIndexCacheOptions,
} from './cache/index/redis.ts'
export {
  ExecutionNode,
  type ExecutionNodeInit,
  ExecutionRecord,
  type ExecutionRecordInit,
} from './workspace/types.ts'
export { Session, type SessionInit } from './workspace/session/session.ts'
export { SessionManager } from './workspace/session/manager.ts'
export { SessionStore, generationOf, type SessionFields } from './workspace/session/store.ts'
export { RAMSessionStore } from './workspace/session/ram.ts'
export { S3RecordClient, S3SessionStore, isConditionLostError } from './workspace/session/s3.ts'
export {
  WorkspaceStateStore,
  type WorkspaceFields,
  type WorkspaceStateStoreOverrides,
} from './workspace/store/base.ts'
export { RAMWorkspaceStateStore } from './workspace/store/ram.ts'
export { S3WorkspaceStateStore } from './workspace/store/s3.ts'
export { runWithSession } from './context/session_context.ts'
export { CallFrame, type CallFrameInit, CallStack } from './shell/call_stack.ts'
export { Job, JobStatus, JobTable, type JobTaskResult } from './shell/job_table.ts'
export {
  type ExecuteNodeFn,
  handleBackground,
  handleJobs,
  handleKill,
  handlePs,
  handleWait,
} from './workspace/executor/jobs.ts'
export {
  type DispatchFn,
  handleCrossMount,
  isCrossMount,
} from './workspace/executor/cross_mount.ts'
export { handleCommand, ReturnSignal } from './workspace/executor/command.ts'
export {
  bindCommands,
  runtimeBindingsFor,
  DEFAULT_ENTRIES,
  VfsRuntime,
  type RunArgs,
  type RunResult,
  type Runtime,
  type RuntimeEntry,
} from './workspace/executor/runtime.ts'
export {
  commandFacts,
  decideLine,
  ScriptSource,
  RoutingDecisionError,
  type CommandFacts,
  type RoutingDecision,
  type RouteContext,
  type RouteFn,
  type RouteScript,
} from './workspace/executor/route/index.ts'
export { buildRuntime, candidates, RUNTIMES } from './workspace/executor/runtime_table.ts'
export type { JsRuntime } from './workspace/executor/js/interface.ts'
export { applyBarrier, BarrierPolicy } from './shell/barrier.ts'
export { handleConnection, handlePipe, handleSubshell } from './workspace/executor/pipes.ts'
export { handleRedirect } from './workspace/executor/redirect.ts'
export {
  BreakSignal,
  ContinueSignal,
  handleCase,
  handleFor,
  handleIf,
  handleSelect,
  handleUntil,
  handleWhile,
} from './workspace/executor/control.ts'
export {
  type ExecuteStringFn,
  handleCd,
  handleEcho,
  handleEval,
  handleExport,
  handleLocal,
  handlePrintenv,
  handlePrintf,
  handleRead,
  handleReturn,
  handleSet,
  handleShift,
  handleSleep,
  handleSource,
  handleTest,
  handleTrap,
  handleUnset,
} from './workspace/executor/builtins/index.ts'
export { NodeType, Redirect, type RedirectInit, RedirectKind, ShellBuiltin } from './shell/types.ts'
export {
  getCaseItems,
  getCaseWord,
  getCommandAssignments,
  getCommandName,
  getDeclarationAssignments,
  getDeclarationKeyword,
  getForParts,
  getFunctionBody,
  getFunctionName,
  getHeredocMeta,
  getHeredocParts,
  getHerestringContent,
  getIfBranches,
  getListParts,
  getNegatedCommand,
  getParts,
  getPipelineCommands,
  getProcessSubCommand,
  getRedirectTargetNode,
  getRedirects,
  getSubshellBody,
  getTestArgv,
  getText,
  getUnsetNames,
  getWhileParts,
} from './shell/helpers.ts'
export { MountCommandUnsupported, MountRegistry } from './workspace/mount/registry.ts'
export { MountEntry, type MountInit } from './workspace/mount/mount.ts'
export { normMountPrefix } from './workspace/snapshot/utils.ts'
export {
  command,
  type CommandFn,
  type CommandFnResult,
  type CommandOptions,
  type CommandOpts,
  crossCommand,
  type CrossCommandOptions,
  type ProvisionFn,
  RegisteredCommand,
  type RegisteredCommandInit,
} from './commands/config.ts'
export {
  COMPOUND_EXTENSIONS,
  getExtension,
  materializeStdout,
  stripPrefixFromPathKwargs,
} from './commands/resolve.ts'
export {
  ARITH_DELIMITERS,
  ARITH_OPERATORS,
  classifyBarePath,
  classifyParts,
  classifyWord,
  expandAndClassify,
  expandBraces,
  expandNode,
  expandParts,
  type ExecuteFn,
  lookupVar,
  type TSNodeLike,
  unescapePath,
} from './workspace/expand/index.ts'
export { resolveGlobs, type ResourceWithGlob } from './workspace/expand/globs.ts'
export {
  Consumer,
  NAMESPACE_COMMANDS,
  SHELL_CONSUMERS,
  UNSUPPORTED_BUILTINS,
  route,
} from './workspace/route/index.ts'
export { expandTestExpr } from './workspace/node/test_expr.ts'
export { executeNode, type ExecuteNodeDeps } from './workspace/node/execute_node.ts'
export { S3Accessor, type S3ResourceLike } from './accessor/s3.ts'
export {
  normalizeKeyPrefix,
  redactConfig as redactS3Config,
  S3ConfigSchema,
  type S3BrowserOperation,
  type S3BrowserPresignedUrlProvider,
  type S3BrowserSignOptions,
  type S3Config,
  type S3ConfigRedacted,
} from './resource/s3/config.ts'
export { remapCommandsResource, remapOpsResource } from './resource/s3/remap.ts'
export { S3_PROMPT } from './resource/s3/prompt.ts'
export { SCOPE_ERROR as S3_SCOPE_ERROR } from './core/s3/constants.ts'
export { copy } from './core/s3/copy.ts'
export { create } from './core/s3/create.ts'
export { du, duAll } from './core/s3/du.ts'
export { exists } from './core/s3/exists.ts'
export { find } from './core/s3/find.ts'
export { mkdir } from './core/s3/mkdir.ts'
export { fpRevFromS3Response, read } from './core/s3/read.ts'
export { readdir } from './core/s3/readdir.ts'
export { rename } from './core/s3/rename.ts'
export { rmR } from './core/s3/rm.ts'
export { rmdir } from './core/s3/rmdir.ts'
export { stat } from './core/s3/stat.ts'
export { stream, rangeRead } from './core/s3/stream.ts'
export { truncate } from './core/s3/truncate.ts'
export { unlink } from './core/s3/unlink.ts'
export { write } from './core/s3/write.ts'
export { S3_OPS } from './ops/s3/index.ts'
export {
  HttpSlackTransport,
  NodeSlackTransport,
  SlackApiError,
  type SlackResponse,
  type SlackTransport,
} from './core/slack/_client.ts'
export {
  BrowserSlackTransport,
  type BrowserSlackTransportOptions,
} from './core/slack/_client_browser.ts'
export { SlackAccessor } from './accessor/slack.ts'
export {
  DISCORD_API,
  type DiscordMethod,
  DiscordApiError,
  type DiscordResponse,
  type DiscordTransport,
  HttpDiscordTransport,
} from './core/discord/_client.ts'
export {
  BrowserDiscordTransport,
  type BrowserDiscordTransportOptions,
} from './core/discord/_client_browser.ts'
export { DiscordAccessor, type DiscordResourceLike } from './accessor/discord.ts'
export { SLACK_COMMANDS } from './commands/builtin/slack/index.ts'
export { SLACK_OPS } from './ops/slack/index.ts'
export { read as slackRead } from './core/slack/read.ts'
export { readdir as slackReaddir } from './core/slack/readdir.ts'
export { stat as slackStat } from './core/slack/stat.ts'
export { SLACK_PROMPT, SLACK_WRITE_PROMPT } from './resource/slack/prompt.ts'
export { DISCORD_COMMANDS } from './commands/builtin/discord/index.ts'
export { DISCORD_OPS } from './ops/discord/index.ts'
export { read as discordRead } from './core/discord/read.ts'
export { readdir as discordReaddir } from './core/discord/readdir.ts'
export { stat as discordStat } from './core/discord/stat.ts'
export { DISCORD_PROMPT, DISCORD_WRITE_PROMPT } from './resource/discord/prompt.ts'
export {
  HttpTrelloTransport,
  type HttpTrelloTransportOptions,
  TrelloApiError,
  type TrelloTransport,
} from './core/trello/_client.ts'
export { TrelloAccessor, type TrelloResourceLike } from './accessor/trello.ts'
export { TRELLO_COMMANDS } from './commands/builtin/trello/index.ts'
export { TRELLO_OPS } from './ops/trello/index.ts'
export {
  HttpLinearTransport,
  type HttpLinearTransportOptions,
  LinearApiError,
  type LinearTransport,
} from './core/linear/_client.ts'
export { LinearAccessor, type LinearResourceLike } from './accessor/linear.ts'
export { LINEAR_COMMANDS } from './commands/builtin/linear/index.ts'
export { LINEAR_OPS } from './ops/linear/index.ts'
export { read as linearRead } from './core/linear/read.ts'
export { readdir as linearReaddir, type LinearReaddirFilter } from './core/linear/readdir.ts'
export { stat as linearStat } from './core/linear/stat.ts'
export { LINEAR_PROMPT, LINEAR_WRITE_PROMPT } from './resource/linear/prompt.ts'
export { NotionAccessor, type NotionResourceLike } from './accessor/notion.ts'
export {
  HttpNotionTransport,
  MCPNotionTransport,
  NotionAPIError,
  NotionMCPError,
  type HttpNotionTransportOptions,
  type NotionTransport,
  type MCPNotionTransportOptions,
} from './core/notion/_client.ts'
export {
  MemoryOAuthClientProvider,
  type MemoryOAuthClientProviderOptions,
} from './core/notion/_oauth.ts'
export { read as notionRead } from './core/notion/read.ts'
export { readdir as notionReaddir } from './core/notion/readdir.ts'
export { stat as notionStat } from './core/notion/stat.ts'
export { NOTION_PROMPT, NOTION_WRITE_PROMPT } from './resource/notion/prompt.ts'
export { NOTION_COMMANDS } from './commands/builtin/notion/index.ts'
export { NOTION_OPS } from './ops/notion/index.ts'
export {
  HttpLangfuseTransport,
  type HttpLangfuseTransportOptions,
  LangfuseApiError,
  type LangfuseTransport,
} from './core/langfuse/_client.ts'
export { LangfuseAccessor, type LangfuseResourceLike } from './accessor/langfuse.ts'
export { LANGFUSE_COMMANDS } from './commands/builtin/langfuse/index.ts'
export { LANGFUSE_OPS } from './ops/langfuse/index.ts'
export { read as langfuseRead } from './core/langfuse/read.ts'
export { readdir as langfuseReaddir } from './core/langfuse/readdir.ts'
export { stat as langfuseStat } from './core/langfuse/stat.ts'
export { LANGFUSE_PROMPT } from './resource/langfuse/prompt.ts'
export { detectScope as langfuseDetectScope, type LangfuseScope } from './core/langfuse/scope.ts'
export { read as trelloRead } from './core/trello/read.ts'
export { readdir as trelloReaddir, type TrelloReaddirFilter } from './core/trello/readdir.ts'
export { stat as trelloStat } from './core/trello/stat.ts'
export { TRELLO_PROMPT, TRELLO_WRITE_PROMPT } from './resource/trello/prompt.ts'
export {
  GitHubApiError,
  GITHUB_API_BASE,
  GITHUB_API_VERSION,
  HttpGitHubTransport,
  type GitHubBlob,
  type GitHubRepoInfo,
  type GitHubTransport,
  type GitHubTreeItem,
  fetchBlob as fetchGitHubBlob,
  fetchDirTree as fetchGitHubDirTree,
  fetchRepoInfo as fetchGitHubRepoInfo,
  fetchTree as fetchGitHubTree,
} from './core/github/_client.ts'
export { GitHubAccessor, type GitHubResourceLike } from './accessor/github.ts'
export { GITHUB_COMMANDS } from './commands/builtin/github/index.ts'
export { GITHUB_OPS } from './ops/github/index.ts'
export { read as githubRead, stream as githubStream } from './core/github/read.ts'
export { readdir as githubReaddir } from './core/github/readdir.ts'
export {
  buildTreeMap as githubBuildTreeMap,
  populateIndex as githubPopulateIndex,
} from './core/github/tree.ts'
export { stat as githubStat } from './core/github/stat.ts'
export {
  type TreeEntry as GitHubTreeEntry,
  makeTreeEntry as githubMakeTreeEntry,
  indexEntryFromTree as githubIndexEntryFromTree,
} from './core/github/tree_entry.ts'
export {
  search as githubSearchCode,
  narrowPaths as githubNarrowPaths,
} from './core/github/search.ts'
export { GITHUB_PROMPT } from './resource/github/prompt.ts'
export { type CITransport, HttpCITransport } from './core/github_ci/_client.ts'
export { GitHubCIAccessor, type GitHubCIResourceLike } from './accessor/github_ci.ts'
export { GITHUB_CI_COMMANDS } from './commands/builtin/github_ci/index.ts'
export { GITHUB_CI_OPS } from './ops/github_ci/index.ts'
export { read as githubCiRead, stream as githubCiStream } from './core/github_ci/read.ts'
export { readdir as githubCiReaddir } from './core/github_ci/readdir.ts'
export { stat as githubCiStat } from './core/github_ci/stat.ts'
export {
  type CIWorkflow,
  listWorkflows as githubCiListWorkflows,
  getWorkflow as githubCiGetWorkflow,
} from './core/github_ci/workflows.ts'
export {
  type CIRun,
  type CIJob,
  listRuns as githubCiListRuns,
  getRun as githubCiGetRun,
  listJobsForRun as githubCiListJobsForRun,
  getJob as githubCiGetJob,
  downloadJobLog as githubCiDownloadJobLog,
} from './core/github_ci/runs.ts'
export {
  type CIArtifact,
  listArtifacts as githubCiListArtifacts,
  downloadArtifact as githubCiDownloadArtifact,
} from './core/github_ci/artifacts.ts'
export { listAnnotations as githubCiListAnnotations } from './core/github_ci/annotations.ts'
export { GITHUB_CI_PROMPT } from './resource/github_ci/prompt.ts'
export {
  DOCS_API_BASE,
  DRIVE_API_BASE,
  DRIVE_UPLOAD_BASE,
  GMAIL_API_BASE,
  GoogleApiError,
  SHEETS_API_BASE,
  SLIDES_API_BASE,
  TOKEN_BUFFER_SECONDS,
  TOKEN_URL,
  TokenManager,
  docsBase,
  driveBase,
  driveUploadBase,
  sheetsBase,
  slidesBase,
  tokenUrl,
  googleGet,
  googleGetBytes,
  googleGetStream,
  googleHeaders,
  googlePost,
  googlePut,
  refreshAccessToken,
} from './core/google/_client.ts'
export {
  GoogleConfigSchema,
  normalizeGoogleConfig,
  redactGoogleConfig,
  type GoogleConfig,
  type GoogleConfigRedacted,
} from './core/google/config.ts'
export {
  MIME_TO_EXT,
  WORKSPACE_MIMES,
  type DriveFile,
  type DriveOwner,
  downloadFile as googleDriveDownloadFile,
  downloadFileStream as googleDriveDownloadFileStream,
  listAllFiles as googleDriveListAllFiles,
  listFiles as googleDriveListFiles,
} from './core/google/drive.ts'
export { GDocsAccessor } from './accessor/gdocs.ts'
export { GDOCS_COMMANDS } from './commands/builtin/gdocs/index.ts'
export { GDOCS_OPS } from './ops/gdocs/index.ts'
export {
  read as gdocsRead,
  stream as gdocsStream,
  readDoc as gdocsReadDoc,
} from './core/gdocs/read.ts'
export { readdir as gdocsReaddir } from './core/gdocs/readdir.ts'
export { stat as gdocsStat } from './core/gdocs/stat.ts'
export { appendText as gdocsAppendText } from './core/gdocs/write.ts'
export { GDOCS_PROMPT, GDOCS_WRITE_PROMPT } from './resource/gdocs/prompt.ts'
export {
  type DocEntry,
  makeFilename as gdocsMakeFilename,
  sanitizeTitle as gdocsSanitizeTitle,
} from './resource/gdocs/doc_entry.ts'
export { GSheetsAccessor } from './accessor/gsheets.ts'
export { GSHEETS_COMMANDS } from './commands/builtin/gsheets/index.ts'
export { GSHEETS_OPS } from './ops/gsheets/index.ts'
export {
  read as gsheetsRead,
  stream as gsheetsStream,
  readSpreadsheet as gsheetsReadSpreadsheet,
  readValues as gsheetsReadValues,
} from './core/gsheets/read.ts'
export { readdir as gsheetsReaddir } from './core/gsheets/readdir.ts'
export { stat as gsheetsStat } from './core/gsheets/stat.ts'
export { appendValues as gsheetsAppendValues, SheetsApiError } from './core/gsheets/write.ts'
export { GSHEETS_PROMPT, GSHEETS_WRITE_PROMPT } from './resource/gsheets/prompt.ts'
export {
  type SheetEntry,
  makeFilename as gsheetsMakeFilename,
  sanitizeTitle as gsheetsSanitizeTitle,
} from './resource/gsheets/sheet_entry.ts'
export { GSlidesAccessor } from './accessor/gslides.ts'
export { GSLIDES_COMMANDS } from './commands/builtin/gslides/index.ts'
export { GSLIDES_OPS } from './ops/gslides/index.ts'
export {
  read as gslidesRead,
  stream as gslidesStream,
  readPresentation as gslidesReadPresentation,
} from './core/gslides/read.ts'
export { readdir as gslidesReaddir } from './core/gslides/readdir.ts'
export { stat as gslidesStat } from './core/gslides/stat.ts'
export { GSLIDES_PROMPT, GSLIDES_WRITE_PROMPT } from './resource/gslides/prompt.ts'
export {
  type SlideEntry,
  makeFilename as gslidesMakeFilename,
  sanitizeTitle as gslidesSanitizeTitle,
} from './resource/gslides/slide_entry.ts'
export { GoogleApiAccessor } from './accessor/google_api.ts'
export { GDriveAccessor } from './accessor/gdrive.ts'
export { GDRIVE_COMMANDS } from './commands/builtin/gdrive/index.ts'
export { GDRIVE_OPS } from './ops/gdrive/index.ts'
export {
  read as gdriveRead,
  stream as gdriveStream,
  readBytes as gdriveReadBytes,
} from './core/gdrive/read.ts'
export { readdir as gdriveReaddir } from './core/gdrive/readdir.ts'
export { stat as gdriveStat } from './core/gdrive/stat.ts'
export { GDRIVE_PROMPT } from './resource/gdrive/prompt.ts'
export {
  DROPBOX_API_BASE,
  DROPBOX_CONTENT_BASE,
  DROPBOX_TOKEN_URL,
  DropboxApiError,
  DropboxTokenManager,
  type DropboxConfig,
  dropboxAuthHeaders,
  dropboxDownload,
  dropboxDownloadStream,
  dropboxRpc,
  refreshAccessToken as dropboxRefreshAccessToken,
} from './core/dropbox/_client.ts'
export {
  type DropboxEntry,
  type DropboxEntryTag,
  getMetadata as dropboxGetMetadata,
  listFolder as dropboxListFolder,
  searchFiles as dropboxSearchFiles,
} from './core/dropbox/api.ts'
export { DropboxAccessor } from './accessor/dropbox.ts'
export { DROPBOX_COMMANDS } from './commands/builtin/dropbox/index.ts'
export { DROPBOX_OPS } from './ops/dropbox/index.ts'
export { read as dropboxRead, stream as dropboxStream } from './core/dropbox/read.ts'
export { readdir as dropboxReaddir } from './core/dropbox/readdir.ts'
export { stat as dropboxStat } from './core/dropbox/stat.ts'
export { DROPBOX_PROMPT } from './resource/dropbox/prompt.ts'
export {
  BOX_API_BASE,
  BOX_TOKEN_URL,
  BoxApiError,
  BoxTokenManager,
  type BoxConfig,
  boxAuthHeaders,
  boxGet,
  boxGetBytes,
  boxGetStream,
  refreshAccessToken as boxRefreshAccessToken,
} from './core/box/_client.ts'
export {
  type BoxItem,
  type BoxItemType,
  downloadFile as boxDownloadFile,
  downloadFileStream as boxDownloadFileStream,
  listFolderItems as boxListFolderItems,
  searchItems as boxSearchItems,
  getExtractedText as boxGetExtractedText,
} from './core/box/api.ts'
export { BoxAccessor } from './accessor/box.ts'
export { BOX_COMMANDS } from './commands/builtin/box/index.ts'
export { BOX_OPS } from './ops/box/index.ts'
export { read as boxRead, stream as boxStream } from './core/box/read.ts'
export { readdir as boxReaddir } from './core/box/readdir.ts'
export { stat as boxStat } from './core/box/stat.ts'
export { BOX_PROMPT } from './resource/box/prompt.ts'
export {
  type BoxnoteParagraph,
  type BoxnoteProcessed,
  processBoxnote,
} from './core/filetype/boxnote.ts'
export {
  type BoxcanvasProcessed,
  type BoxcanvasProcessedWidget,
  processBoxcanvas,
} from './core/filetype/boxcanvas.ts'
export { GmailAccessor } from './accessor/gmail.ts'
export { GMAIL_COMMANDS } from './commands/builtin/gmail/index.ts'
export { GMAIL_OPS } from './ops/gmail/index.ts'
export { read as gmailRead } from './core/gmail/read.ts'
export { readdir as gmailReaddir } from './core/gmail/readdir.ts'
export { stat as gmailStat } from './core/gmail/stat.ts'
export { type GmailScope, detectScope as gmailDetectScope } from './core/gmail/scope.ts'
export { listLabels as gmailListLabels, type GmailLabel } from './core/gmail/labels.ts'
export {
  decodeBody as gmailDecodeBody,
  extractAttachments as gmailExtractAttachments,
  extractHeader as gmailExtractHeader,
  getAttachment as gmailGetAttachment,
  getMessageProcessed as gmailGetMessageProcessed,
  getMessageRaw as gmailGetMessageRaw,
  listMessages as gmailListMessages,
  parseAddress as gmailParseAddress,
  parseAddressList as gmailParseAddressList,
  type GmailAddress,
  type GmailAttachmentInfo,
  type GmailHeader,
  type GmailMessageProcessed,
  type GmailMessageRaw,
  type GmailMessageStub,
  type GmailPayload,
} from './core/gmail/messages.ts'
export {
  forwardMessage as gmailForwardMessage,
  replyAllMessage as gmailReplyAllMessage,
  replyMessage as gmailReplyMessage,
  sendMessage as gmailSendMessage,
} from './core/gmail/send.ts'
export {
  formatGrepResults as gmailFormatGrepResults,
  searchMessages as gmailSearchMessages,
  type GmailSearchRow,
} from './core/gmail/search.ts'
export { GMAIL_PROMPT, GMAIL_WRITE_PROMPT } from './resource/gmail/prompt.ts'
export { loadOptionalPeer, type OptionalPeerConfig } from './utils/optional_peer.ts'
export {
  type FieldNormalizer,
  normalizeFields,
  snakeToCamel,
  type ValueTransform,
} from './utils/normalize.ts'
export type { PgDriver, PgQueryResult } from './core/postgres/_driver.ts'
export { PostgresAccessor } from './accessor/postgres.ts'
export {
  normalizePostgresConfig,
  resolvePostgresConfig,
  type PostgresConfig,
  type PostgresConfigResolved,
} from './resource/postgres/config.ts'
export { POSTGRES_PROMPT } from './resource/postgres/prompt.ts'
export { POSTGRES_OPS } from './ops/postgres/index.ts'
export { POSTGRES_COMMANDS } from './commands/builtin/postgres/index.ts'
export { read as postgresRead } from './core/postgres/read.ts'
export { readdir as postgresReaddir } from './core/postgres/readdir.ts'
export { stat as postgresStat } from './core/postgres/stat.ts'
export { detectScope as detectPostgresScope } from './core/postgres/scope.ts'
export {
  formatGrepResults as postgresFormatGrepResults,
  searchDatabase as postgresSearchDatabase,
  searchEntity as postgresSearchEntity,
  searchKind as postgresSearchKind,
  searchSchema as postgresSearchSchema,
} from './core/postgres/search.ts'
export type {
  MongoCollectionSpec,
  MongoDriver,
  MongoFindOptions,
  MongoIndexAccess,
  MongoIterOptions,
} from './core/mongodb/_driver.ts'
export {
  BsonTypeTag,
  EntityKind,
  IndexType,
  KIND_DIR_NAMES,
  KIND_TO_DIR,
  KIND_TO_RESOURCE_TYPE,
  PRIMARY_KEY,
  RESOURCE_TYPE_COLLECTION,
  RESOURCE_TYPE_DATABASE,
  RESOURCE_TYPE_VIEW,
  ScopeLevel,
} from './core/mongodb/types.ts'
export { MongoDBAccessor } from './accessor/mongodb.ts'
export {
  normalizeMongoDBConfig,
  resolveMongoDBConfig,
  type MongoDBConfig,
  type MongoDBConfigResolved,
} from './resource/mongodb/config.ts'
export { MONGODB_PROMPT } from './resource/mongodb/prompt.ts'
export { MONGODB_OPS } from './ops/mongodb/index.ts'
export { MONGODB_COMMANDS } from './commands/builtin/mongodb/index.ts'
export { read as mongoRead } from './core/mongodb/read.ts'
export { readdir as mongoReaddir } from './core/mongodb/readdir.ts'
export { stat as mongoStat } from './core/mongodb/stat.ts'
export { detectScope as detectMongoScope, type MongoDBScope } from './core/mongodb/scope.ts'
export type { LanceDriver, LanceRow } from './core/lancedb/_driver.ts'
export { LanceDBAccessor } from './accessor/lancedb.ts'
export {
  resolveLanceDBConfig,
  type LanceDBConfig,
  type LanceDBConfigResolved,
} from './resource/lancedb/config.ts'
export { LANCEDB_PROMPT } from './resource/lancedb/prompt.ts'
export { LANCEDB_OPS } from './ops/lancedb/index.ts'
export { LANCEDB_COMMANDS } from './commands/builtin/lancedb/index.ts'
export { read as lanceRead } from './core/lancedb/read.ts'
export { readdir as lanceReaddir } from './core/lancedb/readdir.ts'
export { stat as lanceStat } from './core/lancedb/stat.ts'
export { searchRowsOutput as lanceSearch } from './core/lancedb/search.ts'
export {
  detectScope as detectLanceScope,
  ScopeLevel as LanceScopeLevel,
  type LanceDBScope,
} from './core/lancedb/scope.ts'
export { ChromaAccessor } from './accessor/chroma.ts'
export {
  resolveChromaConfig,
  type ChromaConfig,
  type ChromaConfigResolved,
} from './resource/chroma/config.ts'
export { CHROMA_PROMPT } from './resource/chroma/prompt.ts'
export { CHROMA_OPS } from './ops/chroma/index.ts'
export { CHROMA_COMMANDS } from './commands/builtin/chroma/index.ts'
export { ChromaResource, type ChromaResourceOptions } from './resource/chroma/chroma.ts'
export { readBytes as chromaRead, readStream as chromaReadStream } from './core/chroma/read.ts'
export { readdir as chromaReaddir } from './core/chroma/readdir.ts'
export { stat as chromaStat } from './core/chroma/stat.ts'
export { searchSegments as chromaSearch } from './core/chroma/search.ts'
export type { QdrantPoint, QdrantRow } from './core/qdrant/_client.ts'
export { QdrantAccessor } from './accessor/qdrant.ts'
export {
  resolveQdrantConfig,
  type QdrantConfig,
  type QdrantConfigResolved,
} from './resource/qdrant/config.ts'
export { QDRANT_PROMPT } from './resource/qdrant/prompt.ts'
export { QDRANT_OPS } from './ops/qdrant/index.ts'
export { QDRANT_COMMANDS } from './commands/builtin/qdrant/index.ts'
export { QdrantResource, type QdrantResourceOptions } from './resource/qdrant/qdrant.ts'
export { read as qdrantRead } from './core/qdrant/read.ts'
export { readdir as qdrantReaddir } from './core/qdrant/readdir.ts'
export { stat as qdrantStat } from './core/qdrant/stat.ts'
export { searchRowsOutput as qdrantSearch } from './core/qdrant/search.ts'
export { scoreFromDistance } from './utils/score.ts'
export {
  countDocuments as mongoCountDocuments,
  findDocuments as mongoFindDocuments,
  getIndexStats as mongoGetIndexStats,
  getValidator as mongoGetValidator,
  isView as mongoIsView,
  iterDocuments as mongoIterDocuments,
  iterInserts as mongoIterInserts,
  listCollections as mongoListCollections,
  listDatabases as mongoListDatabases,
  listIndexes as mongoListIndexes,
} from './core/mongodb/_client.ts'
export {
  formatGrepResults as mongoFormatGrepResults,
  searchCollection as mongoSearchCollection,
  searchDatabase as mongoSearchDatabase,
  type CollectionMatches as MongoCollectionMatches,
} from './core/mongodb/search.ts'
export { setHttpProxyBase } from './commands/builtin/utils/http.ts'

export { lstripSlash, rstripSlash, stripSlash } from './utils/slash.ts'
export { mountKey, mountPrefixOf, rekey, stripMount } from './utils/key_prefix.ts'
export { fnmatch } from './utils/fnmatch.ts'
export {
  buildTree,
  computeNonemptyDirs,
  emitStartPath,
  type EmitStartPathOptions,
  evalPredicate,
  type FindEntry,
  keep,
  type PredNode,
  startBasename,
} from './commands/builtin/findEval.ts'
export {
  eisdir,
  enoent,
  enotdir,
  errorVirtualPath,
  type FsError,
  gnuStrerror,
} from './utils/errors.ts'

export {
  DatabricksVolumeAccessor,
  type DatabricksVolumeResourceLike,
} from './accessor/databricks_volume.ts'
export {
  DatabricksVolumeConfigSchema,
  normalizeDatabricksVolumeConfig,
  redactDatabricksVolumeConfig,
  type DatabricksVolumeConfig,
  type DatabricksVolumeConfigRedacted,
} from './resource/databricks_volume/config.ts'
export { DATABRICKS_VOLUME_PROMPT } from './resource/databricks_volume/prompt.ts'
export { DATABRICKS_VOLUME_OPS } from './ops/databricks_volume/index.ts'
export { DATABRICKS_VOLUME_COMMANDS } from './commands/builtin/databricks_volume/index.ts'
export {
  DatabricksVolumeApiError,
  isNotFound as isDatabricksVolumeNotFound,
} from './core/databricks_volume/errors.ts'
export { readBytes as databricksVolumeRead } from './core/databricks_volume/read.ts'
export {
  readStream as databricksVolumeReadStream,
  rangeRead as databricksVolumeRangeRead,
} from './core/databricks_volume/stream.ts'
export { readdir as databricksVolumeReaddir } from './core/databricks_volume/readdir.ts'
export { stat as databricksVolumeStat } from './core/databricks_volume/stat.ts'
export { exists as databricksVolumeExists } from './core/databricks_volume/exists.ts'
export { writeBytes as databricksVolumeWrite } from './core/databricks_volume/write.ts'
export { create as databricksVolumeCreate } from './core/databricks_volume/create.ts'
export { mkdir as databricksVolumeMkdir } from './core/databricks_volume/mkdir.ts'
export { rmdir as databricksVolumeRmdir } from './core/databricks_volume/rmdir.ts'
export { unlink as databricksVolumeUnlink } from './core/databricks_volume/unlink.ts'
export { rmRecursive as databricksVolumeRmRecursive } from './core/databricks_volume/rm.ts'
export { copy as databricksVolumeCopy } from './core/databricks_volume/copy.ts'
export { rename as databricksVolumeRename } from './core/databricks_volume/rename.ts'
export {
  backendPath as databricksVolumeBackendPath,
  virtualPath as databricksVolumeVirtualPath,
} from './core/databricks_volume/path.ts'
