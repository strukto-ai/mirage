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

import type { NOOPAccessor } from '../../../../accessor/base.ts'
import { callerSignal, currentCaller } from '../../../../context/session_context.ts'
import { isFsError } from '../../../../errors/fs.ts'
import { MemoryExhausted } from '../../../../io/errors.ts'
import { checkMemory, memoryRoom } from '../../../../io/memory.ts'
import { readPrefix } from '../../../../io/cooperative.ts'
import { IOResult, type ByteSource } from '../../../../io/types.ts'
import { FileType, PathSpec, type FileStat } from '../../../../types.ts'
import type { MountView } from '../../../../view/types.ts'
import type { Files } from '../../../../workspace/files.ts'
import {
  type IgnoreSources,
  type IgnoreStack,
  Overrides,
  Verdict,
  walkCandidate,
} from '../../../builtin/rg_glob.ts'
import { commandFiles, dispatchedReadTree } from '../../../builtin/generic_bind/files.ts'
import { ruledOut } from '../../../builtin/generic_bind/search.ts'
import { searchTerms } from '../../../builtin/grep_pushdown.ts'
import { type IgnoreReader, dirRules, rootStack } from '../../../builtin/rg_scan.ts'
import { dispatchOf, linkLocation, linkView, mountView } from '../../../builtin/utils/links.ts'
import { WalkBudget, beforeFullWalk, treeWalk, type WalkCall } from '../../../builtin/utils/tree.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import { UsageError } from '../../../errors.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { Argument, CommandSpec, UsageStyle } from '../../../spec/types.ts'
import { CLI, CLIHandler, DefaultCommandRoot } from '../../types.ts'
import { AstGrepConfig } from './config.ts'
import { processor } from './engine.ts'
import { rstripSlash } from '../../../../utils/slash.ts'

// A fixed token a mount's search is asked for: printable ASCII on one line.
const PLAIN = /^[\x20-\x7e]+$/
const LANGUAGES = new Map([
  ['js', 'JavaScript'],
  ['jsx', 'JavaScript'],
  ['javascript', 'JavaScript'],
  ['py', 'Python'],
  ['python', 'Python'],
  ['rs', 'Rust'],
  ['rust', 'Rust'],
  ['ts', 'TypeScript'],
  ['typescript', 'TypeScript'],
  ['tsx', 'Tsx'],
])
const EXTENSIONS = new Map([
  ['js', 'JavaScript'],
  ['jsx', 'JavaScript'],
  ['mjs', 'JavaScript'],
  ['cjs', 'JavaScript'],
  ['py', 'Python'],
  ['py3', 'Python'],
  ['pyi', 'Python'],
  ['bzl', 'Python'],
  ['bazel', 'Python'],
  ['rs', 'Rust'],
  ['ts', 'TypeScript'],
  ['mts', 'TypeScript'],
  ['cts', 'TypeScript'],
  ['tsx', 'Tsx'],
])
const UNBUNDLED_EXTENSIONS = new Set([
  'bash',
  'bats',
  'cgi',
  'command',
  'env',
  'fcgi',
  'ksh',
  'sh',
  'tmux',
  'tool',
  'zsh',
  'c',
  'h',
  'cc',
  'hpp',
  'cpp',
  'c++',
  'hh',
  'cxx',
  'cu',
  'ino',
  'cs',
  'css',
  'scss',
  'dart',
  'ex',
  'exs',
  'go',
  'hs',
  'hcl',
  'nomad',
  'tf',
  'tfvars',
  'workflow',
  'html',
  'htm',
  'xhtml',
  'java',
  'json',
  'kt',
  'ktm',
  'kts',
  'lua',
  'markdown',
  'md',
  'nix',
  'php',
  'rb',
  'rbw',
  'gemspec',
  'scala',
  'sc',
  'sbt',
  'sol',
  'swift',
  'yaml',
  'yml',
  'zig',
])

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1) : ''
}
const GLOBS = new Argument('--globs', {
  action: 'append',
  help: 'Include or exclude matching paths',
})
const PATHS = new Argument('paths', {
  nargs: '*',
  type: 'path',
  help: 'Files or directories in the workspace',
})
const LANG = new Argument(['-l', '--lang'], {
  help: 'JavaScript, Python, Rust, TypeScript or TSX',
})
const STDIN = new Argument('--stdin', {
  action: 'store_true',
  help: 'Read source from standard input',
})
const NO_IGNORE = new Argument('--no-ignore', {
  action: 'append',
  metavar: 'FILE_TYPE',
  choices: ['hidden', 'dot', 'exclude', 'global', 'parent', 'vcs'],
  help: 'Ignore files or hidden entries not to respect',
})
const UPDATE = new Argument(['-U', '--update-all'], {
  action: 'store_true',
  help: 'Apply rewrites',
})

