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

/**
 * Array-element callbacks the arithmetic evaluator resolves through.
 *
 * The evaluator owns no session, so a caller that wants `a[i]` and
 * `m[key]` to mean anything injects these two facts. The split is what
 * keeps subscript semantics out of the evaluator: whether the subscript
 * text is an arithmetic expression (indexed) or a literal key
 * (associative) is the variable's to answer, and only the session knows
 * the variable. `resolve` receives the evaluator's current view, pending
 * assignments included, so `i=2, a[i]` reads the new `i`; `read` answers
 * the element's stored text, null when unset.
 */
export interface ElementOps {
  resolve(name: string, subscript: string, env: Readonly<Record<string, string>>): string
  read(name: string, key: string): string | null
  /**
   * Whether a name holds an associative array, whose subscript is a key.
   * Given, the evaluator evaluates an indexed subscript itself, in its own
   * record, and hands `resolve` the index; absent, `resolve` evaluates the
   * subscript text (a caller outside a session).
   */
  isAssoc?(name: string): boolean
}

/**
 * One assignment an arithmetic evaluation produced. `key` is the
 * canonical subscript `ElementOps.resolve` gave, or null for a bare
 * name (which lands as element 0 of an array, or the scalar itself).
 */
export interface ArithWrite {
  readonly name: string
  readonly key: string | null
  readonly value: string
}

/**
 * What one arithmetic evaluation produced: the value plus the
 * assignments made, one per target, in the order of each target's last
 * write, for the caller to land through the session door. Bare and
 * subscripted targets share the one sequence, because a bare name
 * aliases element 0 and `((a[0]=1, a=2))` has to leave 2.
 */
export interface ArithResult {
  readonly value: bigint
  readonly writes: readonly ArithWrite[]
}

