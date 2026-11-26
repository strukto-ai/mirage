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

import json
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from mirage.agents.hermes.ask import HttpAsk, make_ask
from mirage.policy import Decision, Outcome, Scope
from mirage.policy.types import CommandRule

pytestmark = pytest.mark.asyncio


def decision(**changes) -> Decision:
    fields = dict(
        id="ask-1",
        session_id="hermes-task-1",
        command="rm",
        argv=("-f", "notes.txt"),
        cwd="/workspace",
        paths=("/workspace/notes.txt",),
        reason="deletes need sign-off",
        rule=CommandRule(reason="deletes need sign-off"),
    )
    fields.update(changes)
    return Decision(**fields)


class Endpoint:
    """A local endpoint the test drives: status, body, delay, records."""

    def __init__(self) -> None:
        self.status = 200
        self.body = b'{"decision": "allow"}'
        self.delay = 0.0
        self.records: list[dict] = []
        self.headers: list[dict] = []
        endpoint = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802
                length = int(self.headers.get("Content-Length", "0"))
                endpoint.records.append(
                    json.loads(self.rfile.read(length) or b"{}")
                )
                endpoint.headers.append(dict(self.headers))
                if endpoint.delay:
                    time.sleep(endpoint.delay)
                self.send_response(endpoint.status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(endpoint.body)))
                self.end_headers()
                self.wfile.write(endpoint.body)

            def log_message(self, *_args) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}/ask"
        threading.Thread(
            target=self.server.serve_forever, daemon=True
        ).start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def endpoint():
    served = Endpoint()
    yield served
    served.close()


def closed_port_url() -> str:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    return f"http://127.0.0.1:{port}/ask"


async def test_allow_once_answers_the_one_line(endpoint):
    settled = await HttpAsk(endpoint.url)(decision())
    assert settled.outcome is Outcome.ALLOW
    assert settled.scope is Scope.ONCE


async def test_a_session_answer_reaches_the_session(endpoint):
    endpoint.body = b'{"decision": "allow", "scope": "session"}'
    settled = await HttpAsk(endpoint.url)(decision())
    assert settled.outcome is Outcome.ALLOW
    assert settled.scope is Scope.SESSION


async def test_deny_keeps_the_endpoints_note(endpoint):
    endpoint.body = b'{"decision": "deny", "note": "not this one"}'
    settled = await HttpAsk(endpoint.url)(decision())
    assert settled.outcome is Outcome.DENY
    assert settled.note == "not this one"


async def test_an_unknown_decision_denies(endpoint):
    endpoint.body = b'{"decision": "maybe"}'
    settled = await HttpAsk(endpoint.url)(decision())
    assert settled.outcome is Outcome.DENY
    assert "no decision" in settled.note


async def test_an_unreadable_answer_denies(endpoint):
    endpoint.body = b"not json"
    settled = await HttpAsk(endpoint.url)(decision())
    assert settled.outcome is Outcome.DENY
    assert "unreadable" in settled.note


async def test_an_unknown_scope_denies(endpoint):
    endpoint.body = b'{"decision": "allow", "scope": "forever"}'
    settled = await HttpAsk(endpoint.url)(decision())
    assert settled.outcome is Outcome.DENY
    assert "unknown scope" in settled.note


async def test_a_refused_request_denies_with_its_status(endpoint):
    endpoint.status = 500
    endpoint.body = b"boom"
    settled = await HttpAsk(endpoint.url)(decision())
    assert settled.outcome is Outcome.DENY
    assert "500" in settled.note and "boom" in settled.note


async def test_an_unreachable_endpoint_denies():
    settled = await HttpAsk(closed_port_url())(decision())
    assert settled.outcome is Outcome.DENY
    assert "unreachable" in settled.note


async def test_a_timeout_denies(endpoint):
    endpoint.delay = 0.5
    settled = await HttpAsk(endpoint.url, timeout=0.05)(decision())
    assert settled.outcome is Outcome.DENY
    assert "did not answer" in settled.note


async def test_the_token_goes_in_a_bearer_header(endpoint):
    await HttpAsk(endpoint.url, token="s3cret")(decision())
    await HttpAsk(endpoint.url)(decision())
    assert endpoint.headers[0]["Authorization"] == "Bearer s3cret"
    assert "Authorization" not in endpoint.headers[1]


async def test_the_payload_carries_the_line(endpoint):
    await HttpAsk(endpoint.url)(decision())
    [record] = endpoint.records
    assert record == {
        "id": "ask-1",
        "session": "hermes-task-1",
        "command": "rm",
        "argv": ["-f", "notes.txt"],
        "cwd": "/workspace",
        "paths": ["/workspace/notes.txt"],
        "reason": "deletes need sign-off",
    }


def test_no_url_means_nobody_asks():
    assert make_ask(None, "s3cret", "5") is None
    assert make_ask("", None, None) is None


def test_the_default_timeout_applies_when_unset():
    handler = make_ask("http://127.0.0.1:9/ask", None, None)
    assert isinstance(handler, HttpAsk)
    assert handler._timeout == 120.0


@pytest.mark.parametrize("bad", ["soon", "0", "-1"])
def test_a_bad_timeout_fails_loud(bad):
    with pytest.raises(ValueError):
        make_ask("http://127.0.0.1:9/ask", None, bad)
