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

import dataclasses
import json

import pytest
from pydantic import ValidationError

from mirage.policy.match import Outcome
from mirage.policy.types import AdmissionRules, CommandRule, Decision, Scope
from mirage.secrets.config import EnvVar
from mirage.shell.variable import ManagedRef, ShellVar, VarAttr
from mirage.types import MountMode
from mirage.workspace.session import Session
from mirage.workspace.session.constants import (CHILD_SHELL_FIELDS,
                                                INHERITED_FIELDS,
                                                TRANSIENT_FIELDS)
from mirage.workspace.session.session import (vars_from_entries, vars_from_env,
                                              vars_from_fields, vars_to_fields)
from mirage.workspace.session.state import seed_var, set_attr


def test_session_defaults():
    s = Session(session_id="test")
    assert s.session_id == "test"
    assert s.cwd == "/"
    # bash exports `$PWD` from startup, so even a session that never
    # ran `cd` has one.
    assert s.env == {"PWD": "/"}
    assert s.functions == {}
    assert s.last_exit_code == 0
    assert s._stdin_buffer is None


def test_session_custom_cwd():
    s = Session(session_id="s1", cwd="/data")
    assert s.cwd == "/data"


def test_session_env():
    s = Session(session_id="s1", vars=vars_from_env({"A": "1", "B": "2"}))
    assert s.env["A"] == "1"
    assert s.env["B"] == "2"


def test_session_env_mutation():
    s = Session(session_id="s1")
    seed_var(s, "X", "hello")
    assert s.env["X"] == "hello"
    del s.vars["X"]
    assert "X" not in s.env


def test_session_functions():
    s = Session(session_id="s1")
    s.functions["myfunc"] = []
    assert "myfunc" in s.functions


def test_session_exit_code():
    s = Session(session_id="s1")
    s.last_exit_code = 42
    assert s.last_exit_code == 42


def test_session_stdin_buffer():
    s = Session(session_id="s1")
    s._stdin_buffer = b"hello\n"
    assert s._stdin_buffer == b"hello\n"
    s._stdin_buffer = None
    assert s._stdin_buffer is None


def test_session_to_dict():
    s = Session(session_id="s1", cwd="/data", vars=vars_from_env({"K": "V"}))
    d = s.to_dict()
    assert d["session_id"] == "s1"
    assert d["cwd"] == "/data"
    assert d["env"] == {"K": "V", "PWD": "/data"}
    assert "created_at" in d


def test_session_from_dict():
    d = {
        "session_id": "s2",
        "cwd": "/tmp",
        "env": {
            "A": "1"
        },
        "created_at": 123.0
    }
    s = Session.from_dict(d)
    assert s.session_id == "s2"
    assert s.cwd == "/tmp"
    assert s.env["A"] == "1"
    assert s.created_at == 123.0


def test_session_roundtrip():
    original = Session(session_id="rt",
                       cwd="/x",
                       vars=vars_from_env({"K": "V"}))
    restored = Session.from_dict(original.to_dict())
    assert restored.session_id == original.session_id
    assert restored.cwd == original.cwd
    assert restored.env == original.env


def test_session_independent_envs():
    s1 = Session(session_id="a")
    s2 = Session(session_id="b")
    seed_var(s1, "X", "1")
    assert "X" not in s2.env


def test_session_mount_modes_default_none():
    s = Session(session_id="s")
    assert s.mount_modes is None


def test_session_mount_modes_set():
    grants = {"/s3": MountMode.READ, "/slack": MountMode.WRITE}
    s = Session(session_id="s", mount_modes=grants)
    assert s.mount_modes == grants


