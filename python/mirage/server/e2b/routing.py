import hmac

from fastapi import Request

from mirage.server.e2b.leases import Sandbox, Sandboxes
from mirage.server.errors import ErrorCode, HttpError


class SandboxNotRunning(HttpError):
    def __init__(self) -> None:
        super().__init__(
            ErrorCode.UNAUTHORIZED, "invalid sandbox access token"
        )


def require_sandbox(request: Request) -> Sandbox:
    """Resolve the active workspace named by authenticated envd headers.

    Args:
        request (Request): the request to an enabled sandbox data route.
    """
    ids = request.headers.getlist("e2b-sandbox-id")
    ports = request.headers.getlist("e2b-sandbox-port")
    if len(ids) != 1 or not ids[0] or ports != ["49983"]:
        raise HttpError(ErrorCode.INVALID_REQUEST, "invalid sandbox routing")
    tokens = request.headers.getlist("x-access-token")
    if len(tokens) != 1 or not tokens[0]:
        raise HttpError(ErrorCode.UNAUTHORIZED, "invalid sandbox access token")
    sandboxes: Sandboxes = request.app.state.e2b
    lease = sandboxes.live(ids[0])
    if lease is None:
        raise SandboxNotRunning()
    if not hmac.compare_digest(
        tokens[0].encode("latin-1"), lease.access_token.encode("ascii")
    ):
        raise HttpError(ErrorCode.UNAUTHORIZED, "invalid sandbox access token")
    return lease
