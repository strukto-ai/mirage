import asyncio
import json
from unittest.mock import AsyncMock

import aiohttp
import pytest

from mirage import Workspace
from mirage.commands.cli.builtin.linear import LINEAR
from mirage.commands.cli.builtin.linear.issue import relation
from mirage.commands.config import Context
from mirage.core.linear import client
from mirage.core.linear.config import LinearConfig
from mirage.errors.types import CommandTimeoutError
from mirage.io.types import materialize
from mirage.policy import Deny, Policy

A = {"id": "iss_a", "identifier": "ENG-1", "title": "First"}
B = {"id": "iss_b", "identifier": "ENG-2", "title": "Second"}
ROW = {"id": "r1", "type": "blocks", "issue": A, "relatedIssue": B}


def page(rows, more=False, cursor=None, incoming=False):
    return {
        "issue": {
            "inverseRelations" if incoming else "relations": {
                "nodes": rows,
                "pageInfo": {"hasNextPage": more, "endCursor": cursor},
            }
        }
    }


async def rendered(result):
    return json.loads(await materialize(result[0]))


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "kind,source,target,direction",
    [
        ("BLOCKS", "iss_a", "iss_b", "outgoing"),
        ("blocked-by", "iss_b", "iss_a", "incoming"),
        ("related", "iss_a", "iss_b", "outgoing"),
        ("duplicate", "iss_a", "iss_b", "outgoing"),
    ],
)
async def test_add_resolves_both_operands_and_preserves_direction(
    monkeypatch, kind, source, target, direction
):
    stored = "blocks" if kind.lower() == "blocked-by" else kind.lower()
    row = {
        "id": "r1",
        "type": stored,
        "issue": A if source == "iss_a" else B,
        "relatedIssue": B if target == "iss_b" else A,
    }
    request = AsyncMock(
        side_effect=[
            {"issue": A},
            {"issue": B},
            {"issueRelationCreate": {"success": True, "issueRelation": row}},
        ]
    )
    monkeypatch.setattr(client, "graphql_request", request)
    result = await rendered(
        await relation.add(
            None,
            [],
            ["eng-1", kind, "https://linear.app/acme/issue/ENG-2/title"],
            Context(),
        )
    )
    assert result["issue_key"] == "ENG-1"
    assert result["related_issue_key"] == "ENG-2"
    assert result["direction"] == direction
    assert request.await_args.args[2] == {
        "input": {"issueId": source, "relatedIssueId": target, "type": stored}
    }
    assert request.await_args_list[0].args[2] == {"issueId": "ENG-1"}
    assert request.await_args_list[1].args[2] == {"issueId": "ENG-2"}
    assert request.await_count == 3


@pytest.mark.parametrize(
    "reference,expected",
    [
        ("123A-42", "123A-42"),
        ("eng-1", "ENG-1"),
        ("https://linear.app:443/acme/issue/ENG-1", "ENG-1"),
        ("http://linear.app:80/acme/issue/ENG-1", "ENG-1"),
        ("https://linear.app/acme/x/../issue/ENG-1", "ENG-1"),
        ("https://linear.app/acme/x/%2e%2e/issue/ENG-1", "ENG-1"),
        ("www.linear.app/acme/issue/eng-1/title#comment-deadbeef", "ENG-1"),
        ("https://linear.app/acme/issue/ENG%2D1/title", "ENG-1"),
        (
            "123e4567-e89b-12d3-a456-426614174000",
            "123e4567-e89b-12d3-a456-426614174000",
        ),
        ("iss_plat1", "iss_plat1"),
    ],
)
def test_reference_forms(reference, expected):
    assert relation.prepare_reference(reference) == expected


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "texts",
    [
        ["ENG-1", "similar", "ENG-2"],
        ["ENG-1", "blocks", "ENG-0"],
        ["ENG-1", "blocks", "https://linear.app../acme/issue/ENG-2"],
        ["ENG-1", "blocks", "https://linear.app/acme/issue/%FF"],
        ["ENG-1", "blocks", "https://evil.test/acme/issue/ENG-2"],
        ["ENG-1", "blocks", "https://linear.app:123/acme/issue/ENG-2"],
        ["ENG-1", "blocks", "https://linear.app/acme/issue/ENG-2#bad"],
        ["ENG-1", "blocks"],
        ["ENG-1", "blocks", "ENG-2", "extra"],
    ],
)
async def test_invalid_operands_send_no_requests(monkeypatch, texts):
    request = AsyncMock()
    monkeypatch.setattr(client, "graphql_request", request)
    with pytest.raises(ValueError):
        await relation.add(None, [], texts, Context())
    request.assert_not_called()


