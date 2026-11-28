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

import asyncio
import json
from collections.abc import AsyncIterator, Awaitable, Callable

import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer
from aioresponses import aioresponses
from yarl import URL

from mirage import Workspace
from mirage.commands.cli.builtin.tvly import TVLY
from mirage.commands.cli.builtin.tvly.research import route, stream_events
from mirage.io.types import materialize
from mirage.policy import NetworkContext, Policy

RESEARCH = "https://api.tavily.com/research"
DONE = {
    "status": "completed",
    "content": "The report.",
    "sources": [{"title": "Src", "url": "https://s"}],
}


async def run(line: str, config: dict | None = None) -> tuple[int, str, str]:
    """One line through a workspace with tvly installed."""
    ws = Workspace({})
    ws.register_cli(
        "tvly", TVLY, {"api_key": "tvly-k"} if config is None else config
    )
    io = await ws.shell(line)
    out = (await materialize(io.stdout)).decode()
    err = (await materialize(io.stderr)).decode()
    await ws.close()
    return io.exit_code, out, err


@pytest.mark.parametrize(
    ("words", "verb", "rest"),
    [
        (["topic"], "run", ["topic"]),
        (["status"], "run", ["status"]),
        (["status", "id"], "status", ["id"]),
        (["poll", "id"], "poll", ["id"]),
        (["run", "run"], "run", ["run"]),
    ],
)
def test_a_line_routes_to_the_verb_tvly_rewrites_it_to(words, verb, rest):
    assert route(words) == (verb, rest)


def test_an_event_stream_keeps_each_json_payload():
    text = 'data: {"a": 1}\r\n\ndata:[DONE]\ndata: \nevent: x\ndata:{"b":2}'
    assert stream_events(text) == [{"a": 1}, {"b": 2}]


@pytest.mark.asyncio
async def test_a_finished_answer_prints_its_report_and_sources():
    with aioresponses() as m:
        m.post(RESEARCH, payload=DONE)
        code, out, _ = await run("tvly research 'a topic'")
        body = m.requests[("POST", URL(RESEARCH))][0].kwargs["json"]
    assert code == 0
    assert out == "The report.\n\nSources:\n1. Src https://s\n"
    assert body == {
        "stream": False,
        "citation_format": "numbered",
        "input": "a topic",
    }


@pytest.mark.asyncio
async def test_no_wait_hands_back_the_request_id():
    with aioresponses() as m:
        m.post(RESEARCH, payload={"request_id": "r1"})
        code, out, _ = await run("tvly research topic --no-wait")
    assert code == 0
    assert json.loads(out) == {"request_id": "r1", "status": "pending"}


@pytest.mark.asyncio
async def test_a_pending_task_is_polled_until_it_finishes():
    with aioresponses() as m:
        m.post(RESEARCH, payload={"request_id": "r1", "status": "pending"})
        m.get(f"{RESEARCH}/r1", payload=DONE)
        code, out, _ = await run("tvly research topic --poll-interval 1")
    assert code == 0
    assert out.startswith("The report.\n")


@pytest.mark.asyncio
async def test_status_prints_the_request_and_its_state():
    with aioresponses() as m:
        m.get(f"{RESEARCH}/r1", payload={"status": "failed", "error": "bad"})
        code, out, _ = await run("tvly research status r1")
    assert code == 0
    assert out == "  Request:  r1\n  Status:   failed\n  Error: bad\n"


@pytest.mark.asyncio
async def test_a_stream_shows_its_steps_then_the_report():
    events = [
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": {
                            "type": "tool_call",
                            "tool_call": [{"name": "Plan"}],
                        }
                    }
                }
            ]
        },
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": {
                            "type": "tool_response",
                            "tool_response": [
                                {"name": "WebSearch", "sources": [1, 2]}
                            ],
                        }
                    }
                }
            ]
        },
        {"choices": [{"delta": {"content": "Re"}}]},
        {
            "choices": [
                {
                    "delta": {
                        "content": "port",
                        "sources": [{"title": "T", "url": "u"}],
                    }
                }
            ]
        },
    ]
    stream = (
        "".join(f"data: {json.dumps(e)}\n\n" for e in events)
        + "data: [DONE]\n"
    )
    with aioresponses() as m:
        m.post(RESEARCH, body=stream)
        code, out, err = await run("tvly research topic --stream")
    assert code == 0
    assert err == "  Plan\n  Found 2 sources\n"
    assert out == "Report\n\nSources:\n1. T u\n"


