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

import pytest

from mirage.commands.cli.builtin.tvly import TVLY
from mirage.commands.cli.builtin.tvly.failure import (
    api_failure,
    format_seconds,
    guarded,
    keyless_cap_hit,
    keyless_cap_text,
)
from mirage.commands.cli.builtin.tvly.output import Streams
from mirage.core.tavily.client import (
    TavilyAPIError,
    TavilyKeylessLimit,
    TavilyUnanswered,
)


@pytest.mark.parametrize(
    ("seconds", "text"),
    [
        (45, "45s"),
        (90, "1m 30s"),
        (120, "2m"),
        (3660, "1h 1m"),
        (90000, "1d 1h"),
    ],
)
def test_a_retry_delay_reads_the_way_a_person_reads_it(seconds, text):
    assert format_seconds(seconds) == text


def test_the_cap_names_its_retry_and_how_to_continue():
    cap = TavilyKeylessLimit(
        "Daily cap reached",
        429,
        {
            "code": "keyless_daily",
            "retry_after_seconds": 90.0,
            "next_actions": [
                {"type": "signup", "instruction": "Create a key"},
                "not an object",
                {
                    "type": "bonus_credits",
                    "params": {
                        "questions": ["Why?"],
                        "credits_on_completion": 5,
                    },
                },
            ],
        },
    )
    assert keyless_cap_text(cap) == (
        "Tavily rate limit reached.\nDaily cap reached\n\n"
        "Retry after: 1m 30s (90s)\n\nContinuation options:\n"
        "  - Sign up for a Tavily API key:  https://tavily.com\n"
        "      Create a key\n"
        "  - Earn 5 bonus credits by answering 1 question:\n"
        "      1. Why?\n"
        "    POST your answers to: /v1/keyless/bonus"
    )


def test_the_cap_says_a_configured_key_lifts_it():
    streams = Streams()
    keyless_cap_hit(streams, TavilyKeylessLimit("Daily cap reached", 429, {}))
    _, result = streams.result(3)
    assert result.stderr == (
        b"\n  > Tavily rate limit reached.\n    Daily cap reached\n\n"
        b"  Setting api_key in the tvly install's config removes this cap.\n\n"
    )


@pytest.mark.parametrize(
    ("error", "code", "stderr"),
    [
        (
            TavilyAPIError("Usage limit", 432),
            3,
            "\n  > Usage limit\n\n  Upgrade your plan at tavily.com\n\n",
        ),
        (TavilyAPIError("Unauthorized", 401), 3, "  > Error: Unauthorized\n"),
        (TavilyAPIError("Server", 500), 4, "  > Error: Server\n"),
        (
            TavilyUnanswered("Request timed out after 30 seconds."),
            4,
            ("  > Error: Request timed out after 30 seconds.\n"),
        ),
    ],
)
def test_a_failure_exits_by_its_class(error, code, stderr):
    out, result = api_failure(Streams(), error, False)
    assert (out, result.exit_code) == (b"", code)
    assert result.stderr == stderr.encode()


def test_with_json_the_failure_is_an_object_on_stdout():
    out, result = api_failure(Streams(), TavilyAPIError("bad", 400), True)
    assert out == b'{"error":"bad"}\n'
    assert result.exit_code == 4


def test_every_leaf_is_guarded():
    for leaf in TVLY.handlers.values():
        assert getattr(leaf.fn, "func", None) is guarded