@pytest.mark.asyncio
async def test_list_reads_both_connections_and_marks_incoming_duplicates(
    monkeypatch,
):
    duplicate = {
        **ROW,
        "id": "r2",
        "type": "duplicate",
        "issue": B,
        "relatedIssue": A,
    }
    request = AsyncMock(
        side_effect=[
            {"issue": A},
            page([ROW], True, "out"),
            page([]),
            page([duplicate], True, "in", True),
            page([], incoming=True),
        ]
    )
    monkeypatch.setattr(client, "graphql_request", request)
    result = await rendered(
        await relation.list_relations(None, [], ["ENG-1"], Context())
    )
    assert [
        (row["type"], row["direction"], row["related_issue_key"])
        for row in result
    ] == [("blocks", "outgoing", "ENG-2"), ("duplicate", "incoming", "ENG-2")]
    assert [
        call.args[2].get("after") for call in request.await_args_list[1:]
    ] == [None, "out", None, "in"]


@pytest.mark.asyncio
async def test_delete_finds_exact_direction_after_later_pages(monkeypatch):
    request = AsyncMock(
        side_effect=[
            {"issue": B},
            {"issue": A},
            page([], True, "later"),
            page([ROW]),
            {"issueRelationDelete": {"success": True}},
        ]
    )
    monkeypatch.setattr(client, "graphql_request", request)
    result = await rendered(
        await relation.delete_relation(
            None,
            [],
            ["ENG-2", "blocked-by", "ENG-1"],
            Context(flags={"yes": True}),
        )
    )
    assert result["type"] == "blocked-by"
    assert result["direction"] == "incoming"
    assert request.await_args.args[2] == {"id": "r1"}
    assert request.await_args_list[2].args[2]["issueId"] == "iss_a"


@pytest.mark.asyncio
@pytest.mark.parametrize("exists", [True, False])
async def test_delete_lookup_precedes_noninteractive_confirmation(
    monkeypatch, exists
):
    request = AsyncMock(
        side_effect=[{"issue": A}, {"issue": B}, page([ROW] if exists else [])]
    )
    monkeypatch.setattr(client, "graphql_request", request)
    with pytest.raises(
        ValueError if exists else FileNotFoundError,
        match="--yes" if exists else "relation",
    ):
        await relation.delete_relation(
            None, [], ["ENG-1", "blocks", "ENG-2"], Context()
        )
    assert request.await_count == 3


@pytest.mark.asyncio
@pytest.mark.parametrize("cursor", [None, "", "same"])
async def test_relation_pagination_refuses_nonadvancing_cursors(
    monkeypatch, cursor
):
    request = AsyncMock(return_value=page([], True, cursor))
    monkeypatch.setattr(client, "graphql_request", request)
    with pytest.raises(client.LinearAPIError, match="pagination"):
        await client.list_issue_relations(None, "iss_a")
    assert request.await_count == (2 if cursor == "same" else 1)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "payload", [{"success": False}, {}, {"success": "yes"}]
)
@pytest.mark.parametrize("operation", ["create", "delete"])
async def test_failed_mutations_are_not_retried(
    monkeypatch, payload, operation
):
    request = AsyncMock(
        return_value={
            "issueRelationCreate"
            if operation == "create"
            else "issueRelationDelete": payload
        }
    )
    monkeypatch.setattr(client, "graphql_request", request)
    with pytest.raises(client.LinearAPIError):
        if operation == "create":
            await client.issue_relation_create(None, {})
        else:
            await client.issue_relation_delete(None, "r1")
    assert request.await_count == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("issue", [None, {"id": ""}, {"id": "x"}])
