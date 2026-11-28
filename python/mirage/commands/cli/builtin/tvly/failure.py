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

# Failure rendering adapted from tvly 1.0.2's src/commands/invoke.ts and
# src/ui/keyless.ts (MIT; see licenses/third_party/tavily-cli.txt).

from collections.abc import Awaitable, Callable

from mirage.accessor.tavily import TavilyAccessor
from mirage.commands.cli.builtin.tvly.output import Streams
from mirage.commands.cli.builtin.tvly.render import (
    js_text,
    js_trim,
    json_text,
    sanitize_control,
    truthy,
)
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.core.tavily.client import (
    TavilyAPIError,
    TavilyKeylessLimit,
    TavilyUnanswered,
)
from mirage.io.types import ByteSource, IOResult
from mirage.types import JsonValue, PathSpec

LIMIT_STATUSES = frozenset({429, 432})
AUTH_STATUSES = frozenset({401, 403})
USAGE_EXIT = 2
AUTH_EXIT = 3
API_EXIT = 4
# tvly points a keyless user at `tvly login`; a Mirage install takes its key
# from the config outside the shell, so the hint says where it comes from.
NO_KEY = "  No api_key is set in this tvly install's config."
CAP_LIFT = "  Setting api_key in the tvly install's config removes this cap."


def usage(message: str) -> tuple[None, IOResult]:
    """A line tvly refuses before calling the API.

    Args:
        message (str): the complete refusal, without its newline.
    """
    return None, IOResult(
        stderr=(message + "\n").encode(), exit_code=USAGE_EXIT
    )


def require_key(command: str) -> tuple[None, IOResult]:
    """The refusal of a verb that needs a key, on a keyless install.

    Args:
        command (str): the verb, as tvly names it.
    """
    streams = Streams()
    streams.err()
    streams.err(f"  > The {command} command requires a Tavily API key.")
    streams.err()
    streams.err(NO_KEY)
    streams.err()
    streams.err(
        "  Tip: tvly search and tvly extract work without an API key "
        "(subject to a rate-limit cap)."
    )
    streams.err()
    _, result = streams.result(AUTH_EXIT)
    return None, result


def format_seconds(seconds: int) -> str:
    """A retry delay the way a person reads it: ``90s`` as ``1m 30s``.

    Args:
        seconds (int): the delay.
    """
    if seconds < 60:
        return f"{seconds}s"
    if seconds < 3600:
        minutes, rest = divmod(seconds, 60)
        return f"{minutes}m {rest}s" if rest else f"{minutes}m"
    if seconds < 86400:
        hours, rest = divmod(seconds, 3600)
        minutes = rest // 60
        return f"{hours}h {minutes}m" if minutes else f"{hours}h"
    days, rest = divmod(seconds, 86400)
    hours = rest // 3600
    return f"{days}d {hours}h" if hours else f"{days}d"


def keyless_cap_error(limit: TavilyKeylessLimit) -> dict[str, JsonValue]:
    """The ``--json`` error object for a keyless cap.

    Args:
        limit (TavilyKeylessLimit): the cap the API answered with.
    """
    retry = limit.error.get("retry_after_seconds")
    window = limit.error.get("window")
    return {
        "code": limit.error.get("code"),
        "message": str(limit),
        "window": window if isinstance(window, str) else None,
        "retry_after_seconds": (
            retry
            if isinstance(retry, (int, float)) and not isinstance(retry, bool)
            else None
        ),
        "next_actions": limit.error.get("next_actions"),
    }


def _last(
    actions: list[dict[str, JsonValue]], kind: str
) -> dict[str, JsonValue] | None:
    for action in reversed(actions):
        if action.get("type") == kind:
            return action
    return None


def _or(value: JsonValue, fallback: str) -> str:
    return js_text(value) if truthy(value) else fallback


