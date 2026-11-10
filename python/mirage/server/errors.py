# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import logging
import re
from collections.abc import Mapping, Sequence
from dataclasses import asdict
from enum import StrEnum
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from pydantic import ValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import JSONResponse, Response

from mirage.errors.classify import classify
from mirage.errors.posix import posix_phrase
from mirage.errors.types import FsCondition
from mirage.policy.errors import PolicyDenied
from mirage.types import JsonValue


class ErrorCode(StrEnum):
    """What went wrong, for a client to branch on. Each answers one
    status (``STATUS``)."""

    INVALID_REQUEST = "invalid_request"
    INVALID_JSON = "invalid_json"
    MISSING_FIELD = "missing_field"
    UNKNOWN_FIELD = "unknown_field"
    INVALID_VALUE = "invalid_value"
    UNAUTHORIZED = "unauthorized"
    FORBIDDEN = "forbidden"
    POLICY_REFUSED = "policy_refused"
    HOST_NOT_ALLOWED = "host_not_allowed"
    ORIGIN_NOT_ALLOWED = "origin_not_allowed"
    STORAGE_FULL = "storage_full"
    NOT_FOUND = "not_found"
    METHOD_NOT_ALLOWED = "method_not_allowed"
    CONFLICT = "conflict"
    ALREADY_EXISTS = "already_exists"
    WORKSPACE_BUSY = "workspace_busy"
    WORKSPACE_STOPPED = "workspace_stopped"
    STALE_WRITE = "stale_write"
    TOO_LARGE = "too_large"
    RATE_LIMITED = "rate_limited"
    SESSION_LIMIT = "session_limit"
    CANCELED = "canceled"
    INTERNAL = "internal"
    NOT_SUPPORTED = "not_supported"
    UNAVAILABLE = "unavailable"
    SERVER_FULL = "server_full"
    SHUTTING_DOWN = "shutting_down"


STATUS: dict[ErrorCode, int] = {
    ErrorCode.INVALID_REQUEST: 400,
    ErrorCode.INVALID_JSON: 400,
    ErrorCode.MISSING_FIELD: 400,
    ErrorCode.UNKNOWN_FIELD: 400,
    ErrorCode.INVALID_VALUE: 400,
    ErrorCode.UNAUTHORIZED: 401,
    ErrorCode.FORBIDDEN: 403,
    ErrorCode.POLICY_REFUSED: 403,
    ErrorCode.HOST_NOT_ALLOWED: 403,
    ErrorCode.ORIGIN_NOT_ALLOWED: 403,
    ErrorCode.STORAGE_FULL: 403,
    ErrorCode.NOT_FOUND: 404,
    ErrorCode.METHOD_NOT_ALLOWED: 405,
    ErrorCode.CONFLICT: 409,
    ErrorCode.ALREADY_EXISTS: 409,
    ErrorCode.WORKSPACE_BUSY: 409,
    ErrorCode.WORKSPACE_STOPPED: 409,
    ErrorCode.STALE_WRITE: 409,
    ErrorCode.TOO_LARGE: 413,
    ErrorCode.RATE_LIMITED: 429,
    ErrorCode.SESSION_LIMIT: 429,
    ErrorCode.CANCELED: 499,
    ErrorCode.INTERNAL: 500,
    ErrorCode.NOT_SUPPORTED: 501,
    ErrorCode.UNAVAILABLE: 503,
    ErrorCode.SERVER_FULL: 503,
    ErrorCode.SHUTTING_DOWN: 503,
}

ERRNO_CODE: dict[FsCondition, ErrorCode] = {
    FsCondition.ENOENT: ErrorCode.NOT_FOUND,
    FsCondition.NO_XATTR: ErrorCode.NOT_FOUND,
    FsCondition.EACCES: ErrorCode.FORBIDDEN,
    FsCondition.EPERM: ErrorCode.FORBIDDEN,
    FsCondition.EROFS: ErrorCode.FORBIDDEN,
    FsCondition.EEXIST: ErrorCode.ALREADY_EXISTS,
    FsCondition.ENOTEMPTY: ErrorCode.CONFLICT,
    FsCondition.EBUSY: ErrorCode.CONFLICT,
    FsCondition.STALE_WRITE: ErrorCode.STALE_WRITE,
    FsCondition.ENOTDIR: ErrorCode.INVALID_REQUEST,
    FsCondition.EISDIR: ErrorCode.INVALID_REQUEST,
    FsCondition.EINVAL: ErrorCode.INVALID_REQUEST,
    FsCondition.EXDEV: ErrorCode.INVALID_REQUEST,
    FsCondition.ELOOP: ErrorCode.INVALID_REQUEST,
    FsCondition.ENOTSUP: ErrorCode.INVALID_REQUEST,
    FsCondition.EFBIG: ErrorCode.INVALID_REQUEST,
    FsCondition.EDQUOT: ErrorCode.STORAGE_FULL,
    FsCondition.EIO: ErrorCode.INTERNAL,
    FsCondition.EPIPE: ErrorCode.INTERNAL,
    FsCondition.EBADF: ErrorCode.INTERNAL,
}

