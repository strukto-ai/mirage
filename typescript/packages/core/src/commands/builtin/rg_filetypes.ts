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

import { UsageError } from '../errors.ts'
import { Verdict, compileGlob } from './rg_glob.ts'

// ripgrep's refusal of a --type-add it cannot read, whatever is wrong with it
// (a missing glob, a bad name, `all`, an unknown include), exit 2 (ripgrep
// 14.1.1).
export const INVALID_DEFINITION = 'rg: invalid definition (format is type:glob, e.g., html:*.html)'
// The name that selects every type at once; it cannot be defined.
export const ALL_TYPES = 'all'

// ripgrep 14.1.1's built-in file types, verbatim from `rg --type-list`: each
// name and the globs a file's name is matched against.
export const DEFAULT_TYPES: Readonly<Record<string, readonly string[]>> = {
  ada: ['*.adb', '*.ads'],
  agda: ['*.agda', '*.lagda'],
  aidl: ['*.aidl'],
  alire: ['alire.toml'],
  amake: ['*.bp', '*.mk'],
  asciidoc: ['*.adoc', '*.asc', '*.asciidoc'],
  asm: ['*.S', '*.asm', '*.s'],
  asp: ['*.ascx', '*.ascx.cs', '*.ascx.vb', '*.asp', '*.aspx', '*.aspx.cs', '*.aspx.vb'],
  ats: ['*.ats', '*.dats', '*.hats', '*.sats'],
  avro: ['*.avdl', '*.avpr', '*.avsc'],
  awk: ['*.awk'],
  bat: ['*.bat'],
  batch: ['*.bat'],
  bazel: [
    '*.BUILD',
    '*.bazel',
    '*.bazelrc',
    '*.bzl',
    'BUILD',
    'MODULE.bazel',
    'WORKSPACE',
    'WORKSPACE.bazel',
  ],
  bitbake: ['*.bb', '*.bbappend', '*.bbclass', '*.conf', '*.inc'],
  brotli: ['*.br'],
  buildstream: ['*.bst'],
  bzip2: ['*.bz2', '*.tbz2'],
  c: ['*.[chH]', '*.[chH].in', '*.cats'],
  cabal: ['*.cabal'],
  candid: ['*.did'],
  carp: ['*.carp'],
  cbor: ['*.cbor'],
  ceylon: ['*.ceylon'],
  clojure: ['*.clj', '*.cljc', '*.cljs', '*.cljx'],
  cmake: ['*.cmake', 'CMakeLists.txt'],
  cmd: ['*.bat', '*.cmd'],
  cml: ['*.cml'],
  coffeescript: ['*.coffee'],
  config: ['*.cfg', '*.conf', '*.config', '*.ini'],
  coq: ['*.v'],
  cpp: [
    '*.[ChH]',
    '*.[ChH].in',
    '*.[ch]pp',
    '*.[ch]pp.in',
    '*.[ch]xx',
    '*.[ch]xx.in',
    '*.cc',
    '*.cc.in',
    '*.hh',
    '*.hh.in',
    '*.inl',
  ],
  creole: ['*.creole'],
  crystal: ['*.cr', '*.ecr', 'Projectfile', 'shard.yml'],
  cs: ['*.cs'],
  csharp: ['*.cs'],
  cshtml: ['*.cshtml'],
  csproj: ['*.csproj'],
  css: ['*.css', '*.scss'],
  csv: ['*.csv'],
  cuda: ['*.cu', '*.cuh'],
  cython: ['*.pxd', '*.pxi', '*.pyx'],
  d: ['*.d'],
  dart: ['*.dart'],
  devicetree: ['*.dts', '*.dtsi'],
  dhall: ['*.dhall'],
  diff: ['*.diff', '*.patch'],
  dita: ['*.dita', '*.ditamap', '*.ditaval'],
  docker: ['*Dockerfile*'],
  dockercompose: ['docker-compose.*.yml', 'docker-compose.yml'],
  dts: ['*.dts', '*.dtsi'],
  dvc: ['*.dvc', 'Dvcfile'],
  ebuild: ['*.ebuild', '*.eclass'],
  edn: ['*.edn'],
  elisp: ['*.el'],
  elixir: ['*.eex', '*.ex', '*.exs', '*.heex', '*.leex', '*.livemd'],
  elm: ['*.elm'],
  erb: ['*.erb'],
  erlang: ['*.erl', '*.hrl'],
  fennel: ['*.fnl'],
  fidl: ['*.fidl'],
  fish: ['*.fish'],
  flatbuffers: ['*.fbs'],
  fortran: ['*.F', '*.F77', '*.F90', '*.F95', '*.f', '*.f77', '*.f90', '*.f95', '*.pfo'],
  fsharp: ['*.fs', '*.fsi', '*.fsx'],
  fut: ['*.fut'],
  gap: ['*.g', '*.gap', '*.gd', '*.gi', '*.tst'],
  gn: ['*.gn', '*.gni'],
  go: ['*.go'],
  gprbuild: ['*.gpr'],
  gradle: [
    '*.gradle',
    '*.gradle.kts',
    'gradle-wrapper.*',
    'gradle.properties',
    'gradlew',
    'gradlew.bat',
  ],
  graphql: ['*.graphql', '*.graphqls'],
  groovy: ['*.gradle', '*.groovy'],
  gzip: ['*.gz', '*.tgz'],
  h: ['*.h', '*.hh', '*.hpp'],
  haml: ['*.haml'],
  hare: ['*.ha'],
  haskell: ['*.c2hs', '*.cpphs', '*.hs', '*.hsc', '*.lhs'],
  hbs: ['*.hbs'],
  hs: ['*.hs', '*.lhs'],
  html: ['*.ejs', '*.htm', '*.html'],
  hy: ['*.hy'],
  idris: ['*.idr', '*.lidr'],
  janet: ['*.janet'],
  java: ['*.java', '*.jsp', '*.jspx', '*.properties'],
  jinja: ['*.j2', '*.jinja', '*.jinja2'],
  jl: ['*.jl'],
  js: ['*.cjs', '*.js', '*.jsx', '*.mjs', '*.vue'],
  json: ['*.json', '*.sarif', 'composer.lock'],
  jsonl: ['*.jsonl'],
  julia: ['*.jl'],
  jupyter: ['*.ipynb', '*.jpynb'],
  k: ['*.k'],
  kotlin: ['*.kt', '*.kts'],
  lean: ['*.lean'],
  less: ['*.less'],
  license: [
    '*[.-]LICEN[CS]E*',
    'AGPL-*[0-9]*',
    'APACHE-*[0-9]*',
    'BSD-*[0-9]*',
    'CC-BY-*',
    'COPYING',
    'COPYING[.-]*',
    'COPYRIGHT',
    'COPYRIGHT[.-]*',
    'EULA',
    'EULA[.-]*',
    'GFDL-*[0-9]*',
    'GNU-*[0-9]*',
    'GPL-*[0-9]*',
    'LGPL-*[0-9]*',
    'LICEN[CS]E',
    'LICEN[CS]E[.-]*',
    'MIT-*[0-9]*',
    'MPL-*[0-9]*',
    'NOTICE',
    'NOTICE[.-]*',
    'OFL-*[0-9]*',
    'PATENTS',
    'PATENTS[.-]*',
    'UNLICEN[CS]E',
    'UNLICEN[CS]E[.-]*',
    'agpl[.-]*',
    'gpl[.-]*',
    'lgpl[.-]*',
    'licen[cs]e',
    'licen[cs]e.*',
  ],
  lilypond: ['*.ily', '*.ly'],
  lisp: ['*.el', '*.jl', '*.lisp', '*.lsp', '*.sc', '*.scm'],
  lock: ['*.lock', 'package-lock.json'],
  log: ['*.log'],
  lua: ['*.lua'],
  lz4: ['*.lz4'],
  lzma: ['*.lzma'],
  m4: ['*.ac', '*.m4'],
  make: [
    '*.mak',
    '*.mk',
    '[Gg][Nn][Uu]makefile',
    '[Gg][Nn][Uu]makefile.am',
    '[Gg][Nn][Uu]makefile.in',
    '[Mm]akefile',
    '[Mm]akefile.am',
    '[Mm]akefile.in',
  ],
  mako: ['*.mako', '*.mao'],
  man: ['*.[0-9][cEFMmpSx]', '*.[0-9lnpx]'],
  markdown: ['*.markdown', '*.md', '*.mdown', '*.mdwn', '*.mdx', '*.mkd', '*.mkdn'],
  matlab: ['*.m'],
  md: ['*.markdown', '*.md', '*.mdown', '*.mdwn', '*.mdx', '*.mkd', '*.mkdn'],
  meson: ['meson.build', 'meson.options', 'meson_options.txt'],
  minified: ['*.min.css', '*.min.html', '*.min.js'],
  mint: ['*.mint'],
  mk: ['mkfile'],
  ml: ['*.ml'],
  motoko: ['*.mo'],
  msbuild: ['*.csproj', '*.fsproj', '*.proj', '*.props', '*.sln', '*.targets', '*.vcxproj'],
  nim: ['*.nim', '*.nimble', '*.nimf', '*.nims'],
  nix: ['*.nix'],
  objc: ['*.h', '*.m'],
  objcpp: ['*.h', '*.mm'],
  ocaml: ['*.ml', '*.mli', '*.mll', '*.mly'],
  org: ['*.org', '*.org_archive'],
  pants: ['BUILD'],
  pascal: ['*.dpr', '*.inc', '*.lpr', '*.pas', '*.pp'],
  pdf: ['*.pdf'],
  perl: ['*.PL', '*.perl', '*.pl', '*.plh', '*.plx', '*.pm', '*.t'],
  php: ['*.php', '*.php3', '*.php4', '*.php5', '*.php7', '*.php8', '*.pht', '*.phtml'],
  po: ['*.po'],
  pod: ['*.pod'],
  postscript: ['*.eps', '*.ps'],
  prolog: ['*.P', '*.pl', '*.pro', '*.prolog'],
  protobuf: ['*.proto'],
  ps: ['*.cdxml', '*.ps1', '*.ps1xml', '*.psd1', '*.psm1'],
  puppet: ['*.epp', '*.erb', '*.pp', '*.rb'],
  purs: ['*.purs'],
  py: ['*.py', '*.pyi'],
  python: ['*.py', '*.pyi'],
  qmake: ['*.prf', '*.pri', '*.pro'],
  qml: ['*.qml'],
  r: ['*.R', '*.Rmd', '*.Rnw', '*.r'],
  racket: ['*.rkt'],
  raku: ['*.p6', '*.pl6', '*.pm6', '*.raku', '*.rakudoc', '*.rakumod', '*.rakutest'],
  rdoc: ['*.rdoc'],
  readme: ['*README', 'README*'],
  reasonml: ['*.re', '*.rei'],
  red: ['*.r', '*.red', '*.reds'],
  rescript: ['*.res', '*.resi'],
  robot: ['*.robot'],
  rst: ['*.rst'],
  ruby: ['*.gemspec', '*.rb', '*.rbw', '.irbrc', 'Gemfile', 'Rakefile', 'config.ru'],
  rust: ['*.rs'],
  sass: ['*.sass', '*.scss'],
  scala: ['*.sbt', '*.scala'],
  sh: [
    '*.bash',
    '*.bashrc',
    '*.csh',
    '*.cshrc',
    '*.ksh',
    '*.kshrc',
    '*.sh',
    '*.tcsh',
    '*.zsh',
    '.bash_login',
    '.bash_logout',
    '.bash_profile',
    '.bashrc',
    '.cshrc',
    '.kshrc',
    '.login',
    '.logout',
    '.profile',
    '.tcshrc',
    '.zlogin',
    '.zlogout',
    '.zprofile',
    '.zshenv',
    '.zshrc',
    'bash_login',
    'bash_logout',
    'bash_profile',
    'bashrc',
    'profile',
    'zlogin',
    'zlogout',
    'zprofile',
    'zshenv',
    'zshrc',
  ],
  slim: ['*.skim', '*.slim', '*.slime'],
  smarty: ['*.tpl'],
  sml: ['*.sig', '*.sml'],
  solidity: ['*.sol'],
  soy: ['*.soy'],
  spark: ['*.spark'],
  spec: ['*.spec'],
  sql: ['*.psql', '*.sql'],
  stylus: ['*.styl'],
  sv: ['*.h', '*.sv', '*.svh', '*.v', '*.vg'],
  svelte: ['*.svelte'],
  svg: ['*.svg'],
  swift: ['*.swift'],
  swig: ['*.def', '*.i'],
  systemd: [
    '*.automount',
    '*.conf',
    '*.device',
    '*.link',
    '*.mount',
    '*.path',
    '*.scope',
    '*.service',
    '*.slice',
    '*.socket',
    '*.swap',
    '*.target',
    '*.timer',
  ],
  taskpaper: ['*.taskpaper'],
  tcl: ['*.tcl'],
  tex: ['*.bib', '*.cls', '*.dtx', '*.ins', '*.ltx', '*.sty', '*.tex'],
  texinfo: ['*.texi'],
  textile: ['*.textile'],
  tf: [
    '*.auto.tfvars',
    '*.auto.tfvars.json',
    '*.terraform.lock.hcl',
    '*.terraformrc',
    '*.tf',
    '*.tf.json',
    '*.tfrc',
    'terraform.rc',
    'terraform.tfvars',
    'terraform.tfvars.json',
  ],
  thrift: ['*.thrift'],
  toml: ['*.toml', 'Cargo.lock'],
  ts: ['*.cts', '*.mts', '*.ts', '*.tsx'],
  twig: ['*.twig'],
  txt: ['*.txt'],
  typescript: ['*.cts', '*.mts', '*.ts', '*.tsx'],
  typoscript: ['*.ts', '*.typoscript'],
  usd: ['*.usd', '*.usda', '*.usdc'],
  v: ['*.v', '*.vsh'],
  vala: ['*.vala'],
  vb: ['*.vb'],
  vcl: ['*.vcl'],
  verilog: ['*.sv', '*.svh', '*.v', '*.vh'],
  vhdl: ['*.vhd', '*.vhdl'],
  vim: ['*.vim', '.gvimrc', '.vimrc', '_gvimrc', '_vimrc', 'gvimrc', 'vimrc'],
  vimscript: ['*.vim', '.gvimrc', '.vimrc', '_gvimrc', '_vimrc', 'gvimrc', 'vimrc'],
  vue: ['*.vue'],
  webidl: ['*.idl', '*.webidl', '*.widl'],
  wgsl: ['*.wgsl'],
  wiki: ['*.mediawiki', '*.wiki'],
  xml: [
    '*.dtd',
    '*.rng',
    '*.sch',
    '*.xhtml',
    '*.xjb',
    '*.xml',
    '*.xml.dist',
    '*.xsd',
    '*.xsl',
    '*.xslt',
  ],
  xz: ['*.txz', '*.xz'],
  yacc: ['*.y'],
  yaml: ['*.yaml', '*.yml'],
  yang: ['*.yang'],
  z: ['*.Z'],
  zig: ['*.zig'],
  zsh: [
    '*.zsh',
    '.zlogin',
    '.zlogout',
    '.zprofile',
    '.zshenv',
    '.zshrc',
    'zlogin',
    'zlogout',
    'zprofile',
    'zshenv',
    'zshrc',
  ],
  zstd: ['*.zst', '*.zstd'],
}