def test_fork_copies_every_field_including_mount_modes():
    original = Session(
        session_id="orig",
        cwd="/disk",
        functions={"f": object()},
        last_exit_code=7,
        shell_options={"errexit": True},
        vars={
            "FOO": ShellVar("bar"),
            "HOME": ShellVar(None, frozenset({VarAttr.READONLY})),
            "ARGV": ShellVar(["a", "b"]),
        },
        mount_modes={
            "/s3": MountMode.READ,
            "/dev": MountMode.EXEC,
            "/": MountMode.EXEC,
        },
    )
    forked = original.fork()
    assert forked.session_id == "orig"
    assert forked.cwd == "/disk"
    assert forked.env == {"FOO": "bar", "PWD": "/disk"}
    assert forked.mount_modes == {
        "/s3": MountMode.READ,
        "/dev": MountMode.EXEC,
        "/": MountMode.EXEC,
    }
    assert forked.mount_modes is not original.mount_modes
    assert forked.shell_options == {"errexit": True}
    assert "HOME" in forked.readonly_vars
    assert forked.arrays == {"ARGV": ["a", "b"]}
    assert forked.last_exit_code == 7


def test_to_dict_round_trips_mount_modes():
    s = Session(session_id="s",
                mount_modes={
                    "/s3": MountMode.READ,
                    "/scratch": MountMode.WRITE,
                })
    data = s.to_dict()
    assert data["mount_modes"] == {"/s3": "read", "/scratch": "write"}
    restored = Session.from_dict(data)
    assert restored.mount_modes == {
        "/s3": MountMode.READ,
        "/scratch": MountMode.WRITE,
    }
    assert isinstance(next(iter(restored.mount_modes.values())), MountMode)


def test_to_dict_omits_grants_when_unrestricted():
    s = Session(session_id="s")
    data = s.to_dict()
    assert "mount_modes" not in data
    assert Session.from_dict(data).mount_modes is None


def test_fork_overrides_apply_without_mutating_original():
    original = Session(session_id="orig",
                       cwd="/disk",
                       vars=vars_from_env({"FOO": "bar"}))
    forked = original.fork(cwd="/ram", vars=vars_from_env({"BAZ": "qux"}))
    assert forked.cwd == "/ram"
    # `$PWD` follows the caller-supplied cwd rather than staying stale.
    assert forked.env == {"BAZ": "qux", "PWD": "/ram"}
    assert original.cwd == "/disk"
    assert original.env == {"FOO": "bar", "PWD": "/disk"}


def test_fork_drops_the_logical_cwd_when_the_caller_overrides_cwd():
    # A caller-supplied cwd has no typed spelling behind it, so carrying
    # the source's logical name over would make the fork's `pwd` describe
    # a directory it is not in -- the bug an `execute(cwd=...)` call hit.
    original = Session(session_id="orig",
                       cwd="/data/deep/real",
                       logical_cwd="/data/lk")
    assert original.fork(cwd="/ram").logical_cwd is None
    assert original.fork().logical_cwd == "/data/lk"


def test_fork_keeps_an_explicit_logical_cwd_beside_a_cwd_override():
    original = Session(session_id="orig", cwd="/a")
    forked = original.fork(cwd="/data/deep/real", logical_cwd="/data/lk")
    assert forked.logical_cwd == "/data/lk"


def test_fork_deep_copies_mutable_containers():
    original = Session(session_id="orig",
                       vars={
                           "FOO": ShellVar("bar"),
                           "A": ShellVar(["1"]),
                       })
    forked = original.fork()
    seed_var(forked, "NEW", "leaked?")
    forked.arrays["A"].append("2")
    assert "NEW" not in original.env
    assert original.arrays["A"] == ["1"]


def test_every_field_is_classified_as_inherited_or_transient():
    declared = {f.name for f in dataclasses.fields(Session)}
    classified = set(INHERITED_FIELDS) | set(TRANSIENT_FIELDS)
    assert declared == classified


def test_child_shell_fields_are_a_subset_of_the_declared_fields():
    declared = {f.name for f in dataclasses.fields(Session)}
    assert set(CHILD_SHELL_FIELDS) <= declared


def test_fork_carries_every_inherited_field():
    original = Session(session_id="orig", script_name="/data/run.sh")
    assert original.fork().script_name == "/data/run.sh"


