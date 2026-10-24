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

from mirage.accessor.hf_hub import HfAccountAccessor
from mirage.commands.errors import UsageError
from mirage.commands.spec.flag_view import FlagView
from mirage.core.hf_hub.constants import API_SEGMENTS
from mirage.io.types import ByteSource, IOResult

DEFAULT_REPO_TYPE = "model"


def repo_type_of(fl: FlagView) -> str:
    """The repo kind a line names, defaulting the way upstream does.

    Args:
        fl (FlagView): the invocation's flags.

    Returns:
        str: "model", "dataset" or "space".

    Raises:
        UsageError: the line named something that is not a repo kind.
    """
    value = fl.as_str("repo_type") or DEFAULT_REPO_TYPE
    if value not in API_SEGMENTS:
        raise UsageError(f"invalid repo type: {value}")
    return value


def require_operands(texts: list[str], names: list[str]) -> None:
    """Refuse a line that left a required operand empty.

    Installed CLI invocations validate required arguments before calling
    the handler. This guard also protects callers that invoke a handler
    directly from reaching the Hub with missing operands.

    Args:
        texts (list[str]): the line's text operands.
        names (list[str]): the operand names, in declaration order.

    Raises:
        UsageError: the line supplied fewer operands than that.
    """
    missing = names[len(texts) :]
    if missing:
        raise UsageError(
            "the following arguments are required: " + ", ".join(missing)
        )


def text_out(
    text: str, stderr: str = ""
) -> tuple[ByteSource | None, IOResult]:
    return text.encode(), IOResult(stderr=stderr.encode() or None)


def require_token(account: HfAccountAccessor, what: str) -> None:
    """Refuse a verb that cannot work anonymously, before it is tried.

    The Hub answers 401 "Invalid username or password." for an
    unauthenticated write, which reads as a wrong credential rather than
    as a missing one.

    Args:
        account (HfAccountAccessor): the install's account.
        what (str): what was being attempted, for the message.

    Raises:
        UsageError: the install carries no token.
    """
    if account.token is None:
        raise UsageError(
            f"{what} requires a token; set `token` on the `hf` install"
        )