const ALNUM = /^[\p{L}\p{N}]+$/u

// Add one glob to a type, creating the type if it is new. The name is
// alphanumeric and never `all`.
function addGlob(defs: Map<string, string[]>, name: string, glob: string): void {
  if (name === ALL_TYPES || !ALNUM.test(name)) throw new UsageError(INVALID_DEFINITION)
  const globs = defs.get(name)
  if (globs === undefined) defs.set(name, [glob])
  else globs.push(glob)
}

/**
 * Apply one --type-add, `name:glob` or `name:include:t1,t2`, refusing a
 * malformed definition in ripgrep's words.
 */
export function addDefinition(defs: Map<string, string[]>, definition: string): void {
  const parts = definition.split(':')
  if (parts.length === 2) {
    const [name = '', glob = ''] = parts
    if (name === '' || glob === '') throw new UsageError(INVALID_DEFINITION)
    addGlob(defs, name, glob)
    return
  }
  if (parts.length === 3) {
    const [name = '', keyword = '', included = ''] = parts
    if (name === '' || keyword !== 'include' || included === '') {
      throw new UsageError(INVALID_DEFINITION)
    }
    const names = included.split(',')
    if (names.some((t) => !defs.has(t))) throw new UsageError(INVALID_DEFINITION)
    for (const t of names) {
      for (const glob of [...(defs.get(t) ?? [])]) addGlob(defs, name, glob)
    }
    return
  }
  throw new UsageError(INVALID_DEFINITION)
}