def test_snapshot_and_restore_undo_a_child_shell():
    session = Session(session_id="s",
                      cwd="/data",
                      vars=vars_from_env({"A": "1"}))
    saved = session.snapshot()
    session.cwd = "/other"
    seed_var(session, "A", "2")
    session.functions["f"] = []
    session.script_name = "run.sh"
    session.restore(saved)
    assert session.cwd == "/data"
    assert session.env == {"A": "1", "PWD": "/data"}
    assert session.functions == {}
    assert session.script_name is None


def test_argv0_keeps_an_empty_script_name():
    assert Session(session_id="s").argv0 == "mirage"
    assert Session(session_id="s", script_name="").argv0 == ""


def test_to_dict_carries_the_attributes_beside_the_values():
    s = Session(session_id="s1")
    seed_var(s, "PLAIN", "hello")
    s.vars["EXPO"] = ShellVar("world", frozenset({VarAttr.EXPORT}))
    s.vars["MARKED"] = ShellVar(None,
                                frozenset({VarAttr.EXPORT, VarAttr.READONLY}))
    data = s.to_dict()
    # `env` stays a plain name/value map, the shape an embedder writes
    # and the other language reads; the letters ride beside it. An unset
    # name has no value to carry and appears only in `var_attrs`.
    assert data["env"] == {"PWD": "/", "PLAIN": "hello", "EXPO": "world"}
    assert data["var_attrs"] == {"PWD": "x", "EXPO": "x", "MARKED": "rx"}


def test_var_attrs_is_written_even_when_empty():
    # Its *presence* is the discriminator, so it has to be there even
    # with nothing in it. Written only when non-empty, a session whose
    # last attribute had been cleared serialized as a bare process
    # environment, and the reload re-exported everything it held.
    s = Session(session_id="s1")
    seed_var(s, "X", "secret")
    # `export -n PWD` clears the one attribute a fresh session carries.
    set_attr(s, "PWD", VarAttr.EXPORT, False)
    data = s.to_dict()
    assert data["var_attrs"] == {}
    back = Session.from_dict(data)
    assert back.vars["X"] == ShellVar("secret", frozenset())
    assert VarAttr.EXPORT not in back.vars["PWD"].attrs


def test_a_stored_session_round_trips_without_promoting_anything():
    # The bug this replaced: `to_dict` wrote every scalar under `env` and
    # `from_dict` read `env` as a process environment, so one flush and
    # reload turned a plain `X=hello` into an exported one and shipped it
    # to every child runtime.
    s = Session(session_id="s1")
    seed_var(s, "PLAIN", "hello")
    s.vars["EXPO"] = ShellVar("world", frozenset({VarAttr.EXPORT}))
    s.vars["MARKED"] = ShellVar(None, frozenset({VarAttr.READONLY}))
    back = Session.from_dict(s.to_dict())
    assert back.vars["PLAIN"] == ShellVar("hello", frozenset())
    assert back.vars["EXPO"] == ShellVar("world", frozenset({VarAttr.EXPORT}))
    assert back.vars["MARKED"] == ShellVar(None, frozenset({VarAttr.READONLY}))


def test_a_payload_with_no_attributes_is_read_as_a_process_environment():
    # An embedder's dict, or a record another writer hand-built, carries
    # values and no letters. That shape *is* a process environment, so
    # every name in it is exported -- which is what `ws.env = {...}` and
    # a cross-language handoff both mean.
    back = Session.from_dict({"session_id": "x", "env": {"A": "1"}})
    assert back.vars["A"] == ShellVar("1", frozenset({VarAttr.EXPORT}))


