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

import { classify } from '@struktoai/mirage-core/errors/classify'
import { posixPhrase } from '@struktoai/mirage-core/errors/posix'
import type { FsCondition } from '@struktoai/mirage-core/errors/types'
import { PolicyDenied } from '@struktoai/mirage-core/policy/errors'
import type { JsonValue } from '@struktoai/mirage-core/types'
import { z } from '@struktoai/mirage-core/vfs/secrets'
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { stderr } from 'node:process'
import { format } from 'node:util'

const logger = {
  error: (...args: unknown[]): void => {
    stderr.write(`${format(...args)}\n`)
  },
}

/** What went wrong, for a client to branch on. Each answers one status (`STATUS`). Mirrors Python's `ErrorCode`. */
export const ErrorCode = {
  INVALID_REQUEST: 'invalid_request',
  INVALID_JSON: 'invalid_json',
  MISSING_FIELD: 'missing_field',
  UNKNOWN_FIELD: 'unknown_field',
  INVALID_VALUE: 'invalid_value',
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  POLICY_REFUSED: 'policy_refused',
  HOST_NOT_ALLOWED: 'host_not_allowed',
  ORIGIN_NOT_ALLOWED: 'origin_not_allowed',
  STORAGE_FULL: 'storage_full',
  NOT_FOUND: 'not_found',
  METHOD_NOT_ALLOWED: 'method_not_allowed',
  CONFLICT: 'conflict',
  ALREADY_EXISTS: 'already_exists',
  WORKSPACE_BUSY: 'workspace_busy',
  WORKSPACE_STOPPED: 'workspace_stopped',
  STALE_WRITE: 'stale_write',
  TOO_LARGE: 'too_large',
  RATE_LIMITED: 'rate_limited',
  SESSION_LIMIT: 'session_limit',
  CANCELED: 'canceled',
  INTERNAL: 'internal',
  NOT_SUPPORTED: 'not_supported',
  UNAVAILABLE: 'unavailable',
  SERVER_FULL: 'server_full',
  SHUTTING_DOWN: 'shutting_down',
} as const

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

export const STATUS: Readonly<Record<ErrorCode, number>> = {
  invalid_request: 400,
  invalid_json: 400,
  missing_field: 400,
  unknown_field: 400,
  invalid_value: 400,
  unauthorized: 401,
  forbidden: 403,
  policy_refused: 403,
  host_not_allowed: 403,
  origin_not_allowed: 403,
  storage_full: 403,
  not_found: 404,
  method_not_allowed: 405,
  conflict: 409,
  already_exists: 409,
  workspace_busy: 409,
  workspace_stopped: 409,
  stale_write: 409,
  too_large: 413,
  rate_limited: 429,
  session_limit: 429,
  canceled: 499,
  internal: 500,
  not_supported: 501,
  unavailable: 503,
  server_full: 503,
  shutting_down: 503,
}

export const ERRNO_CODE: Readonly<Record<FsCondition, ErrorCode>> = {
  ENOENT: 'not_found',
  NO_XATTR: 'not_found',
  EACCES: 'forbidden',
  EPERM: 'forbidden',
  EROFS: 'forbidden',
  EEXIST: 'already_exists',
  ENOTEMPTY: 'conflict',
  EBUSY: 'conflict',
  STALE_WRITE: 'stale_write',
  ENOTDIR: 'invalid_request',
  EISDIR: 'invalid_request',
  EINVAL: 'invalid_request',
  EXDEV: 'invalid_request',
  ELOOP: 'invalid_request',
  ENOTSUP: 'invalid_request',
  EFBIG: 'invalid_request',
  EDQUOT: 'storage_full',
  EIO: 'internal',
  EPIPE: 'internal',
  EBADF: 'internal',
}

export const INTERNAL_MESSAGE = 'internal server error'

/** What a value of each kind must be, by the type a schema expected. */
export const EXPECTATION: Readonly<Record<string, string>> = {
  string: 'a string',
  int: 'an integer',
  integer: 'an integer',
  number: 'a number',
  boolean: 'a boolean',
  object: 'an object',
  record: 'an object',
  map: 'an object',
  array: 'an array',
}

/** Where a framework error leaves the request, by Fastify's error code. */
export const FRAMEWORK: Readonly<Record<string, readonly [ErrorCode, string]>> = {
  FST_ERR_CTP_INVALID_JSON_BODY: ['invalid_json', 'body must be JSON'],
  FST_ERR_CTP_EMPTY_JSON_BODY: ['invalid_json', 'body must be JSON'],
  FST_ERR_CTP_BODY_TOO_LARGE: ['too_large', 'request body too large'],
  FST_ERR_BAD_URL: ['invalid_request', 'path is not percent-encoded'],
}

