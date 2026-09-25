from unittest.mock import AsyncMock

import pytest

from mirage.shell.parse import parse
from mirage.workspace.expand.substring import substring_operands


@pytest.mark.asyncio
async def test_operands_expand_only_when_requested():
    node = parse(
        "echo ${x:$offset:$length}").named_children[0].named_children[-1]
    expand = AsyncMock(side_effect=["1", "2"])
    operands = substring_operands(node, expand)
    assert await anext(operands) == "1"
    assert expand.await_count == 1
    assert await anext(operands) == "2"
    assert expand.await_count == 2
    with pytest.raises(StopAsyncIteration):
        await anext(operands)


@pytest.mark.asyncio
@pytest.mark.parametrize("source,expanded,expected", [
    ("${x:1?2:3:4}", [], ["1?2:3", "4"]),
    ("${x:(1?2:3):4}", [], ["(1?2:3)", "4"]),
    ("${x:a[1?2:3]:4}", ["a"], ["a[1?2:3]", "4"]),
    ("${x:$offset:2}", ["1?2:3"], ["1?2:3", "2"]),
    ('${x:"1?2:3":4}', ["1?2:3"], ["1?2:3", "4"]),
    ("${x:$(echo 1):${n:-2}}", ["1", "2"], ["1", "2"]),
])
async def test_only_source_separators_split_operands(source, expanded,
                                                     expected):
    node = parse("echo " + source).named_children[0].named_children[-1]
    assert [
        text async for text in substring_operands(
            node, AsyncMock(side_effect=expanded))
    ] == expected
