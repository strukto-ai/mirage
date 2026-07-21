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
  REDIRECT_APPEND: '>>',
  REDIRECT_IN: '<',
  REDIRECT_STDERR: '>&',
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
  TEST_OPERATOR: 'test_operator',
  SPECIAL_VARIABLE_NAME: 'special_variable_name',
  COMMENT: 'comment',
  ERROR: 'ERROR',
} as const)

export type NodeType = (typeof NodeType)[keyof typeof NodeType]

// Node types whose failure never triggers `set -e` by shape alone.
// Lists are NOT exempt: bash exits when the command after the final
// `&&`/`||` fails; short-circuit failures set Session.errexitImmune
// instead, so the executor loops skip only those.
export const ERREXIT_EXEMPT_TYPES: ReadonlySet<string> = new Set<string>([NodeType.NEGATED_COMMAND])

export const SET_FLAG_TO_OPTION: Readonly<Record<string, string>> = Object.freeze({
  e: 'errexit',
  u: 'nounset',
  x: 'xtrace',
  f: 'noglob',
})

export const RedirectKind = Object.freeze({
  STDOUT: 'stdout',
  STDERR: 'stderr',
  STDIN: 'stdin',
  STDERR_TO_STDOUT: 'stderr_to_stdout',
  HEREDOC: 'heredoc',
  HERESTRING: 'herestring',
} as const)

export type RedirectKind = (typeof RedirectKind)[keyof typeof RedirectKind]

export interface RedirectInit {
  fd: number
  target: unknown
  targetNode?: unknown
  kind?: RedirectKind
  append?: boolean
  pipeline?: unknown
  expandVars?: boolean
}

export class Redirect {
  readonly fd: number
  readonly target: unknown
  readonly targetNode: unknown
  readonly kind: RedirectKind
  readonly append: boolean
  pipeline: unknown
  readonly expandVars: boolean

  constructor(init: RedirectInit) {
    this.fd = init.fd
    this.target = init.target
    this.targetNode = init.targetNode ?? null
    this.kind = init.kind ?? RedirectKind.STDOUT
    this.append = init.append ?? false
    this.pipeline = init.pipeline ?? null
    this.expandVars = init.expandVars ?? true
  }
}

export const ShellBuiltin = Object.freeze({
  PWD: 'pwd',
  CD: 'cd',
  EXPORT: 'export',
  UNSET: 'unset',
  LOCAL: 'local',
  SET: 'set',
  PRINTENV: 'printenv',
  WHOAMI: 'whoami',
  MAN: 'man',
  HISTORY: 'history',
  TRUE: 'true',
  FALSE: 'false',
  SOURCE: 'source',
  DOT: '.',
  EVAL: 'eval',
  READ: 'read',
  SHIFT: 'shift',
  TRAP: 'trap',
  TEST: 'test',
  BRACKET: '[',
  DOUBLE_BRACKET: '[[',
  WAIT: 'wait',
  FG: 'fg',
  KILL: 'kill',
  JOBS: 'jobs',
  PS: 'ps',
  ECHO: 'echo',
  PRINTF: 'printf',
  SLEEP: 'sleep',
  BASH: 'bash',
  SH: 'sh',
  PYTHON: 'python',
  PYTHON3: 'python3',
  NODE: 'node',
  JS: 'js',
  XARGS: 'xargs',
  TIMEOUT: 'timeout',
  COMMAND: 'command',
  BREAK: 'break',
  CONTINUE: 'continue',
  RETURN: 'return',
  EXIT: 'exit',
} as const)

export type ShellBuiltin = (typeof ShellBuiltin)[keyof typeof ShellBuiltin]