/** The optional fields an error carries beside its code and message. */
export interface HttpErrorOptions {
  param?: string | undefined
  errno?: string | undefined
  refusal?: Record<string, JsonValue> | null | undefined
  missing?: readonly string[] | undefined
  headers?: Readonly<Record<string, string>> | undefined
  cause?: unknown
}

/**
 * A request answered with an error: its code picks the status, and the body is
 * `{"error": {...}}` with the code, the message and the optional fields given.
 * The message never carries a value taken from the request body, a header or
 * the query. Mirrors Python's `HttpError`.
 */
export class HttpError extends Error {
  readonly param: string | undefined
  readonly errno: string | undefined
  readonly refusal: Record<string, JsonValue> | null | undefined
  readonly missing: readonly string[] | undefined
  readonly headers: Readonly<Record<string, string>>

  constructor(
    readonly code: ErrorCode,
    message: string,
    options: HttpErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.param = options.param
    this.errno = options.errno
    this.refusal = options.refusal
    this.missing = options.missing
    this.headers = options.headers ?? {}
  }

  get status(): number {
    return STATUS[this.code]
  }

  /** The error object: the code, the message and the optional fields set. */
  record(): Record<string, JsonValue> {
    const error: Record<string, JsonValue> = { code: this.code, message: this.message }
    if (this.param !== undefined) error.param = this.param
    if (this.errno !== undefined) error.errno = this.errno
    if (this.refusal !== undefined && this.refusal !== null) error.refusal = this.refusal
    if (this.missing !== undefined) error.missing = [...this.missing]
    return error
  }

  /** The answer's body. */
  body(): { error: Record<string, JsonValue> } {
    return { error: this.record() }
  }
}

/**
 * A route needs a live workspace the caller has none of. The app answers
 * `workspace_stopped` when the caller's workspace is stopped, else
 * `not_found`. Mirrors Python's `WorkspaceMissing`.
 */
export class WorkspaceMissing extends HttpError {
  constructor(readonly workspaceId: string) {
    super('not_found', 'workspace not found')
  }

  /** The answer when the workspace is stopped. */
  stopped(): HttpError {
    return new HttpError(
      'workspace_stopped',
      `workspace '${this.workspaceId}' is stopped; start it first`,
    )
  }
}

/**
 * Answer `error` on `reply`, with its status, headers and body. Mirrors
 * Python's `error_response`.
 */
export function errorResponse<
  R extends {
    code(status: number): unknown
    header(name: string, value: string): unknown
    send(payload?: unknown): unknown
  },
>(reply: R, error: HttpError): R {
  for (const [name, value] of Object.entries(error.headers)) reply.header(name, value)
  reply.code(error.status)
  reply.send(error.body())
  return reply
}

/**
 * A file call's failure: the errno it names picks the code, a policy's
 * refusal answers `policy_refused` with its record, and an unnamed failure is
 * `internal`, whose cause stays in the logs. Mirrors Python's `fs_error`.
 */
export function fsError(err: unknown): HttpError {
  const condition = classify(err)
  if (condition === null) return new HttpError('internal', INTERNAL_MESSAGE)
  if (err instanceof PolicyDenied) {
    const refusal = err.refusal
    return new HttpError('policy_refused', posixPhrase(condition), {
      errno: condition,
      refusal:
        refusal === null
          ? null
          : {
              kind: refusal.kind,
              reason: refusal.reason,
              policy: refusal.policy,
              ask_id: refusal.askId,
            },
    })
  }
  return new HttpError(ERRNO_CODE[condition], posixPhrase(condition), { errno: condition })
}

/** `one of a, b, c` from a schema's choices, never the value sent. Mirrors Python's `one_of`. */
export function oneOf(choices: readonly unknown[]): string {
  return `one of ${choices.map((choice) => String(choice)).join(', ')}`
}

/** A dotted path such as `mounts[0].mode` for a field's place. Mirrors Python's `param_of`. */
export function paramOf(path: readonly PropertyKey[]): string {
  let param = ''
  for (const key of path) {
    if (typeof key === 'number') param += `[${String(key)}]`
    else if (typeof key === 'string') param += param === '' ? key : `.${key}`
  }
  return param
}

/**
 * The first of a schema's issues as one error: declared fields before unknown
 * keys, each in order. The validator's own text and the value sent stay out,
 * save a refinement's message, which the server wrote. `body` is the value
 * checked, or undefined when the caller does not have it, so no field reads
 * as missing; `under` is the request field it sits at. Mirrors Python's
 * `validation_error`.
 */