def test_session_command_tier_round_trips_through_the_record():
    own = AdmissionRules(allow=("ls", "git log"),
                         ask=(CommandRule(reason="sign-off",
                                          commands=("git push", ),
                                          paths=("/repo/*", ),
                                          mount="/repo"), ),
                         deny=(CommandRule(reason="no", commands=("rm", )), ))
    s = Session(session_id="s1", commands=own)
    d = s.to_dict()
    assert d["commands"] == {
        "allow": ["ls", "git log"],
        "ask": [{
            "reason": "sign-off",
            "commands": ["git push"],
            "paths": ["/repo/*"],
            "mount": "/repo"
        }],
        "deny": [{
            "reason": "no",
            "commands": ["rm"],
            "paths": []
        }],
    }
    assert Session.from_dict(d).commands == own
    # None means unstated and is not written; a tier without an allow
    # list writes allow as null, distinct from an empty list.
    assert "commands" not in Session(session_id="s2").to_dict()
    bare = Session(session_id="s3",
                   commands=AdmissionRules(deny=(CommandRule(reason="x"), )))
    assert bare.to_dict()["commands"]["allow"] is None
    assert Session.from_dict(bare.to_dict()).commands == bare.commands


def test_session_decisions_round_trip_through_the_record():
    rule = CommandRule(reason="sign-off", commands=("git push", ))
    records = (Decision(id="d1",
                        session_id="s1",
                        agent_id="a",
                        command="git",
                        argv=("push", ),
                        cwd="/repo",
                        paths=(),
                        reason="sign-off",
                        rule=rule,
                        outcome=Outcome.ALLOW,
                        scope=Scope.SESSION),
               Decision(id="d2",
                        session_id="s1",
                        agent_id="a",
                        command="git",
                        argv=("push", "--force"),
                        cwd="/repo",
                        paths=(),
                        reason="sign-off",
                        rule=rule,
                        outcome=Outcome.DENY))
    s = Session(session_id="s1", decisions=records)
    d = s.to_dict()
    assert [r["id"] for r in d["decisions"]] == ["d1", "d2"]
    assert [r["outcome"] for r in d["decisions"]] == ["allow", "deny"]
    assert [r["scope"] for r in d["decisions"]] == ["session", "once"]
    assert Session.from_dict(d).decisions == records
    # Nothing held writes nothing, and a fork carries what is held.
    assert "decisions" not in Session(session_id="s2").to_dict()
    assert s.fork().decisions == records


def test_vars_from_entries_literal_short_form_exports():
    out = vars_from_entries({"APP": "myapp"})
    assert out == {"APP": ShellVar("myapp", frozenset({VarAttr.EXPORT}))}


def test_vars_from_entries_literal_long_form_attrs():
    out = vars_from_entries({
        "EDITOR": EnvVar(value="vi", readonly=True),
        "LOCAL": EnvVar(value="x", export=False),
    })
    assert out["EDITOR"] == ShellVar(
        "vi", frozenset({VarAttr.EXPORT, VarAttr.READONLY}))
    assert out["LOCAL"] == ShellVar("x", frozenset())


def test_vars_from_entries_managed_is_exported_unset():
    out = vars_from_entries({
        "TOKEN":
        EnvVar.model_validate({
            "from": "aws-sm",
            "ref": "prod/tokens",
            "key": "api"
        })
    })
    var = out["TOKEN"]
    assert var.value is None
    assert var.attrs == frozenset({VarAttr.EXPORT})
    assert var.managed == ManagedRef("aws-sm", "prod/tokens", "api", False)


def test_vars_from_entries_key_defaults_to_the_name():
    out = vars_from_entries({"DB_URL": EnvVar.model_validate({"from": "env"})})
    assert out["DB_URL"].managed == ManagedRef("env", "", "DB_URL", False)


def test_vars_from_entries_eager_flag():
    out = vars_from_entries(
        {"T": EnvVar.model_validate({
            "from": "env",
            "fetch": "eager"
        })})
    assert out["T"].managed == ManagedRef("env", "", "T", True)


def test_vars_from_entries_coerces_raw_mappings():
    out = vars_from_entries({
        "A": {
            "value": "1"
        },
        "B": {
            "from": "env"
        },
    })
    assert out["A"] == ShellVar("1", frozenset({VarAttr.EXPORT}))
    assert out["B"].managed == ManagedRef("env", "", "B", False)