async def test_bad_issue_resolution_never_mutates(monkeypatch, issue):
    request = AsyncMock(return_value={"issue": issue})
    monkeypatch.setattr(client, "graphql_request", request)
    with pytest.raises((FileNotFoundError, client.LinearAPIError)):
        await relation.add(None, [], ["ENG-1", "blocks", "ENG-2"], Context())
    assert request.await_count == 1


def test_relation_handlers_preserve_policy_write_classification():
    assert LINEAR.handlers["issue relation add"].write
    assert LINEAR.handlers["issue relation delete"].write
    assert not LINEAR.handlers["issue relation list"].write


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "created", [None, {**ROW, "type": "related"}, {**ROW, "issue": B}]
)
async def test_unconfirmed_created_relation_reports_unknown_outcome_once(
    monkeypatch, created
):
    request = AsyncMock(
        return_value={
            "issueRelationCreate": {"success": True, "issueRelation": created}
        }
    )
    monkeypatch.setattr(client, "graphql_request", request)
    with pytest.raises(client.LinearAPIError, match="outcome is unknown"):
        await client.issue_relation_create(
            None,
            {"issueId": A["id"], "relatedIssueId": B["id"], "type": "blocks"},
        )
    assert request.await_count == 1


@pytest.mark.asyncio
async def test_actual_shell_policy_refuses_relation_write_before_requests(
    monkeypatch,
):
    class NoWrites(Policy):
        async def pre_command(self, ctx):
            return Deny("read only") if ctx.write else None

    request = AsyncMock()
    monkeypatch.setattr(client, "graphql_request", request)
    workspace = Workspace({}, policies=[NoWrites()])
    try:
        workspace.register_cli(
            "linear", LINEAR, LinearConfig(api_key="lin_api_local_test")
        )
        result = await workspace.shell(
            "linear issue relation add ENG-1 duplicate ENG-2"
        )
        assert result.exit_code != 0
        assert result.refusal.reason == "read only"
    finally:
        await workspace.close()
    request.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["create", "delete"])
@pytest.mark.parametrize(
    "failure",
    [
        aiohttp.ClientConnectionError("reply lost"),
        TimeoutError("reply timed out"),
        json.JSONDecodeError("truncated reply", "", 0),
        client.LinearAPIError("upstream unavailable", status=503),
    ],
)
async def test_uncertain_request_failure_preserves_cause_without_retry(
    monkeypatch, operation, failure
):
    request = AsyncMock(side_effect=failure)
    monkeypatch.setattr(client, "graphql_request", request)
    with pytest.raises(
        client.LinearAPIError, match="outcome is unknown"
    ) as caught:
        if operation == "create":
            await client.issue_relation_create(None, {})
        else:
            await client.issue_relation_delete(None, "r1")
    assert caught.value.__cause__ is failure
    assert request.await_count == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["create", "delete"])
@pytest.mark.parametrize(
    "failure",
    [
        client.LinearAPIError("access denied", status=403),
        client.LinearAPIError(
            "invalid relation", errors=[{"message": "invalid relation"}]
        ),
    ],
)
async def test_confirmed_service_refusal_is_preserved(
    monkeypatch, operation, failure
):
    request = AsyncMock(side_effect=failure)
    monkeypatch.setattr(client, "graphql_request", request)
    with pytest.raises(client.LinearAPIError) as caught:
        if operation == "create":
            await client.issue_relation_create(None, {})
        else:
            await client.issue_relation_delete(None, "r1")
    assert caught.value is failure
    assert request.await_count == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["create", "delete"])
@pytest.mark.parametrize(
    "failure", [asyncio.CancelledError(), CommandTimeoutError("linear", 1)]
)
async def test_caller_cancellation_and_budget_timeout_propagate(
    monkeypatch, operation, failure
):
    request = AsyncMock(side_effect=failure)
    monkeypatch.setattr(client, "graphql_request", request)
    with pytest.raises(type(failure)) as caught:
        if operation == "create":
            await client.issue_relation_create(None, {})
        else:
            await client.issue_relation_delete(None, "r1")
    assert caught.value is failure
    assert request.await_count == 1