PLAN = {
    "choices": [
        {
            "delta": {
                "tool_calls": {
                    "type": "tool_call",
                    "tool_call": [{"name": "Plan"}],
                }
            }
        }
    ]
}


async def serve_stream(
    send: Callable[[web.Request, web.StreamResponse], Awaitable[None]],
) -> AsyncIterator[TestServer]:
    """A local research endpoint whose stream ``send`` writes."""

    async def research(request: web.Request) -> web.StreamResponse:
        response = web.StreamResponse(
            headers={"Content-Type": "text/event-stream"}
        )
        await response.prepare(request)
        await send(request, response)
        return response

    app = web.Application()
    app.router.add_post("/research", research)
    async with TestServer(app) as server:
        yield server


@pytest.mark.asyncio
async def test_a_json_stream_hands_on_each_event_as_it_arrives():
    held = asyncio.Event()

    async def send(_: web.Request, response: web.StreamResponse) -> None:
        await response.write(b'data: {"n": 1}\n\n')
        await held.wait()
        await response.write(b'data: {"n": 2}\n\ndata: [DONE]\n\n')
        await response.write_eof()

    async for server in serve_stream(send):
        ws = Workspace({})
        ws.register_cli(
            "tvly",
            TVLY,
            {"api_key": "tvly-k", "base_url": str(server.make_url(""))},
        )
        execution = await ws.shell(
            "tvly research topic --stream --json", stream=True
        )
        async with execution:
            events = aiter(execution.events)
            first = await asyncio.wait_for(anext(events), 5)
            held.set()
            rest = [event.data async for event in events]
            result = await execution.wait()
        await ws.close()
    assert first.data == b'{"n":1}\n'
    assert b"".join(rest) == b'{"n":2}\n'
    assert result.exit_code == 0


class _Watch(Policy):
    """Keeps what each connection it judges was opened for."""

    def __init__(self) -> None:
        self.asked: list[NetworkContext] = []

    async def pre_network(self, ctx: NetworkContext) -> None:
        self.asked.append(ctx)


@pytest.mark.asyncio
async def test_a_stream_opens_its_request_as_the_line_that_ran_it():
    # The stream opens its request once the shell reads it, after the
    # handler returned, and a network policy still sees tvly ask.
    async def send(_: web.Request, response: web.StreamResponse) -> None:
        await response.write(b'data: {"n": 1}\n\ndata: [DONE]\n\n')
        await response.write_eof()

    watch = _Watch()
    async for server in serve_stream(send):
        ws = Workspace({})
        ws.policies.add(watch)
        ws.register_cli(
            "tvly",
            TVLY,
            {"api_key": "tvly-k", "base_url": str(server.make_url(""))},
        )
        result = await ws.shell("tvly research topic --stream --json")
        await ws.close()
    assert (result.exit_code, result.stdout) == (0, b'{"n":1}\n')
    assert [(ctx.command, ctx.program) for ctx in watch.asked] == [
        ("tvly", ("tvly", "research"))
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("flags", "stdout", "steps"),
    [
        ("--json", '{"n":1}\n', ""),
        ("", "", "  Plan\n"),
    ],
)
async def test_a_stream_cut_short_keeps_what_came_before(flags, stdout, steps):
    event = {"n": 1} if flags else PLAN

    async def send(request: web.Request, response: web.StreamResponse) -> None:
        await response.write(f"data: {json.dumps(event)}\n\n".encode())
        assert request.transport is not None
        request.transport.abort()

    async for server in serve_stream(send):
        code, out, err = await run(
            f"tvly research topic --stream {flags}".strip(),
            config={"api_key": "tvly-k", "base_url": str(server.make_url(""))},
        )
    if flags:
        assert out.startswith(stdout)
        assert '{"error":"An unexpected error occurred' in out
    else:
        assert out == stdout
        assert err.startswith(
            steps
            + "  > Error: An unexpected error occurred while making the request."
        )
    assert code == 4


@pytest.mark.asyncio
async def test_a_verb_refuses_the_options_only_run_takes():
    assert await run("tvly research status r1 --model pro") == (
        2,
        "",
        "error: unknown option '--model'\n",
    )


@pytest.mark.asyncio
async def test_research_needs_a_key():
    code, _, err = await run("tvly research topic", config={})
    assert code == 3
    assert "  > The research command requires a Tavily API key.\n" in err


@pytest.mark.asyncio
async def test_a_bare_research_prints_the_page_help_prints():
    bare = await run("tvly research")
    assert bare == await run("tvly research --help")
    assert bare[0] == 0
    assert bare[1].startswith("usage: tvly research ")
