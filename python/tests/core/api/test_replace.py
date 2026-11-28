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
import re

import pytest

from mirage.core.api.errors import ApiError
from mirage.core.api.replace import aside_name, land_then_retire, set_aside


class Steps:
    """Each step records its name, and fails when told to."""

    def __init__(self, failing: dict[str, BaseException] | None = None):
        self.done: list[str] = []
        self.failing = failing or {}
        self.gone: bool | BaseException = False
        self.found: str | None = None

    async def step(self, name: str) -> str:
        self.done.append(name)
        if name in self.failing:
            raise self.failing[name]
        return name

    async def is_gone(self) -> bool:
        self.done.append("gone?")
        if isinstance(self.gone, BaseException):
            raise self.gone
        return self.gone

    async def arrived(self) -> str | None:
        self.done.append("arrived?")
        return self.found


async def _replace(steps: Steps, restore: bool = True) -> str:
    return await land_then_retire(
        lambda: steps.step("land"),
        lambda landed: steps.step(f"take back {landed}"),
        lambda: steps.step("retire"),
        steps.is_gone,
        (lambda: steps.step("restore")) if restore else None,
        steps.arrived,
    )


def test_aside_name_is_fresh_beside_the_name():
    first, second = aside_name("b.txt"), aside_name("b.txt")
    assert re.fullmatch(r"b\.txt\.mirage-[0-9a-f]{32}", first)
    assert first != second


@pytest.mark.asyncio
async def test_a_refused_set_aside_moved_nothing_so_nothing_goes_back():
    steps = Steps({"aside": ApiError("denied", 403)})
    with pytest.raises(ApiError):
        await set_aside(
            lambda: steps.step("aside"), lambda: steps.step("restore")
        )
    assert steps.done == ["aside"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failure",
    [
        ConnectionResetError("dropped"),
        ApiError("bad gateway", 502),
        ApiError("not found", 404),
    ],
    ids=["dropped", "5xx", "retried"],
)
async def test_a_set_aside_whose_answer_is_lost_is_put_back(failure):
    # The move may have gone through, so the name is put back; the error
    # that called for it stays the one raised.
    steps = Steps({"aside": failure})
    with pytest.raises(type(failure)):
        await set_aside(
            lambda: steps.step("aside"), lambda: steps.step("restore")
        )
    assert steps.done == ["aside", "restore"]


@pytest.mark.asyncio
async def test_a_replace_lands_then_retires():
    steps = Steps()
    assert await _replace(steps) == "land"
    assert steps.done == ["land", "retire"]


@pytest.mark.asyncio
async def test_a_refused_landing_restores_what_was_set_aside():
    steps = Steps({"land": ApiError("denied", 403)})
    with pytest.raises(ApiError):
        await _replace(steps)
    assert steps.done == ["land", "restore"]


@pytest.mark.asyncio
async def test_a_refused_retire_takes_the_landing_back_then_restores():
    # The landing goes first, so the name is free for what was set aside.
    steps = Steps({"retire": ApiError("denied", 403)})
    with pytest.raises(ApiError):
        await _replace(steps)
    assert steps.done == [
        "land",
        "retire",
        "gone?",
        "take back land",
        "restore",
    ]


@pytest.mark.asyncio
async def test_a_refused_retire_with_nothing_set_aside_only_takes_back():
    steps = Steps({"retire": ApiError("denied", 403)})
    with pytest.raises(ApiError):
        await _replace(steps, restore=False)
    assert steps.done == ["land", "retire", "gone?", "take back land"]


@pytest.mark.asyncio
async def test_a_retire_that_went_through_keeps_the_replace():
    # A delete whose answer was lost: what it named is gone, so undoing
    # the landing would leave nothing at the name.
    steps = Steps({"retire": ConnectionResetError("dropped")})
    steps.gone = True
    assert await _replace(steps) == "land"
    assert steps.done == ["land", "retire", "gone?"]


@pytest.mark.asyncio
async def test_a_failed_undo_keeps_the_error_that_called_for_it():
    refusal = ApiError("denied", 403)
    steps = Steps(
        {"retire": refusal, "take back land": ApiError("also denied", 403)}
    )
    with pytest.raises(ApiError) as caught:
        await _replace(steps)
    assert caught.value is refusal
    assert steps.done[-1] == "restore"


@pytest.mark.asyncio
async def test_a_cancelled_retire_still_puts_both_back():
    # A cancellation is no Exception, and must not skip the undo; it
    # reaches the caller once the undo ran.
    steps = Steps({"retire": asyncio.CancelledError()})
    with pytest.raises(asyncio.CancelledError):
        await _replace(steps)
    assert steps.done == [
        "land",
        "retire",
        "gone?",
        "take back land",
        "restore",
    ]


@pytest.mark.asyncio
async def test_a_cancelled_retire_that_went_through_still_cancels():
    steps = Steps({"retire": asyncio.CancelledError()})
    steps.gone = True
    with pytest.raises(asyncio.CancelledError):
        await _replace(steps)
    assert steps.done == ["land", "retire", "gone?"]


@pytest.mark.asyncio
async def test_a_lost_landing_that_went_through_is_finished():
    # The landing holds the name, where nothing can be put back: what it
    # made is found and the replace goes on to the retire.
    steps = Steps({"land": ConnectionResetError("dropped")})
    steps.found = "found"
    assert await _replace(steps) == "found"
    assert steps.done == ["land", "arrived?", "retire"]


@pytest.mark.asyncio
async def test_a_lost_landing_that_did_not_land_restores():
    steps = Steps({"land": ApiError("bad gateway", 502)})
    with pytest.raises(ApiError):
        await _replace(steps)
    assert steps.done == ["land", "arrived?", "restore"]


@pytest.mark.asyncio
async def test_a_refused_landing_asks_nothing():
    # A 4xx means nothing landed, so the service is not asked.
    steps = Steps({"land": ApiError("denied", 403)})
    steps.found = "found"
    with pytest.raises(ApiError):
        await _replace(steps)
    assert steps.done == ["land", "restore"]


@pytest.mark.asyncio
async def test_a_cancelled_landing_that_went_through_puts_both_back():
    steps = Steps({"land": asyncio.CancelledError()})
    steps.found = "found"
    with pytest.raises(asyncio.CancelledError):
        await _replace(steps)
    assert steps.done == ["land", "arrived?", "take back found", "restore"]


@pytest.mark.asyncio
async def test_a_retire_that_cannot_be_told_keeps_the_landing():
    # The delete may have gone through: undoing the landing then would
    # leave nothing at the name, so the landing stays and the error is
    # raised.
    failure = ConnectionResetError("dropped")
    steps = Steps({"retire": failure})
    steps.gone = ConnectionResetError("still dropped")
    with pytest.raises(ConnectionResetError) as caught:
        await _replace(steps)
    assert caught.value is failure
    assert steps.done == ["land", "retire", "gone?"]


@pytest.mark.asyncio
async def test_a_second_cancellation_lets_the_undo_finish():
    steps = Steps({"retire": ApiError("denied", 403)})
    taking = asyncio.Event()
    release = asyncio.Event()

    async def take_back(landed: str) -> None:
        steps.done.append(f"take back {landed}")
        taking.set()
        await release.wait()

    task = asyncio.ensure_future(
        land_then_retire(
            lambda: steps.step("land"),
            take_back,
            lambda: steps.step("retire"),
            steps.is_gone,
            lambda: steps.step("restore"),
        )
    )
    await taking.wait()
    task.cancel()
    await asyncio.sleep(0)
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert steps.done == [
        "land",
        "retire",
        "gone?",
        "take back land",
        "restore",
    ]
