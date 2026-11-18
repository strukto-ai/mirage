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

from mirage.policy.match import Outcome
from mirage.policy.types import (
    AdmissionRules,
    CommandNode,
    CommandRule,
    Decision,
    ProfileScript,
    Scope,
    ScopedTree,
)
from mirage.runtime.types import ScriptSource
from mirage.secrets.config import SecretRef
from mirage.workspace.session.constants import OLDER_FORMAT
from mirage.workspace.session.serialize import (
    commands_from_dict,
    commands_to_dict,
    decision_from_dict,
    decision_to_dict,
    rule_from_dict,
    rule_to_dict,
    script_from_dict,
    script_to_dict,
)
from tests.fixtures.command_trees import trees


def test_rule_round_trips_and_writes_optional_fields_only_when_set():
    leaf = CommandRule(
        reason="ro",
        decision=Outcome.DENY,
        at="/git/push/*",
        paths=("/repo/*",),
        mount="/repo",
    )
    data = rule_to_dict(leaf)
    assert data == {
        "reason": "ro",
        "decision": "deny",
        "paths": ["/repo/*"],
        "at": "/git/push/*",
        "mount": "/repo",
    }
    assert rule_from_dict(data) == leaf
    coded = CommandRule(reason="no", commands=("rm",))
    assert rule_to_dict(coded) == {
        "reason": "no",
        "paths": [],
        "commands": ["rm"],
    }
    assert rule_from_dict(rule_to_dict(coded)) == coded
    assert rule_from_dict({"reason": "x"}) == CommandRule(reason="x")


def test_command_trees_round_trip_with_their_mounts():
    spec = trees(
        {"*": "deny", "ls": "allow", "rm": {"-r": "ask"}},
        mounts={"/repo": {"git": {"push": "deny"}}},
        inline={"cp": "deny"},
    )
    data = commands_to_dict(spec)
    assert data == [
        {
            "mount": "",
            "commands": {
                "*": "deny",
                "ls": "allow",
                "rm": {"--recursive": "ask"},
            },
        },
        {"mount": "/repo", "commands": {"git": {"push": "deny"}}},
        {"mount": "", "commands": {"cp": "deny"}, "inline": True},
    ]
    assert commands_from_dict(data) == spec
    assert commands_from_dict(None) is None


def test_flat_rules_read_back_as_the_closed_tree():
    flat = {"allow": ["ls"], "ask": [], "deny": []}
    assert commands_from_dict(None, flat) == OLDER_FORMAT
    assert commands_from_dict(commands_to_dict(trees({})), flat) == (
        AdmissionRules((ScopedTree(CommandNode()),))
    )


def test_script_round_trips_with_its_runtime_and_settings():
    entry = ProfileScript(
        profile="release",
        script=ScriptSource("pass\n"),
        runtime="wasi",
        config={"home": "/w"},
    )
    data = script_to_dict(entry)
    assert data == {
        "profile": "release",
        "language": "python",
        "source": "pass\n",
        "runtime": "wasi",
        "config": {"home": "/w"},
        "env": {},
    }
    assert script_from_dict(data) == entry


def test_script_keeps_an_env_pointer_as_the_pointer():
    entry = ProfileScript(
        profile="release",
        script=ScriptSource("pass\n"),
        runtime="monty",
        env={
            "LLM_URL": "https://llm/v1",
            "LLM_KEY": SecretRef(provider="aws-sm", ref="prod/llm", key="key"),
        },
    )
    data = script_to_dict(entry)
    assert data["env"] == {
        "LLM_URL": "https://llm/v1",
        "LLM_KEY": {"from": "aws-sm", "ref": "prod/llm", "key": "key"},
    }
    assert script_from_dict(data) == entry
    del data["env"]
    assert script_from_dict(data).env == {}


def test_decision_round_trips_with_defaults():
    rule = CommandRule(reason="sign-off", commands=("git push",))
    record = Decision(
        id="d1",
        session_id="agent",
        command="git",
        argv=("push",),
        cwd="/repo",
        paths=("/repo",),
        reason="sign-off",
        rule=rule,
        outcome=Outcome.ALLOW,
        scope=Scope.SESSION,
        note="ok",
    )
    assert decision_from_dict(decision_to_dict(record)) == record
    # A record still waiting has no outcome, and a sparse one reads
    # back on the defaults rather than failing.
    waiting = Decision(
        id="d2",
        session_id="agent",
        command="git",
        argv=(),
        cwd="/",
        paths=(),
        reason="",
        rule=rule,
    )
    assert decision_from_dict(decision_to_dict(waiting)) == waiting
    read = decision_from_dict({"id": "d3", "rule": rule_to_dict(rule)})
    assert (read.outcome, read.scope, read.cwd) == (None, Scope.ONCE, "/")