export function validationError(
  error: z.ZodError,
  body: unknown,
  under: readonly string[] = [],
): HttpError {
  const issues = [...error.issues].sort(
    (a, b) => Number(a.code === 'unrecognized_keys') - Number(b.code === 'unrecognized_keys'),
  )
  const issue = issues[0]
  if (issue === undefined) return new HttpError('invalid_request', 'body must be a JSON object')
  const path = issue.path.filter((key) => typeof key !== 'symbol')
  if (issue.code === 'unrecognized_keys') {
    const param = paramOf([...under, ...path, issue.keys[0] ?? ''])
    return new HttpError('unknown_field', `${param} is not a known field`, { param })
  }
  const param = paramOf([...under, ...path])
  if (param === '') return new HttpError('invalid_request', 'body must be a JSON object')
  let value: unknown = body
  for (const key of path) {
    value =
      value !== null && typeof value === 'object'
        ? (value as Record<PropertyKey, unknown>)[key]
        : undefined
  }
  if (value === undefined && body !== undefined) {
    return new HttpError('missing_field', `${param} is required`, { param })
  }
  if (issue.code === 'custom') return new HttpError('invalid_value', issue.message, { param })
  const must =
    issue.code === 'invalid_type'
      ? EXPECTATION[issue.expected]
      : issue.code === 'invalid_value'
        ? oneOf(issue.values)
        : undefined
  return new HttpError(
    'invalid_value',
    must === undefined ? `${param} is not valid` : `${param} must be ${must}`,
    { param },
  )
}

/** A Fastify schema (ajv) failure as one error, worded as `validationError` words a zod one. */
function schemaError(error: FastifyError): HttpError {
  const issues = [...(error.validation ?? [])].sort(
    (a, b) =>
      Number(a.keyword === 'additionalProperties') - Number(b.keyword === 'additionalProperties'),
  )
  const issue = issues[0]
  if (issue === undefined) return new HttpError('invalid_request', 'body must be a JSON object')
  const path = issue.instancePath
    .split('/')
    .filter((key) => key !== '')
    .map((key) => (/^\d+$/.test(key) ? Number(key) : key))
  const params = issue.params
  if (issue.keyword === 'required') {
    const param = paramOf([...path, String(params.missingProperty)])
    return new HttpError('missing_field', `${param} is required`, { param })
  }
  if (issue.keyword === 'additionalProperties') {
    const param = paramOf([...path, String(params.additionalProperty)])
    return new HttpError('unknown_field', `${param} is not a known field`, { param })
  }
  const param = paramOf(path)
  if (param === '') return new HttpError('invalid_request', 'body must be a JSON object')
  const must =
    issue.keyword === 'type' ? EXPECTATION[String(params.type).split(',')[0] ?? ''] : undefined
  return new HttpError(
    'invalid_value',
    must === undefined ? `${param} is not valid` : `${param} must be ${must}`,
    { param },
  )
}

/** Any error a route threw, or the framework met, as the one it answers. Mirrors Python's `error_of`. */
export function errorOf(err: unknown): HttpError {
  if (err instanceof HttpError) return err
  const framework = err as Partial<FastifyError> | null
  if (framework?.validation !== undefined) return schemaError(err as FastifyError)
  const known = framework?.code === undefined ? undefined : FRAMEWORK[framework.code]
  if (known !== undefined) return new HttpError(known[0], known[1])
  logger.error('mirage: unhandled error', err)
  return new HttpError('internal', INTERNAL_MESSAGE)
}

/** An error a route threw, or the framework met, as its response. Mirrors Python's `answer`. */
export function answer(err: unknown, _req: FastifyRequest, reply: FastifyReply): void {
  void errorResponse(reply, errorOf(err))
}

/**
 * Answer every error `app` meets in the one body, through `handler` (`answer`
 * unless a host answers some errors its own way). Mirrors Python's
 * `register_error_handlers`.
 */
export function registerErrorHandlers(
  app: FastifyInstance,
  handler: (err: unknown, req: FastifyRequest, reply: FastifyReply) => unknown = answer,
): void {
  app.setErrorHandler(handler)
  app.setNotFoundHandler((_req, reply) => {
    void errorResponse(reply, new HttpError('not_found', 'not found'))
  })
}

/**
 * A loader's refusal of what the caller sent: a schema's failure worded as
 * `validationError` words one, any other the loader's own text. `value` is
 * what the loader read, `under` the request field it sits at. Mirrors
 * Python's `loader_error`.
 */
export function loaderError(
  err: unknown,
  under: readonly string[] = [],
  value?: unknown,
): HttpError {
  if (err instanceof z.ZodError) return validationError(err, value, under)
  return new HttpError('invalid_request', err instanceof Error ? err.message : String(err))
}
