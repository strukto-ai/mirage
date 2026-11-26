import json
from dataclasses import dataclass

from mirage.types import JsonValue


@dataclass(frozen=True, slots=True)
class StartCommand:
    line: str
    cwd: str | None
    envs: dict[str, str]
    stdin: bool


class InvalidConnectRequest(ValueError):
    pass


class UnsupportedProcessOption(ValueError):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


def decode_start(body: bytes) -> StartCommand:
    if (
        len(body) < 5
        or body[0] != 0
        or int.from_bytes(body[1:5], "big") != len(body) - 5
    ):
        raise InvalidConnectRequest(
            "expected one uncompressed Connect message"
        )

    try:
        request = json.loads(body[5:].decode("utf-8"))
    except (ValueError, RecursionError) as exc:
        raise InvalidConnectRequest("invalid Connect JSON message") from exc
    if not isinstance(request, dict):
        raise InvalidConnectRequest("expected a process start request")
    stdin = request.get("stdin")
    if request.get("pty") is not None:
        raise UnsupportedProcessOption("PTY commands are unsupported")
    if request.get("tag") is not None:
        raise UnsupportedProcessOption("command tags are unsupported")
    if stdin is not None and not isinstance(stdin, bool):
        raise InvalidConnectRequest("stdin must be a boolean")

    process = request.get("process")
    if not isinstance(process, dict):
        raise InvalidConnectRequest("expected a process configuration")
    executable, args = process.get("cmd"), process.get("args")
    if (
        not isinstance(executable, str)
        or not executable
        or not isinstance(args, list)
        or not all(isinstance(arg, str) for arg in args)
    ):
        raise InvalidConnectRequest("expected a shell and its arguments")
    if executable != "/bin/bash" or len(args) != 3 or args[:2] != ["-l", "-c"]:
        raise UnsupportedProcessOption(
            "only the default SDK Bash shell is supported"
        )

    cwd = process.get("cwd")
    envs = process.get("envs")
    if cwd is not None and not isinstance(cwd, str):
        raise InvalidConnectRequest("cwd must be a string")
    if envs is None:
        envs = {}
    if not isinstance(envs, dict) or not all(
        isinstance(value, str) for value in envs.values()
    ):
        raise InvalidConnectRequest("environment values must be strings")
    return StartCommand(args[2], cwd, envs, stdin is True)


def _encode(flags: int, value: dict[str, JsonValue]) -> bytes:
    payload = json.dumps(
        value, separators=(",", ":"), ensure_ascii=True
    ).encode()
    return bytes([flags]) + len(payload).to_bytes(4, "big") + payload


def encode_message(event: dict[str, JsonValue]) -> bytes:
    return _encode(0, {"event": event})


def end_stream(code: str | None = None, message: str = "") -> bytes:
    if code is None:
        return _encode(2, {})
    return _encode(2, {"error": {"code": code, "message": message}})