INTERNAL_MESSAGE = "internal server error"

# What a value of each kind must be, by the validator's issue type.
EXPECTATION: dict[str, str] = {
    "string_type": "a string",
    "int_type": "an integer",
    "int_parsing": "an integer",
    "int_from_float": "an integer",
    "float_type": "a number",
    "float_parsing": "a number",
    "bool_type": "a boolean",
    "bool_parsing": "a boolean",
    "dict_type": "an object",
    "model_type": "an object",
    "model_attributes_type": "an object",
    "list_type": "an array",
}

# Where a framework error's status leaves the request, by status.
FRAMEWORK: dict[int, tuple[ErrorCode, str]] = {
    400: (ErrorCode.INVALID_JSON, "body must be JSON"),
    404: (ErrorCode.NOT_FOUND, "not found"),
    405: (ErrorCode.METHOD_NOT_ALLOWED, "method not allowed"),
    413: (ErrorCode.TOO_LARGE, "request body too large"),
}

# Where in a request a validator's ``loc`` starts.
PLACES = ("path", "query", "body")

# A union member's tag in a pydantic ``loc``, which names no field.
UNION_TAG = re.compile(
    r"^[a-z_]+\[.*\]$|^(str|int|float|bool|none|dict|list)$"
)

logger = logging.getLogger(__name__)


