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

"""Ask a host HTTP endpoint before a line the profile asks about runs.

A profile's ``commands`` rules answer ``ask`` for a line. Mirage then hands
the line to the host's ``AskHandler`` and waits for an answer. Hermes has no
person in the loop by itself, so this module turns the handler into a
request to an endpoint the host runs: the endpoint shows the line to a
person and answers allow or deny, once or for the rest of the session.

A timeout, an unreachable endpoint and an answer we cannot read all deny, so
a missing approver can never turn into a silent yes. Proxies are not
consulted: the endpoint lives beside the agent, and a proxy that rewrites
the exchange would be one more thing between the person and the answer.

The endpoint gets the decision as JSON (``id``, ``session``, ``command``,
``argv``, ``cwd``, ``paths``, ``reason``) and answers
``{"decision": "allow" | "deny", "scope": "once" | "session", "note": ""}``;
``scope`` defaults to ``once`` and ``note`` is carried onto the record.
"""

import asyncio
import json
import logging
import urllib.error
import urllib.request
from dataclasses import replace

from mirage.agents.hermes.constants import (
    ASK_TIMEOUT,
    ASK_TOKEN,
    ASK_URL,
    DEFAULT_ASK_TIMEOUT,
)
from mirage.policy import AskHandler, Decision, Outcome, Scope

logger = logging.getLogger(__name__)

# An answer is a few fields; one that is longer is not ours.
MAX_ANSWER_BYTES = 64 * 1024


class HttpAsk:
    """A handler that asks an HTTP endpoint and waits for its answer.

    Args:
        url (str): where to POST the decision.
        token (str): bearer token the request carries, when set.
        timeout (float): seconds to wait before denying.
    """

    def __init__(
        self, url: str, token: str = "", timeout: float = DEFAULT_ASK_TIMEOUT
    ) -> None:
        self._url = url
        self._token = token
        self._timeout = timeout

    async def __call__(self, decision: Decision) -> Decision:
        """Ask the endpoint about ``decision``, denying on any failure."""
        try:
            answer = await asyncio.wait_for(
                asyncio.to_thread(self._post, _payload(decision)),
                # The request has its own timeout; this one only fires when
                # the thread cannot get that far (a hanging proxy, say).
                self._timeout + 5,
            )
        except TimeoutError:
            return _deny(decision, f"approval did not answer in {self._timeout:g}s")
        except urllib.error.HTTPError as exc:
            return _deny(decision, _http_note(exc))
        except (urllib.error.URLError, OSError) as exc:
            reason = getattr(exc, "reason", exc)
            return _deny(decision, f"approval endpoint unreachable: {reason}")
        return _settle(decision, answer)

    def _post(self, payload: dict[str, object]) -> bytes:
        """POST the payload and return the answer body."""
        headers = {"Content-Type": "application/json"}
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        request = urllib.request.Request(
            self._url,
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(request, timeout=self._timeout) as response:
            return response.read(MAX_ANSWER_BYTES)


def make_ask(
    url: str | None, token: str | None, timeout: str | float | None
) -> AskHandler | None:
    """Build the handler the plugin settings describe, or None without a URL.

    Args:
        url (str | None): the ``ask_url`` setting; unset turns asking off.
        token (str | None): the ``ask_token`` setting, sent when set.
        timeout (str | float | None): ``ask_timeout`` in seconds; unset uses
            the default.

    Raises:
        ValueError: the timeout is not a positive number.
    """
    if not url:
        return None
    if timeout in (None, ""):
        seconds = DEFAULT_ASK_TIMEOUT
    else:
        try:
            seconds = float(timeout)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{ASK_TIMEOUT} must be a number: {timeout!r}") from exc
        if seconds <= 0:
            raise ValueError(f"{ASK_TIMEOUT} must be positive: {seconds:g}")
    return HttpAsk(url, token or "", seconds)


def _payload(decision: Decision) -> dict[str, object]:
    return {
        "id": decision.id,
        "session": decision.session_id,
        "command": decision.command,
        "argv": list(decision.argv),
        "cwd": decision.cwd,
        "paths": list(decision.paths),
        "reason": decision.reason,
    }


def _settle(decision: Decision, body: bytes) -> Decision:
    """Read the endpoint's answer into the record, denying when unreadable."""
    try:
        answer = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return _deny(decision, f"approval answer unreadable: {_clip(body)}")
    if not isinstance(answer, dict):
        return _deny(decision, f"approval answer unreadable: {_clip(body)}")
    word = answer.get("decision")
    if word not in ("allow", "deny"):
        return _deny(decision, f"approval answer has no decision: {_clip(body)}")
    scope = answer.get("scope", Scope.ONCE.value)
    if scope not in (Scope.ONCE.value, Scope.SESSION.value):
        return _deny(decision, f"approval answer has an unknown scope: {scope!r}")
    note = answer.get("note")
    return replace(
        decision,
        outcome=Outcome.ALLOW if word == "allow" else Outcome.DENY,
        scope=Scope(scope),
        note=note if isinstance(note, str) else "",
    )


def _deny(decision: Decision, note: str) -> Decision:
    return replace(decision, outcome=Outcome.DENY, scope=Scope.ONCE, note=note)


def _http_note(exc: urllib.error.HTTPError) -> str:
    try:
        body = exc.read(1024)
    except OSError:
        body = b""
    return f"approval endpoint answered {exc.code}: {_clip(body)}"


def _clip(body: bytes) -> str:
    return body[:200].decode("utf-8", "replace").strip()


__all__ = ["HttpAsk", "make_ask", "ASK_URL", "ASK_TOKEN"]