/**
 * Which ignore files a walk reads and whether it walks hidden entries:
 * ast-grep's defaults with every `--no-ignore` value applied. `global`
 * names git's own config, which no workspace has. `readdir` and `lstat` are
 * the walk's listing and its look at an entry without following a link,
 * answered from one read of a subtree where its mount gives one.
 */
interface Walk {
  readonly sources: IgnoreSources
  readonly hidden: boolean
  readonly reader: IgnoreReader
  readonly readdir: WalkCall<string[]>
  readonly lstat: WalkCall<FileStat>
}

function walkOf(off: ReadonlySet<string>, vfs: Files, maxMemory: number): Walk {
  const vcs = !off.has('vcs')
  const links = linkView(vfs)
  const [readdir, lstat] = treeWalk<string[], FileStat>(
    dispatchedReadTree(
      vfs.dispatch,
      mountView(vfs),
      links === undefined ? null : (virtual) => linkLocation(links, virtual),
      true,
    ),
    async (path, _nofollow, limit) =>
      (
        await vfs.dispatch('readdir', path, [], limit === undefined ? {} : { limit })
      )[0] as string[],
    (path) => vfs.stat(path, undefined, { nofollow: true }),
    true,
    callerSignal(),
  )
  return {
    readdir,
    lstat,
    sources: {
      vcs,
      exclude: vcs && !off.has('exclude'),
      dot: !off.has('dot'),
      custom: null,
      parents: !off.has('parent'),
      requireGit: true,
      bom: true,
    },
    hidden: off.has('hidden'),
    reader: {
      // ast-grep's walker goes on past an ignore file it cannot read.
      read: async (path) => {
        const file = PathSpec.fromStrPath(path)
        try {
          return (await vfs.isFile(file)) ? await read(vfs, file, maxMemory) : null
        } catch (error) {
          if (!isFsError(error)) throw error
          console.debug(`ast-grep: cannot read ${path}: ${String(error)}`)
          return null
        }
      },
      names: async (dir) => {
        try {
          const [entries] = await vfs.dispatch('readdir', PathSpec.fromStrPath(dir), [], {})
          return new Set(
            (entries as string[]).map((entry) => rstripSlash(entry).split('/').pop() ?? ''),
          )
        } catch (error) {
          if (!isFsError(error)) throw error
          console.debug(`ast-grep: cannot list ${dir}: ${String(error)}`)
          return null
        }
      },
    },
  }
}

async function* files(
  vfs: Files,
  root: PathSpec,
  shown: string,
  budget: WalkBudget,
  cwd: PathSpec,
  globs: Overrides,
  walk: Walk,
): AsyncGenerator<[PathSpec, string]> {
  if ((await vfs.stat(root)).type === FileType.FILE) {
    yield [root, shown]
    return
  }
  const pending: [PathSpec, string, IgnoreStack][] = [
    [root, shown, await rootStack(root.virtual, walk.sources, walk.reader)],
  ]
  while (pending.length) {
    const entry = pending.pop()
    if (!entry) break
    const [path, display, stack] = entry
    const stat = path === root ? await vfs.stat(path) : await walk.lstat(path, true)
    const isDir = stat.type === FileType.DIRECTORY
    if (path !== root) {
      let verdict = globs.verdict(walkCandidate(display, cwd.virtual), isDir)
      if (verdict === Verdict.NONE) verdict = stack.verdict(path.virtual, isDir)
      if (
        verdict === Verdict.IGNORE ||
        (verdict === Verdict.NONE && !walk.hidden && path.virtual.split('/').pop()?.startsWith('.'))
      )
        continue
    }
    if (stat.type === FileType.FILE) yield [path, display]
    else if (isDir && budget.opens(path.virtual)) {
      const limit = budget.listingLimit(path.virtual)
      const children = await walk.readdir(path, false, limit ?? undefined)
      const selected: [PathSpec, string][] = []
      const names = new Set<string>()
      for (const child of children) {
        if (!budget.spend(path.virtual)) break
        const name = rstripSlash(child).split('/').pop() ?? ''
        names.add(name)
        selected.push([
          PathSpec.fromStrPath(child),
          display ? display.replace(/\/$/, '') + '/' + name : name,
        ])
      }
      if (!budget.stopped.length) {
        const own = await dirRules(path.virtual, names, walk.sources, walk.reader)
        const below = own === null ? stack : stack.within(own)
        for (const [child, shown] of selected.reverse()) pending.push([child, shown, below])
      }
    }
    const stopped = budget.stopped[0]
    if (stopped !== undefined) throw new UsageError(`ast-grep: ${stopped}`, 1)
  }
}