class HttpError(Exception):
    """A request answered with an error: its code picks the status, and
    the body is ``{"error": {...}}`` with the code, the message and the
    optional fields given.

    Args:
        code (ErrorCode): what went wrong.
        message (str): human text; never a value taken from the request
            body, a header or the query.
        param (str | None): the request field at fault.
        errno (str | None): the POSIX condition of a failed file call.
        refusal (dict[str, JsonValue] | None): a policy's refusal record.
        missing (list[str] | None): names that must exist first.
        headers (Mapping[str, str] | None): headers to answer with.
    """

    def __init__(
        self,
        code: ErrorCode,
        message: str,
        *,
        param: str | None = None,
        errno: str | None = None,
        refusal: dict[str, JsonValue] | None = None,
        missing: list[str] | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.param = param
        self.errno = errno
        self.refusal = refusal
        self.missing = missing
        self.headers = dict(headers or {})

    @property
    def status(self) -> int:
        return STATUS[self.code]

    def body(self) -> dict[str, JsonValue]:
        """The answer's body."""
        return {"error": self.record()}

    def record(self) -> dict[str, JsonValue]:
        """The error object: the body's ``error``, and a JSON-RPC
        error's ``data``."""
        error: dict[str, JsonValue] = {
            "code": self.code.value,
            "message": self.message,
        }
        if self.param is not None:
            error["param"] = self.param
        if self.errno is not None:
            error["errno"] = self.errno
        if self.refusal is not None:
            error["refusal"] = self.refusal
        if self.missing is not None:
            error["missing"] = list(self.missing)
        return error

    def response(self) -> JSONResponse:
        """The error as a response."""
        return JSONResponse(
            status_code=self.status, content=self.body(), headers=self.headers
        )


class WorkspaceMissing(HttpError):
    """A route needs a live workspace the caller has none of. The app
    answers ``workspace_stopped`` when the caller's workspace is stopped,
    else ``not_found``.

    Args:
        workspace_id (str): the id the route names.
    """

    def __init__(self, workspace_id: str) -> None:
        super().__init__(ErrorCode.NOT_FOUND, "workspace not found")
        self.workspace_id = workspace_id

    def stopped(self) -> HttpError:
        """The answer when the workspace is stopped."""
        return HttpError(
            ErrorCode.WORKSPACE_STOPPED,
            f"workspace '{self.workspace_id}' is stopped; start it first",
        )


def error_response(
    code: ErrorCode,
    message: str,
    headers: Mapping[str, str] | None = None,
) -> JSONResponse:
    """An error answered outside a route, by a middleware.

    Args:
        code (ErrorCode): what went wrong.
        message (str): human text.
        headers (Mapping[str, str] | None): headers to answer with.
    """
    return HttpError(code, message, headers=headers).response()


def fs_error(exc: Exception) -> HttpError:
    """A file call's failure: the errno it names picks the code, a
    policy's refusal answers ``policy_refused`` with its record, and an
    unnamed failure is ``internal``, whose cause stays in the logs.

    Args:
        exc (Exception): what the call raised.
    """
    condition = classify(exc)
    if condition is None:
        return HttpError(ErrorCode.INTERNAL, INTERNAL_MESSAGE)
    if isinstance(exc, PolicyDenied):
        return HttpError(
            ErrorCode.POLICY_REFUSED,
            posix_phrase(condition),
            errno=condition.name,
            refusal=(None if exc.refusal is None else asdict(exc.refusal)),
        )
    return HttpError(
        ERRNO_CODE[condition], posix_phrase(condition), errno=condition.name
    )


def one_of(expected: str) -> str:
    """``one of a, b, c`` from pydantic's quoted list of choices, which
    the schema gives, never the value sent.

    Args:
        expected (str): such as ``'a', 'b' or 'c'``.
    """
    return "one of " + ", ".join(re.findall(r"'([^']*)'", expected))


def param_of(loc: Sequence[str | int]) -> tuple[str, bool]:
    """A dotted path such as ``mounts[0].mode`` for a ``loc`` below its
    place, and whether a union member's tag was cut from it.

    Args:
        loc (Sequence[str | int]): the field's place in the request.
    """
    path = ""
    for key in loc:
        if isinstance(key, int):
            path += f"[{key}]"
        elif UNION_TAG.match(key):
            return path, True
        else:
            path += f".{key}" if path else key
    return path, False


def validation_error(
    issues: Sequence[Mapping[str, Any]], under: Sequence[str] = ()
) -> HttpError:
    """The first of a validator's issues as one error: the path and the
    query come before the body, declared fields before unknown keys, each
    in order. The validator's own text and the value sent stay out, save
    a validator's ``ValueError``, whose text the server wrote.

    Args:
        issues (Sequence[Mapping[str, Any]]): pydantic's errors, each
            ``loc`` led by ``path``, ``query`` or ``body`` when FastAPI
            raised them.
        under (Sequence[str]): the request field the validated value
            sits at, for a value checked on its own.
    """

    def rank(issue: Mapping[str, Any]) -> tuple[int, int]:
        loc = tuple(issue["loc"])
        place = PLACES.index(loc[0]) if loc and loc[0] in PLACES else 2
        return place, int(issue["type"] == "extra_forbidden")

    issue = sorted(issues, key=rank)[0]
    loc = tuple(issue["loc"])
    kind = issue["type"]
    if kind == "json_invalid":
        return HttpError(ErrorCode.INVALID_JSON, "body must be JSON")
    below = loc[1:] if loc and loc[0] in PLACES else loc
    param, union = param_of((*under, *below))
    if not param:
        return HttpError(
            ErrorCode.INVALID_REQUEST, "body must be a JSON object"
        )
    if kind == "missing":
        return HttpError(
            ErrorCode.MISSING_FIELD, f"{param} is required", param=param
        )
    if kind == "extra_forbidden":
        return HttpError(
            ErrorCode.UNKNOWN_FIELD,
            f"{param} is not a known field",
            param=param,
        )
    ctx = issue.get("ctx") or {}
    if kind == "value_error" and isinstance(ctx.get("error"), Exception):
        return HttpError(
            ErrorCode.INVALID_VALUE, str(ctx["error"]), param=param
        )
    expected = ctx.get("expected")
    if union:
        must = None
    elif kind in ("literal_error", "enum") and isinstance(expected, str):
        must = one_of(expected)
    else:
        must = EXPECTATION.get(kind)
    message = (
        f"{param} is not valid" if must is None else f"{param} must be {must}"
    )
    return HttpError(ErrorCode.INVALID_VALUE, message, param=param)


def error_of(exc: Exception) -> HttpError:
    """Any error a route raised, as the one it answers.

    Args:
        exc (Exception): what the route raised.
    """
    if isinstance(exc, HttpError):
        return exc
    if isinstance(exc, RequestValidationError):
        return validation_error(exc.errors())
    if isinstance(exc, StarletteHTTPException):
        code, message = FRAMEWORK.get(
            exc.status_code, (ErrorCode.INTERNAL, INTERNAL_MESSAGE)
        )
        return HttpError(code, message, headers=exc.headers)
    logger.error("mirage: unhandled error", exc_info=exc)
    return HttpError(ErrorCode.INTERNAL, INTERNAL_MESSAGE)


async def answer(request: Request, exc: Exception) -> Response:
    """An error a route raised, or the framework met, as its response."""
    return error_of(exc).response()


def register_error_handlers(app: FastAPI) -> None:
    """Answer every error ``app`` raises in the one body.

    Args:
        app (FastAPI): the app.
    """
    for kind in (
        HttpError,
        RequestValidationError,
        StarletteHTTPException,
        Exception,
    ):
        app.add_exception_handler(kind, answer)


def loader_error(exc: Exception, under: Sequence[str] = ()) -> HttpError:
    """A loader's refusal of what the caller sent: a schema's failure
    worded as ``validation_error`` words one, any other the loader's own
    text.

    Args:
        exc (Exception): what the loader raised.
        under (Sequence[str]): the request field the loaded value sits at.
    """
    if isinstance(exc, ValidationError):
        return validation_error(exc.errors(include_url=False), under)
    return HttpError(ErrorCode.INVALID_REQUEST, str(exc))
