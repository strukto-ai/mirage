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
    CommandRule,
    Decision,
    ProfileScript,
    Scope,
)
from mirage.runtime.types import ScriptSource
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


def test_rule_round_trips_and_writes_mount_only_when_set():
    bare = CommandRule(reason="no", commands=("rm",))
    data = rule_to_dict(bare)
    assert data == {"reason": "no", "commands": ["rm"], "paths": []}
    assert rule_from_dict(data) == bare
    scoped = CommandRule(
        reason="ro", commands=("git push",), paths=("/repo/*",), mount="/repo"
    )
    assert rule_to_dict(scoped)["mount"] == "/repo"
    assert rule_from_dict(rule_to_dict(scoped)) == scoped
    # A record written before a field existed reads with the default.
    assert rule_from_dict({"reason": "x"}) == CommandRule(reason="x")


def test_commands_round_trips_and_keeps_an_absent_allow_list():
    spec = AdmissionRules(
        allow=("ls", "git log"),
        ask=(CommandRule(reason="sign-off", commands=("git push",)),),
        deny=(CommandRule(reason="no", commands=("rm",)),),
    )
    assert commands_from_dict(commands_to_dict(spec)) == spec
    unlisted = AdmissionRules(deny=(CommandRule(reason="x"),))
    data = commands_to_dict(unlisted)
    assert data["allow"] is None
    assert commands_from_dict(data) == unlisted
    assert commands_from_dict({}) == AdmissionRules()


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
    }
    assert script_from_dict(data) == entry


def test_decision_round_trips_with_defaults():
    rule = CommandRule(reason="sign-off", commands=("git push",))
    record = Decision(
        id="d1",
        session_id="agent",
        agent_id="a",
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
        agent_id="",
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