async function read(
  vfs: Files,
  path: PathSpec | null,
  maxMemory: number,
  stdin?: ByteSource | null,
): Promise<Uint8Array> {
  const limit = Math.min(maxMemory, memoryRoom() ?? maxMemory)
  const data =
    path === null
      ? await readPrefix(stdin ?? new Uint8Array(), limit + 1)
      : await vfs.read(path, { size: limit + 1, raw: true })
  if (data.length > limit) throw new MemoryExhausted()
  return data
}

async function loadRules(
  fl: FlagView,
  vfs: Files,
  cwd: PathSpec,
  mounts: MountView | null,
  ctx: Context,
  process: ReturnType<typeof processor>,
  maxMemory: number,
): Promise<[string, PathSpec]> {
  const rule = fl.asPath('rule'),
    inline = fl.asStr('inline_rules')
  let config = fl.asPath('config')
  if ([rule, inline, config].filter((value) => value !== undefined).length > 1)
    throw new UsageError('ast-grep scan: select one rule source')
  if (inline !== undefined) return [inline, cwd]
  if (rule !== undefined) return [decodeRule(await read(vfs, rule, maxMemory)), rule.parent]
  if (config === undefined) {
    let folder = cwd
    while (!(await vfs.exists(folder.join('sgconfig.yml')))) {
      if (folder.virtual === '/') throw new UsageError('ast-grep scan: no sgconfig.yml found')
      folder = folder.parent
    }
    config = folder.join('sgconfig.yml')
  }
  const dirs = await process(
    { verb: 'config' },
    await read(vfs, config, maxMemory),
    memoryRoom() ?? Number.MAX_SAFE_INTEGER,
  )
  const documents: string[] = []
  let size = 0
  for (const name of dirs.values) {
    const root = config.parent.join(name)
    await beforeFullWalk(dispatchOf(ctx), root, 'ast-grep')
    for await (const [path] of files(
      vfs,
      root,
      root.virtual,
      new WalkBudget(root, mounts),
      cwd,
      new Overrides([], [], false),
      walkOf(new Set(['parent']), vfs, maxMemory),
    )) {
      if (!/\.ya?ml$/.test(path.virtual)) continue
      const data = await read(vfs, path, maxMemory)
      size += data.length + 5
      if (size > maxMemory) throw new MemoryExhausted()
      checkMemory(size)
      documents.push(decodeRule(data))
    }
  }
  return [documents.join('\n---\n'), config.parent]
}

function decodeRule(data: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data)
  } catch (error) {
    if (error instanceof TypeError) throw new UsageError('ast-grep scan: rule is not valid UTF-8')
    throw error
  }
}

