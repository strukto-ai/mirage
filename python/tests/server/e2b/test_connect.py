import json

import pytest

from mirage.server.e2b.connect import (
    StartCommand,
    decode_start,
    encode_message,
    end_stream,
)
from mirage.server.e2b.errors import (
    InvalidConnectRequest,
    UnsupportedProcessOption,
)


def envelope(flags: int, payload: bytes) -> bytes:
    return bytes([flags]) + len(payload).to_bytes(4, "big") + payload


def test_start_decodes_a_framed_sdk_command() -> None:
    payload = json.dumps(
        {
            "process": {
                "cmd": "/bin/bash",
                "args": ["-l", "-c", "pwd"],
                "cwd": "/home/user",
                "envs": {"TEST": "value"},
            },
            "stdin": False,
        }
    ).encode()
    assert decode_start(envelope(0, payload)) == StartCommand(
        "pwd", "/home/user", {"TEST": "value"}, False
    )


@pytest.mark.parametrize(
    "body", [b"{}", envelope(1, b"{}"), envelope(0, b"{}")[:-1]]
)
def test_start_rejects_a_malformed_frame(body: bytes) -> None:
    with pytest.raises(
        InvalidConnectRequest, match="uncompressed Connect message"
    ):
        decode_start(body)


def test_start_rejects_a_custom_shell_as_unsupported() -> None:
    body = b'{"process":{"cmd":"/bin/sh","args":["-c","pwd"]}}'
    with pytest.raises(
        UnsupportedProcessOption, match="default SDK Bash shell"
    ):
        decode_start(envelope(0, body))


def test_process_end_and_connect_end_are_separate_frames() -> None:
    assert encode_message(
        {"end": {"exited": True, "exitCode": 3}}
    ) == envelope(0, b'{"event":{"end":{"exited":true,"exitCode":3}}}')
    assert end_stream() == envelope(2, b"{}")
    assert end_stream(
        "deadline_exceeded", "command deadline exceeded"
    ) == envelope(
        2,
        b'{"error":{"code":"deadline_exceeded","message":"command deadline exceeded"}}',
    )