def test_vars_from_entries_refuses_readonly_on_managed():
    with pytest.raises(ValidationError, match="readonly"):
        vars_from_entries({"T": {"from": "env", "readonly": True}})


def _managed_session() -> Session:
    exported = frozenset({VarAttr.EXPORT})
    return Session(session_id="s1",
                   vars={
                       "FETCHED":
                       ShellVar("s3cr3t",
                                exported,
                                managed=ManagedRef("aws-sm", "prod", "api",
                                                   False)),
                       "PENDING":
                       ShellVar(None,
                                exported,
                                managed=ManagedRef("env", "", "PENDING",
                                                   True)),
                       "PLAIN":
                       ShellVar("hello", frozenset()),
                   })


def test_managed_vars_serialize_as_pointers_never_values():
    d = _managed_session().to_dict()
    # The fetched plaintext must not land anywhere in the record.
    assert "FETCHED" not in d["env"]
    assert "PENDING" not in d["env"]
    assert "s3cr3t" not in json.dumps(d)
    assert d["managed"] == {
        "FETCHED": {
            "from": "aws-sm",
            "ref": "prod",
            "key": "api"
        },
        "PENDING": {
            "from": "env",
            "ref": "",
            "key": "PENDING",
            "fetch": "eager"
        },
    }
    # The letters still record, so a stripped payload keeps the name.
    assert d["var_attrs"]["FETCHED"] == "x"
    assert d["env"]["PLAIN"] == "hello"


def test_managed_vars_restore_declared_but_unfetched():
    restored = Session.from_dict(_managed_session().to_dict())
    for name, eager in (("FETCHED", False), ("PENDING", True)):
        var = restored.vars[name]
        assert var.value is None, name
        assert var.attrs == frozenset({VarAttr.EXPORT}), name
        assert var.managed is not None and var.managed.eager is eager, name
    assert restored.vars["FETCHED"].managed == ManagedRef(
        "aws-sm", "prod", "api", False)
    assert restored.vars["PLAIN"] == ShellVar("hello", frozenset())


def test_a_smuggled_value_for_a_managed_name_is_discarded_on_load():
    d = _managed_session().to_dict()
    tampered = dict(d)
    tampered["env"] = {**d["env"], "FETCHED": "planted"}
    restored = Session.from_dict(tampered)
    assert restored.vars["FETCHED"].value is None
    assert restored.vars["FETCHED"].managed is not None


def test_a_session_with_no_managed_vars_writes_no_managed_key():
    s = Session(session_id="s2", vars=vars_from_env({"A": "1"}))
    assert "managed" not in s.to_dict()


def test_vars_fields_round_trip_keeps_the_pointer_never_a_value():
    table = vars_from_entries({
        "TOKEN": {
            "from": "aws-sm",
            "ref": "prod",
            "key": "api"
        },
        "MODE": "prod",
    })
    fields = vars_to_fields(table)
    assert "TOKEN" not in fields["env"]
    assert fields["managed"]["TOKEN"] == {
        "from": "aws-sm",
        "ref": "prod",
        "key": "api"
    }
    restored = vars_from_fields(fields)
    assert restored["TOKEN"].value is None
    assert restored["TOKEN"].managed == ManagedRef("aws-sm", "prod", "api",
                                                   False)
    assert restored["MODE"] == table["MODE"]


def test_vars_fields_round_trip_keeps_eager():
    table = vars_from_entries(
        {"E": {
            "from": "aws-sm",
            "ref": "prod",
            "fetch": "eager"
        }})
    restored = vars_from_fields(vars_to_fields(table))
    managed = restored["E"].managed
    assert managed is not None and managed.eager


def test_vars_fields_never_writes_a_fetched_value():
    table = vars_from_entries({"T": {"from": "aws-sm", "ref": "prod"}})
    table["T"] = dataclasses.replace(table["T"], value="plain")
    fields = vars_to_fields(table)
    assert "T" not in fields["env"]
    assert vars_from_fields(fields)["T"].value is None
