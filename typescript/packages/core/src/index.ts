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

export const VERSION = '0.0.0'
export {
  ConsistencyPolicy,
  DEFAULT_AGENT_ID,
  DEFAULT_SESSION_ID,
  DriftPolicy,
  FileStat,
  type FileStatInit,
  FileType,
  MountMode,
  PathSpec,
  type PathSpecInit,
  ResourceName,
} from './types.ts'
export {
  captureFingerprints,
  checkDrift,
  ContentDriftError,
  type FingerprintEntry,
  liveOnlyMountPrefixes,
} from './workspace/snapshot/drift.ts'
export { type FindOptions, type Resource, throwUnsupported } from './resource/base.ts'
export { RAMResource } from './resource/ram/ram.ts'
export { RAMStore } from './resource/ram/store.ts'
export { DevResource } from './resource/dev/dev.ts'
export { DevStore, DevFiles } from './resource/dev/store.ts'
export {
  type ExecuteOptions,
  ExecuteResult,
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
export { extractWriteData } from './ops/write_args.ts'
export { RAM_COMMANDS } from './commands/builtin/ram/index.ts'
export { GENERAL_COMMANDS } from './commands/builtin/general/index.ts'
export { RAM_AWK } from './commands/builtin/ram/awk.ts'
export { RAM_BASE64 } from './commands/builtin/ram/base64_cmd.ts'
export { RAM_BASENAME } from './commands/builtin/ram/basename.ts'
export { GENERAL_BC } from './commands/builtin/general/bc.ts'
export { RAM_CAT } from './commands/builtin/ram/cat/cat.ts'
export { RAM_CAT_FEATHER } from './commands/builtin/ram/cat/cat_feather.ts'
export { RAM_CAT_HDF5 } from './commands/builtin/ram/cat/cat_hdf5.ts'
export { RAM_CAT_PARQUET } from './commands/builtin/ram/cat/cat_parquet.ts'
export { RAM_CMP } from './commands/builtin/ram/cmp.ts'
export { RAM_COLUMN } from './commands/builtin/ram/column.ts'
export { RAM_COMM } from './commands/builtin/ram/comm.ts'
export { RAM_CP } from './commands/builtin/ram/cp.ts'
export { RAM_CSPLIT } from './commands/builtin/ram/csplit.ts'
export { GENERAL_CURL } from './commands/builtin/general/curl.ts'
export { RAM_CUT } from './commands/builtin/ram/cut/cut.ts'
export { RAM_CUT_FEATHER } from './commands/builtin/ram/cut/cut_feather.ts'
export { RAM_CUT_HDF5 } from './commands/builtin/ram/cut/cut_hdf5.ts'
export { RAM_CUT_PARQUET } from './commands/builtin/ram/cut/cut_parquet.ts'
export { GENERAL_DATE } from './commands/builtin/general/date.ts'
export { RAM_DIFF } from './commands/builtin/ram/diff.ts'
export { RAM_DIRNAME } from './commands/builtin/ram/dirname.ts'
export { RAM_DU } from './commands/builtin/ram/du.ts'
export { RAM_EXPAND } from './commands/builtin/ram/expand.ts'
export { GENERAL_EXPR } from './commands/builtin/general/expr.ts'
export { RAM_FILE } from './commands/builtin/ram/file/file.ts'
export { RAM_FILE_FEATHER } from './commands/builtin/ram/file/file_feather.ts'
export { RAM_FILE_HDF5 } from './commands/builtin/ram/file/file_hdf5.ts'
export { RAM_FILE_PARQUET } from './commands/builtin/ram/file/file_parquet.ts'
export { RAM_FIND } from './commands/builtin/ram/find.ts'
export { RAM_FMT } from './commands/builtin/ram/fmt.ts'
export { RAM_FOLD } from './commands/builtin/ram/fold.ts'
export { RAM_GREP } from './commands/builtin/ram/grep/grep.ts'
export { RAM_GREP_FEATHER } from './commands/builtin/ram/grep/grep_feather.ts'
export { RAM_GREP_HDF5 } from './commands/builtin/ram/grep/grep_hdf5.ts'
export { RAM_GREP_PARQUET } from './commands/builtin/ram/grep/grep_parquet.ts'
export { RAM_GUNZIP } from './commands/builtin/ram/gunzip.ts'
export { RAM_GZIP } from './commands/builtin/ram/gzip.ts'
export { RAM_HEAD } from './commands/builtin/ram/head/head.ts'
export { RAM_HEAD_FEATHER } from './commands/builtin/ram/head/head_feather.ts'
export { RAM_HEAD_HDF5 } from './commands/builtin/ram/head/head_hdf5.ts'
export { RAM_HEAD_PARQUET } from './commands/builtin/ram/head/head_parquet.ts'
export { RAM_ICONV } from './commands/builtin/ram/iconv.ts'
export { RAM_JOIN } from './commands/builtin/ram/join.ts'
export { RAM_JQ } from './commands/builtin/ram/jq.ts'
export { RAM_LN } from './commands/builtin/ram/ln.ts'
export { RAM_LOOK } from './commands/builtin/ram/look.ts'
export { RAM_LS } from './commands/builtin/ram/ls/ls.ts'
export { RAM_LS_FEATHER } from './commands/builtin/ram/ls/ls_feather.ts'
export { RAM_LS_HDF5 } from './commands/builtin/ram/ls/ls_hdf5.ts'
export { RAM_LS_PARQUET } from './commands/builtin/ram/ls/ls_parquet.ts'
export { RAM_MD5 } from './commands/builtin/ram/md5.ts'
export { RAM_MKDIR } from './commands/builtin/ram/mkdir.ts'
export { RAM_MKTEMP } from './commands/builtin/ram/mktemp.ts'
export { RAM_MV } from './commands/builtin/ram/mv.ts'
export { RAM_NL } from './commands/builtin/ram/nl.ts'
export { RAM_PASTE } from './commands/builtin/ram/paste.ts'
export { RAM_PATCH } from './commands/builtin/ram/patch.ts'
export { RAM_READLINK } from './commands/builtin/ram/readlink.ts'
export { RAM_REALPATH } from './commands/builtin/ram/realpath.ts'
export { RAM_REV } from './commands/builtin/ram/rev.ts'
export { RAM_RG } from './commands/builtin/ram/rg.ts'
export { RAM_RM } from './commands/builtin/ram/rm.ts'
export { RAM_SED } from './commands/builtin/ram/sed.ts'
export { GENERAL_SEQ } from './commands/builtin/general/seq.ts'
export { RAM_SHA256SUM } from './commands/builtin/ram/sha256sum.ts'
export { RAM_SHUF } from './commands/builtin/ram/shuf.ts'
export { RAM_SORT } from './commands/builtin/ram/sort.ts'
export { RAM_SPLIT } from './commands/builtin/ram/split.ts'
export { RAM_STAT } from './commands/builtin/ram/stat/stat.ts'
export { RAM_STAT_FEATHER } from './commands/builtin/ram/stat/stat_feather.ts'
export { RAM_STAT_HDF5 } from './commands/builtin/ram/stat/stat_hdf5.ts'
export { RAM_STAT_PARQUET } from './commands/builtin/ram/stat/stat_parquet.ts'
export { RAM_STRINGS } from './commands/builtin/ram/strings.ts'
export { RAM_TAC } from './commands/builtin/ram/tac.ts'
export { RAM_TAIL } from './commands/builtin/ram/tail/tail.ts'
export { RAM_TAIL_FEATHER } from './commands/builtin/ram/tail/tail_feather.ts'
export { RAM_TAIL_HDF5 } from './commands/builtin/ram/tail/tail_hdf5.ts'
export { RAM_TAIL_PARQUET } from './commands/builtin/ram/tail/tail_parquet.ts'
export { RAM_TAR } from './commands/builtin/ram/tar.ts'
export { RAM_TEE } from './commands/builtin/ram/tee.ts'
export { RAM_TOUCH } from './commands/builtin/ram/touch.ts'
export { RAM_TR } from './commands/builtin/ram/tr.ts'
export { RAM_TREE } from './commands/builtin/ram/tree.ts'
export { RAM_TSORT } from './commands/builtin/ram/tsort.ts'
export { RAM_UNEXPAND } from './commands/builtin/ram/unexpand.ts'
export { RAM_UNIQ } from './commands/builtin/ram/uniq.ts'
export { RAM_UNZIP } from './commands/builtin/ram/unzip.ts'
export { RAM_WC } from './commands/builtin/ram/wc/wc.ts'
export { RAM_WC_FEATHER } from './commands/builtin/ram/wc/wc_feather.ts'
export { RAM_WC_HDF5 } from './commands/builtin/ram/wc/wc_hdf5.ts'
export { RAM_WC_PARQUET } from './commands/builtin/ram/wc/wc_parquet.ts'
export { GENERAL_WGET } from './commands/builtin/general/wget.ts'
export { RAM_XXD } from './commands/builtin/ram/xxd.ts'
export { RAM_ZCAT } from './commands/builtin/ram/zcat.ts'
export { RAM_ZGREP } from './commands/builtin/ram/zgrep.ts'
export { RAM_ZIP } from './commands/builtin/ram/zip_cmd.ts'
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
  resolvePath,
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
  peekExitCode,
  quietMatch,
  wrapCachableStreams,
  yieldBytes,
} from './io/stream.ts'
export { OpRecord, type OpRecordInit } from './observe/record.ts'
export { LogEntry, type LogEntryInit } from './observe/log_entry.ts'
export { Observer } from './observe/observer.ts'
export {
  record,
  recordStream,
  revisionFor,
  runWithRecording,
  runWithRevisions,
  setVirtualPrefix,
} from './observe/context.ts'
export { guessType } from './utils/filetype.ts'
export { Accessor, NOOPAccessor, RAMAccessor } from './accessor/index.ts'
export { cat as featherCat, describe as featherDescribe } from './core/filetype/feather.ts'
export { cat as hdf5Cat, describe as hdf5Describe } from './core/filetype/hdf5.ts'
export { cat as parquetCat, describe as parquetDescribe } from './core/filetype/parquet.ts'
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
} from './commands/builtin/grep_helper.ts'
export { grepContextLines } from './commands/builtin/grep_context.ts'
export {
  type AsyncReaddirFn,
  type AsyncReadBytesFn,
  type AsyncStatFn,
  type FiletypeFn,
  rgFolderFiletype,
  type RgFolderFiletypeOptions,
  rgFull,
  type RgFullOptions,
  rgMatchesFilter,
  TYPE_EXTENSIONS,
} from './commands/builtin/rg_helper.ts'
export { compareKeys, sortKey, type SortKeyOptions } from './commands/builtin/sort_helper.ts'
export { countNewlines, parseN, tailBytes } from './commands/builtin/tail_helper.ts'
export { AsyncLineIterator } from './io/async_line_iterator.ts'
export { readStdinAsync, resolveSource, wrapBytes } from './commands/builtin/utils/stream.ts'
export { formatLsLong, humanSize } from './commands/builtin/utils/formatting.ts'
export { grepFilesOnly, grepRecursive } from './commands/builtin/grep_helper.ts'
export { interpretEscapes } from './commands/builtin/utils/escapes.ts'
export { deflateRaw, gunzip, gzip, inflateRaw } from './utils/compress.ts'
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
export { edScript, unifiedDiff } from './commands/builtin/diff_helper.ts'
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
  ls as featherLs,
  lsFallback as featherLsFallback,
  stat as featherStat,
  tail as featherTail,
  wc as featherWc,
} from './core/filetype/feather.ts'
export {
  cut as hdf5Cut,
  grep as hdf5Grep,
  head as hdf5Head,
  ls as hdf5Ls,
  lsFallback as hdf5LsFallback,
  stat as hdf5Stat,
  tail as hdf5Tail,
  wc as hdf5Wc,
} from './core/filetype/hdf5.ts'
export {
  cut as parquetCut,
  grep as parquetGrep,
  head as parquetHead,
  ls as parquetLs,
  lsFallback as parquetLsFallback,
  stat as parquetStat,
  tail as parquetTail,
  wc as parquetWc,
} from './core/filetype/parquet.ts'
export { Precision, ProvisionResult, type ProvisionResultInit } from './provision/types.ts'
export { IndexEntry, type IndexEntryInit, ResourceType } from './cache/index/config.ts'
export { type FileCache } from './cache/file/mixin.ts'
export { CacheEntry, type CacheEntryInit } from './cache/file/entry.ts'
export { defaultFingerprint, parseLimit } from './cache/file/utils.ts'
export { RAMFileCacheStore } from './cache/file/ram.ts'
export {
  LookupStatus,
  type IndexConfig,
  type ListResult,
  type LookupResult,
} from './cache/index/config.ts'
export { IndexCacheStore } from './cache/index/store.ts'
export { RAMIndexCacheStore } from './cache/index/ram.ts'
export { ExecutionHistory, type ExecutionHistoryOptions } from './workspace/history.ts'
export {
  ExecutionNode,
  type ExecutionNodeInit,
  ExecutionRecord,
  type ExecutionRecordInit,
} from './workspace/types.ts'
export { Session, type SessionInit } from './workspace/session/session.ts'
export { SessionManager } from './workspace/session/manager.ts'
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
} from './workspace/executor/builtins.ts'
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
export { MountRegistry } from './workspace/mount/registry.ts'
export { Mount, type MountInit } from './workspace/mount/mount.ts'
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
  resolveFirstPath,
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
  posixNormpath,
  safeEval,
  shlexSplit,
  type TSNodeLike,
  unescapePath,
} from './workspace/expand/index.ts'
export { resolveGlobs, type ResourceWithGlob } from './workspace/node/resolve_globs.ts'
export { expandTestExpr } from './workspace/node/test_expr.ts'
export { executeNode, type ExecuteNodeDeps } from './workspace/node/execute_node.ts'
export { S3Accessor, type S3ResourceLike } from './accessor/s3.ts'
export {
  redactConfig as redactS3Config,
  type S3BrowserOperation,
  type S3BrowserPresignedUrlProvider,
  type S3BrowserSignOptions,
  type S3Config,
  type S3ConfigRedacted,
} from './resource/s3/config.ts'
export { S3_PROMPT } from './resource/s3/prompt.ts'
export { SCOPE_ERROR as S3_SCOPE_ERROR } from './core/s3/constants.ts'
export { S3IndexEntry, type S3IndexEntryInit, type S3Object } from './core/s3/entry.ts'
export { copy } from './core/s3/copy.ts'
export { create } from './core/s3/create.ts'
export { du, duAll } from './core/s3/du.ts'
export { exists } from './core/s3/exists.ts'
export { find } from './core/s3/find.ts'
export { resolveGlob as resolveS3Glob } from './core/s3/glob.ts'
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
  fileReadProvision as s3FileReadProvision,
  headTailProvision as s3HeadTailProvision,
  metadataProvision as s3MetadataProvision,
} from './commands/builtin/s3/provision.ts'
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
export { SLACK_VFS_OPS } from './ops/slack/index.ts'
export { read as slackRead } from './core/slack/read.ts'
export { readdir as slackReaddir } from './core/slack/readdir.ts'
export { stat as slackStat } from './core/slack/stat.ts'
export { resolveSlackGlob } from './core/slack/glob.ts'
export { SLACK_PROMPT, SLACK_WRITE_PROMPT } from './resource/slack/prompt.ts'
export { DISCORD_COMMANDS } from './commands/builtin/discord/index.ts'
export { DISCORD_VFS_OPS } from './ops/discord/index.ts'
export { read as discordRead } from './core/discord/read.ts'
export { readdir as discordReaddir } from './core/discord/readdir.ts'
export { stat as discordStat } from './core/discord/stat.ts'
export { resolveDiscordGlob } from './core/discord/glob.ts'
export { DISCORD_PROMPT, DISCORD_WRITE_PROMPT } from './resource/discord/prompt.ts'
export {
  HttpTrelloTransport,
  type HttpTrelloTransportOptions,
  TrelloApiError,
  type TrelloTransport,
} from './core/trello/_client.ts'
export { TrelloAccessor, type TrelloResourceLike } from './accessor/trello.ts'
export { TRELLO_COMMANDS } from './commands/builtin/trello/index.ts'
export { TRELLO_VFS_OPS } from './ops/trello/index.ts'
export {
  HttpLinearTransport,
  type HttpLinearTransportOptions,
  LinearApiError,
  type LinearTransport,
} from './core/linear/_client.ts'
export { LinearAccessor, type LinearResourceLike } from './accessor/linear.ts'
export { LINEAR_COMMANDS } from './commands/builtin/linear/index.ts'
export { LINEAR_VFS_OPS } from './ops/linear/index.ts'
export { read as linearRead } from './core/linear/read.ts'
export { readdir as linearReaddir, type LinearReaddirFilter } from './core/linear/readdir.ts'
export { stat as linearStat } from './core/linear/stat.ts'
export { resolveLinearGlob } from './core/linear/glob.ts'
export { LINEAR_PROMPT, LINEAR_WRITE_PROMPT } from './resource/linear/prompt.ts'
export { NotionAccessor, type NotionResourceLike } from './accessor/notion.ts'
export {
  MCPNotionTransport,
  NotionMCPError,
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
export { resolveNotionGlob } from './core/notion/glob.ts'
export { NOTION_PROMPT, NOTION_WRITE_PROMPT } from './resource/notion/prompt.ts'
export { NOTION_COMMANDS } from './commands/builtin/notion/index.ts'
export { NOTION_VFS_OPS } from './ops/notion/index.ts'
export {
  HttpLangfuseTransport,
  type HttpLangfuseTransportOptions,
  LangfuseApiError,
  type LangfuseTransport,
} from './core/langfuse/_client.ts'
export { LangfuseAccessor, type LangfuseResourceLike } from './accessor/langfuse.ts'
export { LANGFUSE_COMMANDS } from './commands/builtin/langfuse/index.ts'
export { LANGFUSE_VFS_OPS } from './ops/langfuse/index.ts'
export { read as langfuseRead } from './core/langfuse/read.ts'
export { readdir as langfuseReaddir } from './core/langfuse/readdir.ts'
export { stat as langfuseStat } from './core/langfuse/stat.ts'
export { resolveLangfuseGlob } from './core/langfuse/glob.ts'
export { LANGFUSE_PROMPT } from './resource/langfuse/prompt.ts'
export { detectScope as langfuseDetectScope, type LangfuseScope } from './core/langfuse/scope.ts'
export { read as trelloRead } from './core/trello/read.ts'
export { readdir as trelloReaddir, type TrelloReaddirFilter } from './core/trello/readdir.ts'
export { stat as trelloStat } from './core/trello/stat.ts'
export { resolveTrelloGlob } from './core/trello/glob.ts'
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
export { GITHUB_VFS_OPS } from './ops/github/index.ts'
export { read as githubRead, stream as githubStream } from './core/github/read.ts'
export { readdir as githubReaddir } from './core/github/readdir.ts'
export { stat as githubStat } from './core/github/stat.ts'
export { resolveGlob as githubResolveGlob } from './core/github/glob.ts'
export {
  type TreeEntry as GitHubTreeEntry,
  makeTreeEntry as githubMakeTreeEntry,
  indexEntryFromTree as githubIndexEntryFromTree,
} from './core/github/entry.ts'
export {
  search as githubSearchCode,
  narrowPaths as githubNarrowPaths,
} from './core/github/search.ts'
export { GITHUB_PROMPT } from './resource/github/prompt.ts'
export { type CITransport, HttpCITransport } from './core/github_ci/_client.ts'
export { GitHubCIAccessor, type GitHubCIResourceLike } from './accessor/github_ci.ts'
export { GITHUB_CI_COMMANDS } from './commands/builtin/github_ci/index.ts'
export { GITHUB_CI_VFS_OPS } from './ops/github_ci/index.ts'
export { read as githubCiRead, stream as githubCiStream } from './core/github_ci/read.ts'
export { readdir as githubCiReaddir } from './core/github_ci/readdir.ts'
export { stat as githubCiStat } from './core/github_ci/stat.ts'
export { resolveGlob as githubCiResolveGlob } from './core/github_ci/glob.ts'
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
  GMAIL_API_BASE,
  GoogleApiError,
  SHEETS_API_BASE,
  SLIDES_API_BASE,
  TOKEN_BUFFER_SECONDS,
  TOKEN_URL,
  TokenManager,
  googleGet,
  googleGetBytes,
  googleGetStream,
  googleHeaders,
  googlePost,
  googlePut,
  refreshAccessToken,
} from './core/google/_client.ts'
export type { GoogleConfig } from './core/google/config.ts'
export {
  MIME_TO_EXT,
  WORKSPACE_MIMES,
  type DriveFile,
  type DriveOwner,
  downloadFile as googleDriveDownloadFile,
  downloadFileStream as googleDriveDownloadFileStream,
  getFileMetadata as googleDriveGetFileMetadata,
  listAllFiles as googleDriveListAllFiles,
  listFiles as googleDriveListFiles,
} from './core/google/drive.ts'
export { GDocsAccessor } from './accessor/gdocs.ts'
export { GDOCS_COMMANDS } from './commands/builtin/gdocs/index.ts'
export { GDOCS_VFS_OPS } from './ops/gdocs/index.ts'
export {
  read as gdocsRead,
  stream as gdocsStream,
  readDoc as gdocsReadDoc,
} from './core/gdocs/read.ts'
export { readdir as gdocsReaddir } from './core/gdocs/readdir.ts'
export { stat as gdocsStat } from './core/gdocs/stat.ts'
export { resolveGlob as gdocsResolveGlob } from './core/gdocs/glob.ts'
export { appendText as gdocsAppendText } from './core/gdocs/write.ts'
export { batchUpdate as gdocsBatchUpdate } from './core/gdocs/update.ts'
export { createDoc as gdocsCreateDoc } from './core/gdocs/create.ts'
export { GDOCS_PROMPT, GDOCS_WRITE_PROMPT } from './resource/gdocs/prompt.ts'
export {
  type DocEntry,
  makeFilename as gdocsMakeFilename,
  sanitizeTitle as gdocsSanitizeTitle,
} from './resource/gdocs/doc_entry.ts'
export { GSheetsAccessor } from './accessor/gsheets.ts'
export { GSHEETS_COMMANDS } from './commands/builtin/gsheets/index.ts'
export { GSHEETS_VFS_OPS } from './ops/gsheets/index.ts'
export {
  read as gsheetsRead,
  stream as gsheetsStream,
  readSpreadsheet as gsheetsReadSpreadsheet,
  readValues as gsheetsReadValues,
  fetchSheetNames as gsheetsFetchSheetNames,
} from './core/gsheets/read.ts'
export { readdir as gsheetsReaddir } from './core/gsheets/readdir.ts'
export { stat as gsheetsStat } from './core/gsheets/stat.ts'
export { resolveGlob as gsheetsResolveGlob } from './core/gsheets/glob.ts'
export {
  writeValues as gsheetsWriteValues,
  appendValues as gsheetsAppendValues,
  SheetsApiError,
} from './core/gsheets/write.ts'
export { batchUpdate as gsheetsBatchUpdate } from './core/gsheets/update.ts'
export { createSpreadsheet as gsheetsCreateSpreadsheet } from './core/gsheets/create.ts'
export { GSHEETS_PROMPT, GSHEETS_WRITE_PROMPT } from './resource/gsheets/prompt.ts'
export {
  type SheetEntry,
  makeFilename as gsheetsMakeFilename,
  sanitizeTitle as gsheetsSanitizeTitle,
} from './resource/gsheets/sheet_entry.ts'
export { GSlidesAccessor } from './accessor/gslides.ts'
export { GSLIDES_COMMANDS } from './commands/builtin/gslides/index.ts'
export { GSLIDES_VFS_OPS } from './ops/gslides/index.ts'
export {
  read as gslidesRead,
  stream as gslidesStream,
  readPresentation as gslidesReadPresentation,
} from './core/gslides/read.ts'
export { readdir as gslidesReaddir } from './core/gslides/readdir.ts'
export { stat as gslidesStat } from './core/gslides/stat.ts'
export { resolveGlob as gslidesResolveGlob } from './core/gslides/glob.ts'
export { batchUpdate as gslidesBatchUpdate } from './core/gslides/update.ts'
export { createPresentation as gslidesCreatePresentation } from './core/gslides/create.ts'
export { GSLIDES_PROMPT, GSLIDES_WRITE_PROMPT } from './resource/gslides/prompt.ts'
export {
  type SlideEntry,
  makeFilename as gslidesMakeFilename,
  sanitizeTitle as gslidesSanitizeTitle,
} from './resource/gslides/slide_entry.ts'
export { GoogleApiAccessor } from './accessor/google_api.ts'
export { GDriveAccessor } from './accessor/gdrive.ts'
export { GDRIVE_COMMANDS } from './commands/builtin/gdrive/index.ts'
export { GDRIVE_VFS_OPS } from './ops/gdrive/index.ts'
export {
  read as gdriveRead,
  stream as gdriveStream,
  readBytes as gdriveReadBytes,
} from './core/gdrive/read.ts'
export { readdir as gdriveReaddir } from './core/gdrive/readdir.ts'
export { stat as gdriveStat } from './core/gdrive/stat.ts'
export { resolveGlob as gdriveResolveGlob } from './core/gdrive/glob.ts'
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
export { DROPBOX_VFS_OPS } from './ops/dropbox/index.ts'
export { read as dropboxRead, stream as dropboxStream } from './core/dropbox/read.ts'
export { readdir as dropboxReaddir } from './core/dropbox/readdir.ts'
export { stat as dropboxStat } from './core/dropbox/stat.ts'
export { resolveGlob as dropboxResolveGlob } from './core/dropbox/glob.ts'
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
  getFileMetadata as boxGetFileMetadata,
  getFolderMetadata as boxGetFolderMetadata,
  listFolderItems as boxListFolderItems,
  searchItems as boxSearchItems,
  getExtractedText as boxGetExtractedText,
} from './core/box/api.ts'
export { BoxAccessor } from './accessor/box.ts'
export { BOX_COMMANDS } from './commands/builtin/box/index.ts'
export { BOX_VFS_OPS } from './ops/box/index.ts'
export { read as boxRead, stream as boxStream } from './core/box/read.ts'
export { readdir as boxReaddir } from './core/box/readdir.ts'
export { stat as boxStat } from './core/box/stat.ts'
export { resolveGlob as boxResolveGlob } from './core/box/glob.ts'
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
export { GMAIL_VFS_OPS } from './ops/gmail/index.ts'
export { read as gmailRead } from './core/gmail/read.ts'
export { readdir as gmailReaddir } from './core/gmail/readdir.ts'
export { stat as gmailStat } from './core/gmail/stat.ts'
export { resolveGlob as gmailResolveGlob } from './core/gmail/glob.ts'
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
export { catProvision } from './commands/builtin/ram/cat/cat.ts'
export { headProvision } from './commands/builtin/ram/head/head.ts'
export { jqProvision } from './commands/builtin/ram/jq.ts'
export { statProvision } from './commands/builtin/ram/stat/stat.ts'
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
export { resolveGlob as resolvePostgresGlob } from './core/postgres/glob.ts'
export { detectScope as detectPostgresScope } from './core/postgres/scope.ts'
export {
  formatGrepResults as postgresFormatGrepResults,
  searchDatabase as postgresSearchDatabase,
  searchEntity as postgresSearchEntity,
  searchKind as postgresSearchKind,
  searchSchema as postgresSearchSchema,
} from './core/postgres/search.ts'
export type { MongoDriver, MongoFindOptions } from './core/mongodb/_driver.ts'
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
export { resolveGlob as resolveMongoGlob } from './core/mongodb/glob.ts'
export { detectScope as detectMongoScope, type MongoDBScope } from './core/mongodb/scope.ts'
export {
  countDocuments as mongoCountDocuments,
  findDocuments as mongoFindDocuments,
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
export type {
  SSCholarAuthor,
  SSCholarDriver,
  SSCholarPaper,
  SSCholarSearchOptions,
  SSCholarSearchResult,
  SSCholarSnippet,
  SSCholarSnippetMatch,
  SSCholarSnippetSearchResult,
  SSCholarTLDR,
} from './core/sscholar/_driver.ts'
export { SSCholarAccessor } from './accessor/sscholar.ts'
export {
  normalizeSSCholarConfig,
  resolveSSCholarConfig,
  type SSCholarConfig,
  type SSCholarConfigResolved,
} from './resource/sscholar/config.ts'
export { SSCHOLAR_PAPER_PROMPT } from './resource/sscholar/prompt.ts'
export { SSCHOLAR_PAPER_OPS } from './ops/sscholar/index.ts'
export { SSCHOLAR_PAPER_COMMANDS } from './commands/builtin/sscholar/index.ts'
export { read as sscholarPaperRead } from './core/sscholar/read.ts'
export { readdir as sscholarPaperReaddir } from './core/sscholar/readdir.ts'
export { stat as sscholarPaperStat } from './core/sscholar/stat.ts'
export { resolveGlob as resolveSSCholarPaperGlob } from './core/sscholar/glob.ts'
export {
  detectScope as detectSSCholarPaperScope,
  type SSCholarPaperScope,
  type SSCholarPaperLevel,
} from './core/sscholar/scope.ts'
export {
  PAPER_FILES as SSCHOLAR_PAPER_FILES,
  SSCHOLAR_FIELDS,
  SSCHOLAR_FIELD_SLUGS,
  SSCHOLAR_YEARS,
  fieldToSlug as sscholarFieldToSlug,
  slugToField as sscholarSlugToField,
} from './core/sscholar/fields.ts'
export {
  getPaper as sscholarGetPaper,
  searchPapers as sscholarSearchPapers,
  searchPapersByField as sscholarSearchPapersByField,
  searchSnippets as sscholarSearchSnippets,
} from './core/sscholar/_client.ts'
export { HttpSSCholarDriver, type HttpSSCholarDriverOptions } from './core/sscholar/http_driver.ts'
export type {
  SSCholarAuthorPapersOptions,
  SSCholarAuthorPapersResult,
  SSCholarAuthorProfile,
  SSCholarAuthorSearchResult,
} from './core/sscholar/author_driver.ts'
export { SSCHOLAR_AUTHOR_PROMPT } from './resource/sscholar/author_prompt.ts'
export { SSCHOLAR_AUTHOR_OPS } from './ops/sscholar_author/index.ts'
export { SSCHOLAR_AUTHOR_COMMANDS } from './commands/builtin/sscholar_author/index.ts'
export { read as sscholarAuthorRead } from './core/sscholar/author_read.ts'
export { readdir as sscholarAuthorReaddir } from './core/sscholar/author_readdir.ts'
export { stat as sscholarAuthorStat } from './core/sscholar/author_stat.ts'
export { resolveGlob as resolveSSCholarAuthorGlob } from './core/sscholar/author_glob.ts'
export {
  detectAuthorScope as detectSSCholarAuthorScope,
  AUTHOR_FILES as SSCHOLAR_AUTHOR_FILES,
  type SSCholarAuthorScope,
  type SSCholarAuthorLevel,
} from './core/sscholar/author_scope.ts'
export {
  getAuthor as sscholarGetAuthor,
  getAuthorPapers as sscholarGetAuthorPapers,
  searchAuthors as sscholarSearchAuthors,
} from './core/sscholar/author_client.ts'

export type {
  VercelDeployment,
  VercelDeploymentEvent,
  VercelDomain,
  VercelDriver,
  VercelEnvVar,
  VercelListOptions,
  VercelProject,
  VercelTeam,
  VercelTeamMember,
  VercelUser,
} from './core/vercel/_driver.ts'
export { VercelAccessor } from './accessor/vercel.ts'
export {
  normalizeVercelConfig,
  resolveVercelConfig,
  type VercelConfig,
  type VercelConfigResolved,
} from './resource/vercel/config.ts'
export { VERCEL_PROMPT } from './resource/vercel/prompt.ts'
export { VERCEL_OPS } from './ops/vercel/index.ts'
export { VERCEL_COMMANDS } from './commands/builtin/vercel/index.ts'
export { read as vercelRead } from './core/vercel/read.ts'
export { readdir as vercelReaddir } from './core/vercel/readdir.ts'
export { stat as vercelStat } from './core/vercel/stat.ts'
export { resolveGlob as resolveVercelGlob } from './core/vercel/glob.ts'
export {
  detectScope as detectVercelScope,
  type VercelScope,
  type VercelLevel,
  ROOT_ENTRIES as VERCEL_ROOT_ENTRIES,
  TEAM_FILES as VERCEL_TEAM_FILES,
  PROJECT_FILES as VERCEL_PROJECT_FILES,
  PROJECT_SUBDIRS as VERCEL_PROJECT_SUBDIRS,
  DEPLOYMENT_FILES as VERCEL_DEPLOYMENT_FILES,
} from './core/vercel/scope.ts'
export {
  getUser as vercelGetUser,
  listTeams as vercelListTeams,
  getTeam as vercelGetTeam,
  listTeamMembers as vercelListTeamMembers,
  listProjects as vercelListProjects,
  getProject as vercelGetProject,
  listProjectDomains as vercelListProjectDomains,
  listProjectEnv as vercelListProjectEnv,
  listProjectDeployments as vercelListProjectDeployments,
  getDeployment as vercelGetDeployment,
  listDeploymentEvents as vercelListDeploymentEvents,
} from './core/vercel/_client.ts'
export { HttpVercelDriver, type HttpVercelDriverOptions } from './core/vercel/http_driver.ts'

export type {
  PostHogDriver,
  PostHogPaged,
  PostHogProject,
  PostHogUser,
} from './core/posthog/_driver.ts'
export { PostHogAccessor } from './accessor/posthog.ts'
export {
  normalizePostHogConfig,
  resolvePostHogConfig,
  type PostHogConfig,
  type PostHogConfigResolved,
} from './resource/posthog/config.ts'
export { POSTHOG_PROMPT } from './resource/posthog/prompt.ts'
export { POSTHOG_OPS } from './ops/posthog/index.ts'
export { POSTHOG_COMMANDS } from './commands/builtin/posthog/index.ts'
export { read as posthogRead } from './core/posthog/read.ts'
export { readdir as posthogReaddir } from './core/posthog/readdir.ts'
export { stat as posthogStat } from './core/posthog/stat.ts'
export { resolveGlob as resolvePostHogGlob } from './core/posthog/glob.ts'
export {
  detectScope as detectPostHogScope,
  type PostHogScope,
  type PostHogLevel,
  ROOT_ENTRIES as POSTHOG_ROOT_ENTRIES,
  PROJECT_FILES as POSTHOG_PROJECT_FILES,
} from './core/posthog/scope.ts'
export {
  getUser as posthogGetUser,
  getProject as posthogGetProject,
  listProjects as posthogListProjects,
  listFeatureFlags as posthogListFeatureFlags,
  listCohorts as posthogListCohorts,
  listDashboards as posthogListDashboards,
  listInsights as posthogListInsights,
  listPersons as posthogListPersons,
} from './core/posthog/_client.ts'
export { HttpPostHogDriver, type HttpPostHogDriverOptions } from './core/posthog/http_driver.ts'

export { setHttpProxyBase } from './commands/builtin/utils/http.ts'