export const NodeType = Object.freeze({
  COMMAND: 'command',
  PIPELINE: 'pipeline',
  LIST: 'list',
  REDIRECTED_STATEMENT: 'redirected_statement',
  SUBSHELL: 'subshell',
  IF_STATEMENT: 'if_statement',
  FOR_STATEMENT: 'for_statement',
  WHILE_STATEMENT: 'while_statement',
  CASE_STATEMENT: 'case_statement',
  CASE_ITEM: 'case_item',
  FUNCTION_DEFINITION: 'function_definition',
  DECLARATION_COMMAND: 'declaration_command',
  UNSET_COMMAND: 'unset_command',
  TEST_COMMAND: 'test_command',
  COMPOUND_STATEMENT: 'compound_statement',
  NEGATED_COMMAND: 'negated_command',
  VARIABLE_ASSIGNMENT: 'variable_assignment',
  VARIABLE_ASSIGNMENTS: 'variable_assignments',
  FOR: 'for',
  SELECT: 'select',
  WHILE: 'while',
  UNTIL: 'until',
  EXPORT: 'export',
  LOCAL: 'local',
  WORD: 'word',
  NUMBER: 'number',
  COMMAND_NAME: 'command_name',
  VARIABLE_NAME: 'variable_name',
  SIMPLE_EXPANSION: 'simple_expansion',
  EXPANSION: 'expansion',
  COMMAND_SUBSTITUTION: 'command_substitution',
  ARITHMETIC_EXPANSION: 'arithmetic_expansion',
  CONCATENATION: 'concatenation',
  BRACE_EXPRESSION: 'brace_expression',
  STRING: 'string',
  STRING_CONTENT: 'string_content',
  RAW_STRING: 'raw_string',
  ANSI_C_STRING: 'ansi_c_string',
  TRANSLATED_STRING: 'translated_string',
  PROCESS_SUBSTITUTION: 'process_substitution',
  EXTGLOB_PATTERN: 'extglob_pattern',
  REGEX: 'regex',
  DO_GROUP: 'do_group',
  ELIF_CLAUSE: 'elif_clause',
  ELSE_CLAUSE: 'else_clause',
  FILE_REDIRECT: 'file_redirect',
  HEREDOC_REDIRECT: 'heredoc_redirect',
  HEREDOC_BODY: 'heredoc_body',
  HEREDOC_START: 'heredoc_start',
  HEREDOC_END: 'heredoc_end',
  HEREDOC_CONTENT: 'heredoc_content',
  HERESTRING_REDIRECT: 'herestring_redirect',
  FILE_DESCRIPTOR: 'file_descriptor',
  ARRAY: 'array',
  AND: '&&',
  OR: '||',
  SEMI: ';',
  BACKGROUND: '&',
  PIPE: '|',
  PIPE_STDERR: '|&',
  REDIRECT_OUT: '>',
  REDIRECT_CLOBBER: '>|',
  REDIRECT_APPEND: '>>',
  REDIRECT_IN: '<',
  REDIRECT_STDERR: '>&',
  REDIRECT_DUP_IN: '<&',
  REDIRECT_CLOSE_OUT: '>&-',
  REDIRECT_CLOSE_IN: '<&-',
  REDIRECT_BOTH: '&>',
  REDIRECT_BOTH_APPEND: '&>>',
  HEREDOC_START_TOKEN: '<<',
  HERESTRING_TOKEN: '<<<',
  OPEN_PAREN: '(',
  CLOSE_PAREN: ')',
  OPEN_BRACE: '{',
  CLOSE_BRACE: '}',
  OPEN_BRACKET: '[',
  CLOSE_BRACKET: ']',
  DOUBLE_OPEN_PAREN: '((',
  DOUBLE_CLOSE_PAREN: '))',
  DOUBLE_SEMICOLON: ';;',
  DQUOTE: '"',
  IF: 'if',
  THEN: 'then',
  ELIF: 'elif',
  ELSE: 'else',
  FI: 'fi',
  IN: 'in',
  DO: 'do',
  DONE: 'done',
  CASE: 'case',
  ESAC: 'esac',
  FUNCTION: 'function',
  PROGRAM: 'program',
  BINARY_EXPRESSION: 'binary_expression',
  UNARY_EXPRESSION: 'unary_expression',
  NEGATION_EXPRESSION: 'negation_expression',
  PARENTHESIZED_EXPRESSION: 'parenthesized_expression',
  TERNARY_EXPRESSION: 'ternary_expression',
  POSTFIX_EXPRESSION: 'postfix_expression',
  ARITH_OPEN: '((',
  ARITH_CLOSE: '))',
  C_STYLE_FOR_STATEMENT: 'c_style_for_statement',
  TEST_OPERATOR: 'test_operator',
  SPECIAL_VARIABLE_NAME: 'special_variable_name',
  COMMENT: 'comment',
  ERROR: 'ERROR',
} as const)

export type NodeType = (typeof NodeType)[keyof typeof NodeType]

export interface OptionWord {
  // Shell options the word turns on or off, in the order written.
  settings: [string, boolean][]
  // Cluster letters that name no shell option. `set` ignores them;
  // shell startup reads its own startup letters out of them and refuses
  // the rest.
  other: string
  // Words the option took, 2 for the `-o NAME` form.
  consumed: number
}

export const RedirectKind = Object.freeze({
  STDOUT: 'stdout',
  STDERR: 'stderr',
  STDIN: 'stdin',
  STDERR_TO_STDOUT: 'stderr_to_stdout',
  HEREDOC: 'heredoc',
  HERESTRING: 'herestring',
  // `N>&word` with a word that is neither a number nor `-` on a
  // descriptor other than 1: bash refuses it as `word: ambiguous redirect`
  // before the command runs, so the target is kept for the message and
  // nothing is opened.
  AMBIGUOUS: 'ambiguous',
} as const)

export type RedirectKind = (typeof RedirectKind)[keyof typeof RedirectKind]