def _whole(value: JsonValue) -> int | None:
    """``value`` when ``Number.isInteger`` holds for it, as an int.

    Args:
        value (JsonValue): a decoded JSON value.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, float) and not value.is_integer():
        return None
    return int(value)


def keyless_cap_text(limit: TavilyKeylessLimit) -> str:
    """The cap's envelope as a plain-text block; its first line is the
    title.

    Args:
        limit (TavilyKeylessLimit): the cap the API answered with.
    """
    lines = ["Tavily rate limit reached."]
    message = js_trim(str(limit))
    if message:
        lines.append(message)
    retry = _whole(limit.error.get("retry_after_seconds"))
    if retry is not None and retry > 0:
        lines += ["", f"Retry after: {format_seconds(retry)} ({retry}s)"]
    raw = limit.error.get("next_actions")
    actions = (
        [a for a in raw if isinstance(a, dict)]
        if isinstance(raw, list)
        else []
    )
    signup = _last(actions, "signup")
    payment = _last(actions, "agentic_payment")
    bonus = _last(actions, "bonus_credits")
    if signup or payment or bonus:
        lines += ["", "Continuation options:"]
        if signup:
            resource = _or(signup.get("resource"), "https://tavily.com")
            lines.append(f"  - Sign up for a Tavily API key:  {resource}")
            if truthy(signup.get("instruction")):
                lines.append(f"      {js_text(signup['instruction'])}")
        if payment:
            label = f"  - Pay via {_or(payment.get('scheme'), 'x402')} agentic payment"
            paid = payment.get("resource")
            lines.append(
                f"{label}:  {js_text(paid)}" if truthy(paid) else label
            )
            if truthy(payment.get("instruction")):
                lines.append(f"      {js_text(payment['instruction'])}")
        if bonus:
            params = bonus.get("params")
            params = params if isinstance(params, dict) else {}
            questions = params.get("questions")
            questions = questions if isinstance(questions, list) else []
            if questions:
                credits = _whole(params.get("credits_on_completion"))
                noun = f"{len(questions)} question{'s' if len(questions) != 1 else ''}"
                if credits is not None:
                    lines.append(
                        f"  - Earn {credits} bonus credits by answering {noun}:"
                    )
                else:
                    lines.append(
                        f"  - Earn bonus credits by answering {noun}:"
                    )
                for index, question in enumerate(questions):
                    if isinstance(question, str):
                        lines.append(f"      {index + 1}. {question}")
                resource = _or(bonus.get("resource"), "/v1/keyless/bonus")
                lines.append(f"    POST your answers to: {resource}")
    return "\n".join(lines)


def keyless_cap_hit(streams: Streams, limit: TavilyKeylessLimit) -> None:
    """Write the cap, its retry delay and how a key lifts it to stderr.

    Args:
        streams (Streams): where the verb's output gathers.
        limit (TavilyKeylessLimit): the cap the API answered with.
    """
    streams.err()
    for index, line in enumerate(
        sanitize_control(keyless_cap_text(limit)).split("\n")
    ):
        if index == 0:
            streams.err(f"  > {line}")
        else:
            streams.err(f"    {line}" if line else "")
    streams.err()
    streams.err(CAP_LIFT)
    streams.err()


def api_failure(
    streams: Streams, error: Exception, json: bool
) -> tuple[bytes, IOResult]:
    """An API failure in tvly's voice: 3 for a limit or a refused key,
    4 for anything else.

    Args:
        streams (Streams): what the verb wrote before it failed.
        error (Exception): the failure.
        json (bool): whether the line asked for JSON.
    """
    if isinstance(error, TavilyKeylessLimit):
        if json:
            streams.out(json_text({"error": keyless_cap_error(error)}, False))
        else:
            keyless_cap_hit(streams, error)
        return streams.result(AUTH_EXIT)
    status = error.status if isinstance(error, TavilyAPIError) else None
    limit = status in LIMIT_STATUSES
    code = AUTH_EXIT if limit or status in AUTH_STATUSES else API_EXIT
    if json:
        streams.out(json_text({"error": str(error)}, False))
        return streams.result(code)
    text = sanitize_control(str(error))
    if limit:
        streams.err()
        streams.err(f"  > {text}")
        streams.err()
        streams.err("  Upgrade your plan at tavily.com")
        streams.err()
        return streams.result(AUTH_EXIT)
    streams.err(f"  > Error: {text}")
    return streams.result(code)


async def guarded(
    fn: Callable[
        [TavilyAccessor, list[PathSpec], list[str], Context],
        Awaitable[tuple[ByteSource | None, IOResult]],
    ],
    accessor: TavilyAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    """Run one tvly verb, answering an API failure in tvly's voice.

    Args:
        fn (Callable): the verb.
        accessor (TavilyAccessor): the install's accessor.
        paths (list[PathSpec]): the verb's path operands.
        texts (list[str]): the verb's text operands.
        ctx (Context): the verb's context.
    """
    try:
        return await fn(accessor, paths, texts, ctx)
    except (TavilyAPIError, TavilyUnanswered) as failed:
        json = FlagView(ctx.flags, ctx.spec).as_bool("json")
        return api_failure(Streams(), failed, json)