/** The --type-clear and --type-add values in line order. */
export type TypeChange = readonly ['clear' | 'add', string]
/** The -t and -T names in line order, each with whether it negates (-T). */
export type TypeSelection = readonly [string, boolean]

/**
 * ripgrep's -t/-T matcher (the ignore crate's `Types`). Types match a file's
 * name, never a directory. The last selection whose globs match decides: -t
 * keeps the file whatever the hidden filter says, -T drops it. Once any -t
 * is given, a file no selected type matches is dropped. A malformed
 * definition, a selected type that does not exist, or a selected glob that
 * does not compile is refused.
 */
export class FileTypes {
  readonly definitions: Map<string, string[]>
  private readonly selected: boolean
  private readonly globs: readonly (readonly [RegExp, boolean])[]

  constructor(changes: readonly TypeChange[], selections: readonly TypeSelection[]) {
    const defs = new Map<string, string[]>(
      Object.entries(DEFAULT_TYPES).map(([name, globs]) => [name, [...globs]]),
    )
    for (const [kind, value] of changes) {
      if (kind === 'clear') defs.delete(value)
      else addDefinition(defs, value)
    }
    this.definitions = defs
    this.selected = selections.some(([, negated]) => !negated)
    const globs: (readonly [RegExp, boolean])[] = []
    for (const [name, negated] of selections) {
      let chosen: readonly string[]
      if (name === ALL_TYPES) chosen = [...defs.values()].flat()
      else {
        const found = defs.get(name)
        if (found === undefined) throw new UsageError(`rg: unrecognized file type: ${name}`)
        chosen = found
      }
      for (const g of chosen) globs.push([compileGlob(g), negated])
    }
    this.globs = globs
  }

  // What the selections say about one walked entry, by its file name.
  verdict(name: string, isDir: boolean): Verdict {
    if (isDir || this.globs.length === 0) return Verdict.NONE
    let last: boolean | null = null
    for (const [matcher, negated] of this.globs) {
      if (matcher.test(name)) last = negated
    }
    if (last === null) return this.selected ? Verdict.IGNORE : Verdict.NONE
    return last ? Verdict.IGNORE : Verdict.WHITELIST
  }
}

// Code-point order, which is Python's `sorted` on str.
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** --type-list: every type and its globs, both sorted, one per line. */
export function typeListing(defs: ReadonlyMap<string, readonly string[]>): string[] {
  return [...defs.keys()]
    .sort(byCodePoint)
    .map((name) => `${name}: ${[...(defs.get(name) ?? [])].sort(byCodePoint).join(', ')}`)
}