export interface RedirectInit {
  // The descriptor the redirect claims, FD_BOTH (-1) for `&>`.
  fd: number
  // The target path, the dup'd fd number, or FD_CLOSE (-1) for `>&-`.
  target: unknown
  // The tree-sitter node the target came from.
  targetNode?: unknown
  // Which stream the redirect moves.
  kind?: RedirectKind
  // Whether the write appends rather than truncates.
  append?: boolean
  // Whether the operator was `>|`, which overrides `set -C` for this one
  // redirect and nothing else.
  clobber?: boolean
  // The process substitution feeding the target.
  pipeline?: unknown
  // Whether the target undergoes expansion.
  expandVars?: boolean
}

export class Redirect {
  readonly fd: number
  readonly target: unknown
  readonly targetNode: unknown
  readonly kind: RedirectKind
  readonly append: boolean
  readonly clobber: boolean
  pipeline: unknown
  readonly expandVars: boolean

  constructor(init: RedirectInit) {
    this.fd = init.fd
    this.target = init.target
    this.targetNode = init.targetNode ?? null
    this.kind = init.kind ?? RedirectKind.STDOUT
    this.append = init.append ?? false
    this.clobber = init.clobber ?? false
    this.pipeline = init.pipeline ?? null
    this.expandVars = init.expandVars ?? true
  }
}

// Shell builtin command names: commands that don't touch the
// filesystem, handled by the executor and never dispatched to a mount.
// Listed by tier and group; BUILTIN_GROUP below is the source of truth.
/**
 * Which way a process substitution carries bytes. `<(cmd)` is INPUT
 * (the inner command's stdout feeds our stdin), `>(cmd)` is OUTPUT
 * (our stdout feeds the inner command's stdin).
 */
export const ProcessSubDirection = {
  INPUT: 'input',
  OUTPUT: 'output',
} as const
export type ProcessSubDirection = (typeof ProcessSubDirection)[keyof typeof ProcessSubDirection]

export const ShellBuiltin = Object.freeze({
  // grammar: the shell's own language
  // -- working directory
  PWD: 'pwd',
  CD: 'cd',
  // -- variables and positional parameters
  EXPORT: 'export',
  UNSET: 'unset',
  LOCAL: 'local',
  // declare / typeset / readonly are parser-owned (the declaration node
  // runs them, they never reach the executor's table); rows here so
  // `type` reports them and the tiers file them as grammar.
  DECLARE: 'declare',
  TYPESET: 'typeset',
  READONLY: 'readonly',
  SET: 'set',
  READ: 'read',
  MAPFILE: 'mapfile',
  READARRAY: 'readarray',
  SHIFT: 'shift',
  GETOPTS: 'getopts',
  LET: 'let',
  // -- shell state
  TRAP: 'trap',
  SHOPT: 'shopt',
  UMASK: 'umask',
  ALIAS: 'alias',
  UNALIAS: 'unalias',
  EXEC: 'exec',
  // -- conditions
  TEST: 'test',
  BRACKET: '[',
  DOUBLE_BRACKET: '[[',
  // -- output
  ECHO: 'echo',
  PRINTF: 'printf',
  // -- running lines
  SOURCE: 'source',
  DOT: '.',
  EVAL: 'eval',
  COMMAND: 'command',
  // -- name lookup
  TYPE: 'type',
  WHICH: 'which',
  // -- status and control flow
  TRUE: 'true',
  FALSE: 'false',
  COLON: ':',
  BREAK: 'break',
  CONTINUE: 'continue',
  RETURN: 'return',
  EXIT: 'exit',
  // tools: programs the line invokes
  // -- environment and identity
  PRINTENV: 'printenv',
  ENV: 'env',
  WHOAMI: 'whoami',
  // -- manuals and history
  MAN: 'man',
  HISTORY: 'history',
  // -- job control
  WAIT: 'wait',
  FG: 'fg',
  KILL: 'kill',
  JOBS: 'jobs',
  DISOWN: 'disown',
  PS: 'ps',
  // -- clock
  SLEEP: 'sleep',
  // -- nested shells
  BASH: 'bash',
  SH: 'sh',
  // -- interpreters
  PYTHON: 'python',
  PYTHON3: 'python3',
  NODE: 'node',
  JS: 'js',
  // -- command runners
  XARGS: 'xargs',
  TIMEOUT: 'timeout',
} as const)