async function execute(
  accessor: NOOPAccessor,
  paths: PathSpec[],
  _texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  if (!ctx.vfs || !ctx.spec) throw new Error('ast-grep needs workspace files')
  const vfs = ctx.vfs,
    verb = ctx.spec.name
  const { maxMemory } = accessor.config as AstGrepConfig
  const process = processor(maxMemory)
  const fl = new FlagView(ctx.flags, ctx.spec)
  const stdin = fl.asBool('stdin'),
    selected = fl.asStr('lang')
  let command = currentCaller().command ?? 'ast-grep'
  if (!command.endsWith(' ' + verb)) command += ' ' + verb
  const mounts = mountView(vfs, true, command) ?? null
  let language = selected ? LANGUAGES.get(selected.toLowerCase()) : undefined
  if (selected && !language) throw new UsageError(`ast-grep: unsupported language: ${selected}`)
  let rules: string | null = null,
    pattern: string | null = null,
    rewrite: string | null = null,
    kind: string | null = null
  let filesOnly = false
  let ruleBase = ctx.cwd
  const update = (verb === 'run' || verb === 'scan') && fl.asBool('update_all')
  if (update && !ctx.argv?.some((arg) => arg === '-U' || arg === '--update-all'))
    throw new UsageError('ast-grep: use -U or --update-all as a separate option')
  if (verb === 'scan') {
    ;[rules, ruleBase] = await loadRules(fl, vfs, ctx.cwd, mounts, ctx, process, maxMemory)
    const meta = await process(
      { verb: 'rules' },
      new TextEncoder().encode(rules),
      memoryRoom() ?? Number.MAX_SAFE_INTEGER,
    )
    if (stdin && !language && meta.values.length === 1) language = meta.values[0]
  }
  if (stdin && (paths.length || !language))
    throw new UsageError('ast-grep: --stdin requires a language and no paths')
  if (verb === 'run') {
    pattern = fl.asStr('pattern') ?? null
    kind = fl.asStr('kind') ?? null
    rewrite = fl.asStr('rewrite') ?? null
    filesOnly = fl.asBool('files_with_matches')
    if ((pattern === null) === (kind === null))
      throw new UsageError('ast-grep run: specify either --pattern or --kind')
    if (update && rewrite === null)
      throw new UsageError('ast-grep: --update-all requires --rewrite')
    if (filesOnly && rewrite !== null)
      throw new UsageError('ast-grep: --files-with-matches conflicts with --rewrite')
  }
  const globs = new Overrides(fl.asList('globs'), [], false)
  const walk = walkOf(new Set(fl.asList('no_ignore')), vfs, maxMemory)
  const roots = paths.length ? paths : [ctx.cwd]
  let directory = false
  const lone = new Set<string>()
  if (!stdin)
    for (const root of roots) {
      if ((await vfs.stat(root)).type === FileType.DIRECTORY) {
        directory = true
        await beforeFullWalk(dispatchOf(ctx), root, 'ast-grep')
        continue
      }
      lone.add(root.virtual)
      if (!language && UNBUNDLED_EXTENSIONS.has(extensionOf(root.virtual)))
        throw new UsageError(`ast-grep: unsupported language: ${extensionOf(root.virtual)}`)
    }
  const options = {
    verb,
    pattern,
    kind,
    rewrite,
    rules,
    directory,
    style: verb === 'scan' ? (fl.asStr('report_style') ?? null) : null,
    files_only: filesOnly,
    update,
    filter: verb === 'outline' ? (fl.asStr('match') ?? null) : null,
    symbol: verb === 'outline' ? (fl.asStr('type') ?? null) : null,
    view: verb === 'outline' ? fl.asStr('view', 'auto') : 'auto',
    items: verb === 'outline' ? (fl.asStr('items') ?? null) : null,
    pub_members: verb === 'outline' && fl.asBool('pub_members'),
  }
  // The files of each language no match of a `run` pattern can be in: the
  // text ast-grep itself rules a file out by before it parses it (the
  // pattern's longest fixed token), asked of the mount's search. A file
  // named on the line is always read.
  const walked = roots.filter((root) => !lone.has(root.virtual))
  const ruled = new Map<string, ((path: PathSpec) => Promise<boolean>) | null>()
  async function misses(lang: string, path: PathSpec): Promise<boolean> {
    if (pattern === null || walked.length === 0) return false
    let rule = ruled.get(lang)
    if (rule === undefined) {
      const reply = await process(
        { verb: 'literal', language: lang },
        new TextEncoder().encode(pattern),
        memoryRoom() ?? Number.MAX_SAFE_INTEGER,
      )
      const fixed = reply.values[0] ?? ''
      const texts = PLAIN.test(fixed)
        ? searchTerms(null, [fixed], false, false, false, false, false)
        : null
      rule =
        texts === null
          ? null
          : await ruledOut(commandFiles(ctx, walked), ctx, walked, lone, {
              texts: texts[0],
              wholeWord: false,
              ignoreCase: false,
              lineOutput: false,
              readsBinary: false,
            })
      ruled.set(lang, rule)
    }
    return rule !== null && (await rule(path))
  }
  const chunks: Uint8Array[] = []
  let size = 0,
    matched = 0,
    errors = 0,
    applied = 0
  function append(data: Uint8Array) {
    size += data.length
    checkMemory(size)
    chunks.push(data)
  }
  async function visit(data: Uint8Array, path: PathSpec | null, shown: string, lang: string) {
    const prefix = ruleBase.virtual.replace(/\/$/, '') + '/'
    const rulePath =
      verb === 'scan' && path?.virtual.startsWith(prefix)
        ? path.virtual.slice(prefix.length)
        : shown
    const result = await process(
      { ...options, language: lang, path: shown, rule_path: rulePath },
      data,
      (memoryRoom() ?? Number.MAX_SAFE_INTEGER) - size,
    )
    matched += result.count
    errors += result.errors
    if (result.output) {
      if (size && verb === 'outline') append(Uint8Array.of(10))
      append(new TextEncoder().encode(result.output))
    }
    if (update && result.updated !== null) {
      const replacement = new TextEncoder().encode(result.updated)
      if (path === null) {
        append(replacement)
        append(Uint8Array.of(10))
      } else await vfs.write(path, replacement)
      applied += result.applied
    }
  }
  if (stdin && language)
    await visit(await read(vfs, null, maxMemory, ctx.stdin), null, 'STDIN', language)
  else
    for (const root of roots) {
      const shown = paths.length ? root.rawPath || root.virtual : ''
      for await (const [path, display] of files(
        vfs,
        root,
        shown,
        new WalkBudget(root, mounts),
        ctx.cwd,
        globs,
        walk,
      )) {
        const lang =
          path === root && language ? language : EXTENSIONS.get(extensionOf(path.virtual))
        if (!lang || (language && lang !== language)) continue
        if (await misses(lang, path)) continue
        const data = await read(vfs, path, maxMemory)
        if (data.length)
          await visit(
            data,
            path,
            verb === 'outline' ? display : display.replace(/^(\.\/)+/, ''),
            lang,
          )
      }
    }
  if (verb === 'outline' && !size) append(new TextEncoder().encode('nothing found\n'))
  let stderr = applied ? `Applied ${String(applied)} changes\n` : ''
  if (errors)
    stderr += `Error: ${String(errors)} error(s) found in code.\nHelp: Scan succeeded and found error level diagnostics in the codebase.\n\n`
  checkMemory(2 * size)
  const output = new Uint8Array(size)
  let i = 0
  for (const chunk of chunks) {
    output.set(chunk, i)
    i += chunk.length
  }
  return [
    output,
    new IOResult({
      exitCode: errors || (verb === 'run' && !matched) ? 1 : 0,
      stderr: new TextEncoder().encode(stderr),
    }),
  ]
}
export const AST_GREP = new CLI({
  configModel: AstGrepConfig,
  vfsOnly: true,
  spec: new DefaultCommandRoot({
    name: 'ast-grep',
    description: 'Search and rewrite source code by syntax',
    usageStyle: UsageStyle.CLAP,
    subcommands: [
      new CommandSpec({
        name: 'run',
        description: 'Search or rewrite a code pattern',
        arguments: [
          new Argument(['-p', '--pattern'], { help: 'Code pattern' }),
          new Argument(['-k', '--kind'], { help: 'Syntax node kind or selector' }),
          new Argument(['-r', '--rewrite'], { help: 'Replacement pattern' }),
          UPDATE,
          new Argument('--files-with-matches', { action: 'store_true' }),
          LANG,
          STDIN,
          NO_IGNORE,
          GLOBS,
          PATHS,
        ],
      }),
      new CommandSpec({
        name: 'scan',
        description: 'Scan with YAML rules',
        arguments: [
          UPDATE,
          new Argument(['-c', '--config'], {
            type: 'path',
            help: 'Workspace project configuration',
          }),
          new Argument(['-r', '--rule'], { type: 'path', help: 'Workspace rule file' }),
          new Argument('--inline-rules', { help: 'YAML rules' }),
          new Argument('--report-style', {
            choices: ['rich', 'medium', 'short'],
            help: 'Diagnostic presentation',
          }),
          LANG,
          STDIN,
          NO_IGNORE,
          GLOBS,
          PATHS,
        ],
      }),
      new CommandSpec({
        name: 'outline',
        description: 'Outline source symbols',
        arguments: [
          new Argument('--match', { help: 'Filter top-level items by regex' }),
          new Argument('--type', { help: 'Comma-separated symbol types' }),
          new Argument('--items', {
            choices: ['auto', 'structure', 'exports', 'imports', 'all'],
            help: 'Top-level items to include',
          }),
          new Argument('--pub-members', {
            action: 'store_true',
            help: 'Show only public members',
          }),
          new Argument('--view', {
            choices: ['auto', 'names', 'signatures', 'digest', 'expanded'],
            help: 'Outline presentation',
          }),
          LANG,
          STDIN,
          NO_IGNORE,
          GLOBS,
          PATHS,
        ],
      }),
    ],
  }),
  handlers: {
    run: new CLIHandler({ fn: execute, writeWhen: ['-U', '--update-all'] }),
    scan: new CLIHandler({ fn: execute, writeWhen: ['-U', '--update-all'] }),
    outline: new CLIHandler({ fn: execute }),
  },
})
