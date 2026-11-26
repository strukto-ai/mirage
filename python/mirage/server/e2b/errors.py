from typing import Literal

from mirage.errors import classify
from mirage.errors.types import FsCondition
from mirage.server.errors import ErrorCode, HttpError


class SandboxNotRunning(HttpError):
    def __init__(self) -> None:
        super().__init__(
            ErrorCode.UNAUTHORIZED, "invalid sandbox access token"
        )


class InvalidConnectRequest(ValueError):
    pass


class UnsupportedProcessOption(ValueError):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


FileCode = Literal[
    "already_exists",
    "failed_precondition",
    "internal",
    "invalid_argument",
    "not_found",
    "permission_denied",
    "resource_exhausted",
    "unimplemented",
]


class FileError(ValueError):
    def __init__(self, code: FileCode, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


ERRORS: dict[FsCondition, tuple[FileCode, str]] = {
    FsCondition.ENOENT: ("not_found", "file not found"),
    FsCondition.EEXIST: ("already_exists", "file or directory already exists"),
    FsCondition.EACCES: ("permission_denied", "permission denied"),
    FsCondition.EPERM: ("permission_denied", "permission denied"),
    FsCondition.EROFS: ("permission_denied", "read-only filesystem"),
    FsCondition.ENOTDIR: ("failed_precondition", "not a directory"),
    FsCondition.EISDIR: ("failed_precondition", "is a directory"),
    FsCondition.ENOTEMPTY: ("failed_precondition", "directory is not empty"),
    FsCondition.EBUSY: ("failed_precondition", "path is busy"),
    FsCondition.EXDEV: ("failed_precondition", "cannot move across mounts"),
    FsCondition.ELOOP: ("invalid_argument", "symbolic link loop"),
    FsCondition.EINVAL: ("invalid_argument", "invalid path"),
    FsCondition.EDQUOT: ("resource_exhausted", "disk quota exceeded"),
    FsCondition.EFBIG: ("resource_exhausted", "file is too large"),
    FsCondition.ENOTSUP: (
        "unimplemented",
        "filesystem operation is unsupported",
    ),
}


def file_error(exc: Exception) -> FileError:
    if isinstance(exc, FileError):
        return exc
    condition = classify(exc)
    if condition is not None and condition in ERRORS:
        return FileError(*ERRORS[condition])
    return FileError("internal", "filesystem operation failed")


CONNECT_STATUS: dict[FileCode, int] = {
    "invalid_argument": 400,
    "failed_precondition": 400,
    "permission_denied": 403,
    "not_found": 404,
    "already_exists": 409,
    "resource_exhausted": 429,
    "internal": 500,
    "unimplemented": 501,
}
HTTP_CONNECT_CODE = {
    400: "invalid_argument",
    401: "unauthenticated",
    403: "permission_denied",
    404: "not_found",
    413: "resource_exhausted",
    429: "resource_exhausted",
    503: "unavailable",
}