export type ShellBuiltin = (typeof ShellBuiltin)[keyof typeof ShellBuiltin]

// Which of two things a shell builtin is, as taxonomy. GRAMMAR is the
// shell's own language: it moves session state, control flow, or the
// line's own streams, and never reaches a backend except through the op
// dispatcher. TOOL is a program the line invokes that a real system
// ships as a separate binary, or that reaches beyond the session (an
// interpreter, the job table, the history recording). The permission
// layer reads no tier: every builtin is a subject of a command
// allowlist exactly like an installed command, and both tiers are
// deniable by name.
export const BuiltinTier = Object.freeze({
  GRAMMAR: 'grammar',
  TOOL: 'tool',
} as const)

export type BuiltinTier = (typeof BuiltinTier)[keyof typeof BuiltinTier]

// The family a shell builtin belongs to, one level below the tier.
// Every group sits in exactly one tier (GROUP_TIER), so filing a word in
// a group also files its tier; BUILTIN_GROUP is the one row per word. A
// listing (bare `man`) or a rule can name a group where it would
// otherwise have to spell out the words.
export const BuiltinGroup = Object.freeze({
  // grammar
  WORKING_DIRECTORY: 'working-directory',
  VARIABLES: 'variables',
  SHELL_STATE: 'shell-state',
  CONDITIONS: 'conditions',
  OUTPUT: 'output',
  RUNNING_LINES: 'running-lines',
  NAME_LOOKUP: 'name-lookup',
  CONTROL_FLOW: 'control-flow',
  // tools
  ENVIRONMENT: 'environment',
  MANUALS_AND_HISTORY: 'manuals-and-history',
  JOB_CONTROL: 'job-control',
  CLOCK: 'clock',
  NESTED_SHELLS: 'nested-shells',
  INTERPRETERS: 'interpreters',
  COMMAND_RUNNERS: 'command-runners',
} as const)

export type BuiltinGroup = (typeof BuiltinGroup)[keyof typeof BuiltinGroup]

/**
 * The structural shape of a tree-sitter syntax node, so consumers can
 * walk a parsed line without depending on a concrete tree-sitter
 * binding (web-tree-sitter here, tree_sitter in Python). Mirrors the
 * Python side reading nodes through shell.types.
 */
export interface TSNodeLike {
  type: string
  text: string
  children: TSNodeLike[]
  namedChildren: TSNodeLike[]
  parent?: TSNodeLike | null
  isNamed?: boolean
  isMissing?: boolean
  startIndex?: number
  endIndex?: number
  startPosition?: { row: number; column: number }
  endPosition?: { row: number; column: number }
  /**
   * Tree-node identity. Web-tree-sitter hands out a fresh wrapper per
   * lookup, so `===` cannot tell one node from a re-read of it; the
   * env-plane name walk uses this to skip an assignment's own target.
   */
  id?: number
  /** Field lookup (`variable_assignment.name`), as web-tree-sitter spells it. */
  childForFieldName?(fieldName: string): TSNodeLike | null
}

/**
 * One piece of a backtick region as the evaluator lexes it: a command a
 * pair encloses, or the literal text between two pairs. `text` is the
 * segment's text, a command's with its escapes resolved, as the nested
 * line parses it; `start` and `end` span its raw text in the region
 * (for a command, up to the closing backtick). Mirrors the Python
 * BacktickSegment.
 */
export interface BacktickSegment {
  readonly text: string
  readonly command: boolean
  readonly start: number
  readonly end: number
}
