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

import pytest

from mirage.policy.match import Outcome
from mirage.policy.profile import CompiledProfile
from mirage.policy.types import (AdmissionRules, CommandRule, Decision,
                                 HideReason, ProfileScript, Scope)
from mirage.resource.ram import RAMResource
from mirage.runtime.types import ScriptSource
from mirage.shell.variable import ShellVar
from mirage.types import (HiddenPaths, HiddenVars, MountMode, ShowEntry,
                          ShownPaths)
from mirage.workspace import Workspace
from mirage.workspace.session import RAMSessionStore, SessionManager
from mirage.workspace.session.session import vars_from_entries
from mirage.workspace.session.state import seed_var


def _run(coro):
    return asyncio.run(coro)


def test_manager_default_session():
    mgr = SessionManager("default")
    s = mgr.get("default")
    assert s.session_id == "default"


def test_manager_default_cwd():
    mgr = SessionManager("default")
    assert mgr.cwd == "/"
    mgr.cwd = "/data"
    assert mgr.cwd == "/data"
    assert mgr.get("default").cwd == "/data"


def test_manager_default_env():
    mgr = SessionManager("default")
    # A fresh session carries the seeded `$PWD` and nothing else.
    assert mgr.env == {"PWD": "/"}
    mgr.env = {"A": "1"}
    assert mgr.env == {"A": "1"}
    assert mgr.get("default").env == {"A": "1"}


def test_manager_create_session():
    mgr = SessionManager("default")
    s = mgr.create("worker-1")
    assert s.session_id == "worker-1"
    assert mgr.get("worker-1") is s


def test_manager_create_duplicate_raises():
    mgr = SessionManager("default")
    mgr.create("s1")
    with pytest.raises(ValueError, match="already exists"):
        mgr.create("s1")


def test_manager_get_missing_raises():
    mgr = SessionManager("default")
    with pytest.raises(KeyError):
        mgr.get("nonexistent")


def test_manager_list_sessions():
    mgr = SessionManager("default")
    mgr.create("s1")
    mgr.create("s2")
    sessions = mgr.list()
    ids = {s.session_id for s in sessions}
    assert ids == {"default", "s1", "s2"}


def test_manager_close_session():
    mgr = SessionManager("default")
    mgr.create("temp")
    _run(mgr.close("temp"))
    with pytest.raises(KeyError):
        mgr.get("temp")


def test_manager_close_default_raises():
    mgr = SessionManager("default")
    with pytest.raises(ValueError, match="Cannot close"):
        _run(mgr.close("default"))


def test_manager_close_missing_raises():
    mgr = SessionManager("default")
    with pytest.raises(KeyError):
        _run(mgr.close("nonexistent"))


def test_manager_close_all():
    mgr = SessionManager("default")
    mgr.create("s1")
    mgr.create("s2")
    _run(mgr.close_all())
    sessions = mgr.list()
    assert len(sessions) == 1
    assert sessions[0].session_id == "default"


def test_manager_sessions_isolated():
    mgr = SessionManager("default")
    s1 = mgr.create("s1")
    s2 = mgr.create("s2")
    seed_var(s1, "X", "from-s1")
    s1.cwd = "/s1"
    assert "X" not in s2.env
    assert s2.cwd == "/"


def test_manager_lock_for():
    mgr = SessionManager("default")
    lock = mgr.lock_for("default")
    assert lock is not None

    mgr.create("s1")
    lock2 = mgr.lock_for("s1")
    assert lock2 is not lock


def test_manager_create_with_mount_modes():
    mgr = SessionManager("default")
    grants = {"/s3": MountMode.READ, "/slack": MountMode.WRITE}
    s = mgr.create("agent", mount_modes=grants)
    assert s.mount_modes == grants


def test_manager_create_default_unrestricted():
    mgr = SessionManager("default")
    s = mgr.create("worker")
    assert s.mount_modes is None


@pytest.mark.asyncio
async def test_manager_hydrates_from_store():
    store = RAMSessionStore()
    await store.set(
        "restored", {
            "session_id": "restored",
            "cwd": "/w",
            "env": {
                "K": "v"
            },
            "created_at": 1.0,
            "mount_modes": {
                "/data": "read"
            }
        })
    mgr = SessionManager("default", store=store)
    await mgr.ensure_loaded()
    s = mgr.get("restored")
    assert s.cwd == "/w"
    assert s.env == {"K": "v", "PWD": "/w"}
    assert s.mount_modes == {"/data": MountMode.READ}


@pytest.mark.asyncio
async def test_manager_hydration_local_wins():
    store = RAMSessionStore()
    await store.set("s1", {"session_id": "s1", "cwd": "/stale"})
    mgr = SessionManager("default", store=store)
    local = mgr.create("s1")
    local.cwd = "/fresh"
    await mgr.ensure_loaded()
    assert mgr.get("s1").cwd == "/fresh"


@pytest.mark.asyncio
async def test_manager_default_adopts_stored_fields():
    store = RAMSessionStore()
    await store.set("default", {
        "session_id": "default",
        "cwd": "/w",
        "env": {
            "A": "1"
        }
    })
    mgr = SessionManager("default", store=store)
    await mgr.ensure_loaded()
    assert mgr.cwd == "/w"
    assert mgr.env == {"A": "1", "PWD": "/w"}


@pytest.mark.asyncio
async def test_manager_default_adopts_stored_hidden_specs():
    # A restarted daemon must not wake up unrestricted: the stored
    # hidden shapes land on the default placeholder with the other
    # durable fields, or the first command after restart reads what
    # the spec hides and the next flush erases the restriction.
    store = RAMSessionStore()
    await store.set(
        "default", {
            "session_id": "default",
            "cwd": "/w",
            "env": {},
            "hidden_paths": {
                "paths": ["/s3/secrets"],
                "patterns": ["*.key"],
            },
            "hidden_vars": {
                "names": ["SLACK_TOKEN"],
                "patterns": [],
            },
        })
    mgr = SessionManager("default", store=store)
    await mgr.ensure_loaded()
    default = mgr.get("default")
    assert default.hidden_paths == HiddenPaths(paths=("/s3/secrets", ),
                                               patterns=("*.key", ))
    assert default.hidden_vars == HiddenVars(names=("SLACK_TOKEN", ))


@pytest.mark.asyncio
async def test_manager_default_adopts_stored_path_axis():
    # The show half and the reasons table are durable restrictions like
    # the hides beside them: dropped here, a restarted daemon's carve-out
    # would vanish (every show subtree reads ENOENT again) and the next
    # flush would erase both from the store.
    store = RAMSessionStore()
    await store.set(
        "default", {
            "session_id":
            "default",
            "cwd":
            "/w",
            "env": {},
            "hidden_paths": {
                "paths": ["/repo"],
                "patterns": [],
            },
            "shown_paths": {
                "entries": [{
                    "path": "/repo/public",
                    "mode": "read"
                }, {
                    "path": "/repo/notes"
                }],
            },
            "hide_reasons": [{
                "patterns": ["/repo"],
                "reason": "keep the bulk out of context",
            }],
        })
    mgr = SessionManager("default", store=store)
    await mgr.ensure_loaded()
    default = mgr.get("default")
    assert default.shown_paths == ShownPaths(entries=(
        ShowEntry("/repo/public", MountMode.READ),
        ShowEntry("/repo/notes", None),
    ))
    assert default.hide_reasons == (HideReason(
        patterns=("/repo", ), reason="keep the bulk out of context"), )
    assert mgr.hide_reasons_of("default") == default.hide_reasons
    # An id this manager does not know reads the default profile's
    # table, the same fallback commands_of makes.
    assert mgr.hide_reasons_of("stranger") == ()


@pytest.mark.asyncio
async def test_manager_default_adopts_stored_script():
    # The profile script is a durable restriction like the hidden
    # shapes: a store written by a scripted deployment must not wake a
    # daemon configured without a default profile unjudged, and the
    # next flush must not erase the script from the record.
    store = RAMSessionStore()
    await store.set(
        "default", {
            "session_id": "default",
            "cwd": "/w",
            "env": {},
            "script": {
                "profile": "judge",
                "language": "python",
                "source": "None",
                "runtime": "monty",
            },
        })
    mgr = SessionManager("default", store=store)
    await mgr.ensure_loaded()
    expected = ProfileScript(profile="judge",
                             script=ScriptSource("None", language="python"),
                             runtime="monty")
    assert mgr.get("default").script == expected
    assert mgr.script_of("default") == expected


def test_manager_default_profile_shapes_the_default_session():
    mgr = SessionManager("default")
    mgr.default_profile = CompiledProfile(
        mount_modes={"/s3": MountMode.READ},
        hidden_paths=HiddenPaths(paths=("/s3/secrets", )),
        hidden_vars=HiddenVars(names=("SLACK_TOKEN", )),
        env={"PAGER": "cat"},
        cwd="/s3")
    default = mgr.get("default")
    assert default.mount_modes == {"/s3": MountMode.READ}
    assert default.hidden_paths == HiddenPaths(paths=("/s3/secrets", ))
    assert default.hidden_vars == HiddenVars(names=("SLACK_TOKEN", ))
    assert default.env["PAGER"] == "cat"
    assert default.cwd == "/s3"
    # None is "no default profile", not "clear the session".
    mgr.default_profile = None
    assert default.mount_modes == {"/s3": MountMode.READ}


@pytest.mark.asyncio
async def test_manager_default_profile_outranks_a_stale_record():
    # A record written before the profile existed (or under an older
    # one) must not wake the primary agent unrestricted: the document
    # wins the narrowing fields after hydration, the record keeps the
    # scratch state (cwd, env), and the next flush rewrites the record.
    store = RAMSessionStore()
    await store.set(
        "default", {
            "session_id": "default",
            "cwd": "/w",
            "env": {
                "A": "1"
            },
            "mount_modes": {
                "/s3": "write",
                "/other": "write"
            },
        })
    mgr = SessionManager("default", store=store)
    mgr.default_profile = CompiledProfile(
        mount_modes={"/s3": MountMode.READ},
        hidden_paths=HiddenPaths(paths=("/s3/secrets", )),
        hidden_vars=None,
        env=None,
        cwd="/s3")
    await mgr.ensure_loaded()
    default = mgr.get("default")
    assert default.cwd == "/w"
    assert default.env["A"] == "1"
    assert default.mount_modes == {"/s3": MountMode.READ}
    assert default.hidden_paths == HiddenPaths(paths=("/s3/secrets", ))
    await mgr.flush()
    stored = (await store.load())["default"]
    assert stored["mount_modes"] == {"/s3": "read"}
    assert stored["hidden_paths"] == {"paths": ["/s3/secrets"], "patterns": []}


@pytest.mark.asyncio
async def test_manager_flush_writes_through():
    store = RAMSessionStore()
    mgr = SessionManager("default", store=store)
    mgr.create("agent", mount_modes={"/s3": MountMode.READ})
    mgr.cwd = "/moved"
    await mgr.flush()
    entries = await store.load()
    assert entries["default"]["cwd"] == "/moved"
    assert entries["agent"]["mount_modes"] == {"/s3": "read"}


@pytest.mark.asyncio
async def test_manager_close_deletes_from_store():
    store = RAMSessionStore()
    mgr = SessionManager("default", store=store)
    mgr.create("gone")
    await mgr.flush()
    await mgr.close("gone")
    assert "gone" not in await store.load()


@pytest.mark.asyncio
async def test_sessions_persist_across_workspaces_on_shared_store():
    store = RAMSessionStore()
    ram = RAMResource()
    ws_a = Workspace({"/data": ram}, mode=MountMode.EXEC, session_store=store)
    ws_a.create_session("narrow", mounts={"/data": "read"})
    await ws_a.flush_sessions()

    ws_b = Workspace({"/data": ram}, mode=MountMode.EXEC, session_store=store)
    result = await ws_b.execute("echo blocked > /data/x.txt",
                                session_id="narrow")
    assert result.exit_code != 0


class CountingStore(RAMSessionStore):

    def __init__(self) -> None:
        super().__init__()
        self.cas_calls = 0

    async def cas_set(self, session_id, fields, expected_generation):
        self.cas_calls += 1
        return await super().cas_set(session_id, fields, expected_generation)


def test_flush_skips_clean_sessions():
    store = CountingStore()
    mgr = SessionManager("default", store=store)
    _run(mgr.flush())
    assert store.cas_calls == 1
    _run(mgr.flush())
    assert store.cas_calls == 1
    seed_var(mgr.get("default"), "K", "v")
    _run(mgr.flush())
    assert store.cas_calls == 2


def test_flush_bumps_generation():
    store = RAMSessionStore()
    mgr = SessionManager("default", store=store)
    _run(mgr.flush())
    assert mgr.get("default").generation == 1
    mgr.get("default").cwd = "/data"
    _run(mgr.flush())
    assert mgr.get("default").generation == 2
    entries = _run(store.load())
    assert entries["default"]["generation"] == 2


def test_flush_conflict_adopts_stored_generation_and_retries():
    store = RAMSessionStore()
    mgr = SessionManager("default", store=store)
    # Another writer already advanced the record to generation 5.
    _run(
        store.set(
            "default", {
                "session_id": "default",
                "cwd": "/theirs",
                "env": {},
                "generation": 5,
            }))
    mgr.get("default").cwd = "/ours"
    _run(mgr.flush())
    entries = _run(store.load())
    assert entries["default"]["cwd"] == "/ours"
    assert entries["default"]["generation"] == 6
    assert mgr.get("default").generation == 6


def test_flush_exhausted_retries_raise():

    class AlwaysConflict(RAMSessionStore):

        async def cas_set(self, session_id, fields, expected_generation):
            return False

    mgr = SessionManager("default", store=AlwaysConflict())
    mgr.get("default").cwd = "/data"
    with pytest.raises(RuntimeError, match="conflict"):
        _run(mgr.flush())


def test_hydrated_sessions_start_clean():
    store = CountingStore()
    seeded = {
        "session_id": "s2",
        "cwd": "/data",
        "env": {},
        "generation": 3,
    }
    _run(store.set("s2", seeded))
    mgr = SessionManager("default", store=store)
    _run(mgr.ensure_loaded())
    assert mgr.get("s2").generation == 3
    before = store.cas_calls
    _run(mgr.flush())
    # Only the locally created default session is dirty; the hydrated
    # one is clean until mutated.
    assert store.cas_calls == before + 1
    seed_var(mgr.get("s2"), "K", "v")
    _run(mgr.flush())
    entries = _run(store.load())
    assert entries["s2"]["generation"] == 4


def test_commands_of_answers_the_sessions_own_rules():
    mgr = SessionManager("default")
    early = mgr.create("early")
    own = AdmissionRules(allow=("ls", ))
    late = mgr.create("late")
    late.commands = own
    assert mgr.commands_of("late") is own
    # A session the profile never narrowed states no rules, and so does an
    # id the manager does not know (the empty id of an unbound door
    # included), unless a default profile says otherwise.
    assert mgr.commands_of("early") is None
    assert mgr.commands_of("nobody") is None
    assert mgr.commands_of("") is None
    assert early.commands is None
    # With a default profile compiled in, an unknown id answers its rules
    # rather than nothing, so an unbound door still fails toward refusal.
    mgr.default_profile = CompiledProfile(
        mount_modes=None,
        hidden_paths=None,
        hidden_vars=None,
        env=None,
        cwd=None,
        commands=AdmissionRules(allow=("cat", )))
    assert mgr.commands_of("nobody") == AdmissionRules(allow=("cat", ))
    assert mgr.commands_of("") == AdmissionRules(allow=("cat", ))


@pytest.mark.asyncio
async def test_manager_admission_rules_ride_the_session_record():
    store = RAMSessionStore()
    own = AdmissionRules(allow=("ls", "git log"),
                         deny=(CommandRule(reason="no", commands=("rm", )), ))
    await store.set(
        "restored", {
            "session_id": "restored",
            "cwd": "/w",
            "env": {},
            "created_at": 1.0,
            "commands": {
                "allow": ["ls", "git log"],
                "ask": [],
                "deny": [{
                    "reason": "no",
                    "commands": ["rm"],
                    "paths": []
                }],
            },
        })
    await store.set(
        "default", {
            "session_id": "default",
            "cwd": "/w",
            "env": {},
            "created_at": 1.0,
            "commands": {
                "allow": ["cat"],
                "ask": [],
                "deny": []
            },
        })
    mgr = SessionManager("default", store=store)
    await mgr.ensure_loaded()
    restored = mgr.get("restored")
    assert restored.commands == own
    assert mgr.commands_of("restored") is restored.commands
    # The default session adopts its stored rules like its hidden paths.
    assert mgr.get("default").commands == AdmissionRules(allow=("cat", ))
    await mgr.flush()
    stored = await store.load()
    assert stored["restored"]["commands"]["allow"] == ["ls", "git log"]
    assert stored["restored"]["commands"]["deny"][0]["reason"] == "no"


@pytest.mark.asyncio
async def test_manager_decisions_live_on_the_registered_session_and_persist():
    store = RAMSessionStore()
    mgr = SessionManager("default", store=store)
    await mgr.ensure_loaded()
    live = mgr.create("agent")
    assert mgr.decisions_of("agent") == ()
    rule = CommandRule(reason="sign-off", commands=("git push", ))
    grant = Decision(id="d1",
                     session_id="agent",
                     agent_id="",
                     command="git",
                     argv=("push", ),
                     cwd="/repo",
                     paths=(),
                     reason="r",
                     rule=rule,
                     outcome=Outcome.ALLOW,
                     scope=Scope.SESSION)
    # Written by id onto the registered session, so a fork made before
    # or after reads the same answers through the manager, whatever
    # its own copy holds; durable at the next flush.
    fork = live.fork()
    mgr.set_decisions("agent", (grant, ))
    assert live.decisions == (grant, )
    assert fork.decisions == ()
    assert mgr.decisions_of(fork.session_id) == (grant, )
    await mgr.flush()
    stored = (await store.load())["agent"]
    assert stored["decisions"][0]["scope"] == "session"
    # A manager reading that record back holds the grant.
    again = SessionManager("default", store=store)
    await again.ensure_loaded()
    assert again.decisions_of("agent") == (grant, )
    with pytest.raises(KeyError):
        mgr.decisions_of("nobody")


@pytest.mark.asyncio
async def test_manager_default_session_hydrates_its_decisions():
    store = RAMSessionStore()
    mgr = SessionManager("default", store=store)
    await mgr.ensure_loaded()
    rule = CommandRule(reason="sign-off", commands=("git push", ))
    grant = Decision(id="d1",
                     session_id="agent",
                     agent_id="",
                     command="git",
                     argv=("push", ),
                     cwd="/repo",
                     paths=(),
                     reason="r",
                     rule=rule,
                     outcome=Outcome.ALLOW,
                     scope=Scope.SESSION)
    mgr.set_decisions("default", (grant, ))
    await mgr.flush()
    # The default session takes the stored durable fields on reopen;
    # the grants are among them, so an approved line does not ask
    # again after a restart and the next flush keeps the grant.
    again = SessionManager("default", store=store)
    await again.ensure_loaded()
    assert again.decisions_of("default") == (grant, )
    await again.flush()
    assert (await
            store.load())["default"]["decisions"][0]["scope"] == ("session")


def test_restore_seed_templates_later_sessions():
    mgr = SessionManager("default")
    assert not mgr.has_managed_env
    seed = vars_from_entries({
        "TOKEN": {
            "from": "aws-sm",
            "ref": "prod"
        },
        "MODE": "x",
    })
    mgr.restore_seed(seed)
    assert mgr.has_managed_env
    created = mgr.create("later")
    assert created.vars["MODE"].value == "x"
    assert created.vars["TOKEN"].managed is not None
    assert mgr.seed_vars == seed


def test_hydration_merges_env_entries_the_record_predates():
    """A pointer added to the env block after a record was written must
    reach the hydrated session; the record's own entries win per name."""
    store = RAMSessionStore()

    async def scenario():
        old = SessionManager("default", store=store)
        old.get("default").vars["KEPT"] = ShellVar(value="stored")
        old.create("agent")
        old.get("agent").vars["KEPT"] = ShellVar(value="agent")
        await old.ensure_loaded()
        await old.flush()
        seeds = vars_from_entries({
            "TOKEN": {
                "from": "aws-sm",
                "ref": "prod"
            },
            "KEPT": "seeded",
        })
        fresh = SessionManager("default", store=store, seed_vars=dict(seeds))
        await fresh.ensure_loaded()
        return fresh

    fresh = _run(scenario())
    assert fresh.get("default").vars["TOKEN"].managed is not None
    assert fresh.get("default").vars["KEPT"].value == "stored"
    assert fresh.get("agent").vars["TOKEN"].managed is not None
    assert fresh.get("agent").vars["KEPT"].value == "agent"
    assert fresh.has_managed_env


def test_merged_seed_lands_durably_on_the_next_flush():
    """Stamped after the baseline, like narrow: the store's record gains
    the new entry rather than needing a re-merge every restart."""
    store = RAMSessionStore()

    async def scenario():
        old = SessionManager("default", store=store)
        await old.ensure_loaded()
        await old.flush()
        seeds = vars_from_entries({"TOKEN": {"from": "aws-sm", "ref": "p"}})
        fresh = SessionManager("default", store=store, seed_vars=dict(seeds))
        await fresh.ensure_loaded()
        await fresh.flush()
        return await store.load()

    entries = _run(scenario())
    assert entries["default"]["managed"]["TOKEN"]["ref"] == "p"


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", [False, True])
async def test_profile_changes_publish_only_after_persistence(
        monkeypatch, failure):
    store = RAMSessionStore()
    mgr = SessionManager("default", store=store)
    original = CompiledProfile(
        mount_modes={"/data": MountMode.READ},
        hidden_paths=HiddenPaths(paths=("/data/secret", )),
        hidden_vars=HiddenVars(names=("TOKEN", )),
        env=None,
        cwd=None,
        commands=AdmissionRules(allow=("cat", )),
        script=ProfileScript(profile="judge",
                             script=ScriptSource("None", language="python"),
                             runtime="monty"),
    )
    mgr.default_profile = original
    await mgr.flush()
    session = mgr.get("default")
    before = session.to_dict()
    persisted = await store.load()
    entered, release = asyncio.Event(), asyncio.Event()
    cas_set = store.cas_set

    async def delayed_write(*args):
        entered.set()
        await release.wait()
        if failure:
            raise RuntimeError("store unavailable")
        return await cas_set(*args)

    monkeypatch.setattr(store, "cas_set", delayed_write)
    cleared = CompiledProfile(mount_modes=None,
                              hidden_paths=None,
                              hidden_vars=None,
                              env=None,
                              cwd=None,
                              commands=None)
    updating = asyncio.create_task(mgr.set_profile("default", cleared))
    try:
        await asyncio.wait_for(entered.wait(), 5)
        assert session.to_dict() == before
        assert mgr.commands_of("") == original.commands
        assert mgr.script_of("") == original.script
        session.cwd = "/changed-during-write"
        release.set()
        if failure:
            with pytest.raises(RuntimeError, match="store unavailable"):
                await updating
            before["cwd"] = session.cwd
            assert session.to_dict() == before
            assert await store.load() == persisted
            assert mgr.commands_of("") == original.commands
            assert mgr.script_of("") == original.script
        else:
            assert await updating is session
            assert session.mount_modes is None
            assert session.hidden_paths is None
            assert mgr.commands_of("") is None
            assert mgr.script_of("") is None
        assert session.cwd == "/changed-during-write"
        monkeypatch.setattr(store, "cas_set", cas_set)
        await mgr.flush()
        assert (await store.load())["default"] == session.to_dict()
    finally:
        release.set()
        await asyncio.gather(updating, return_exceptions=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", [False, True])
async def test_session_close_waits_for_profile_persistence(
        monkeypatch, failure):
    store = RAMSessionStore()
    mgr = SessionManager("default", store=store)
    mgr.create("agent")
    entered, release = asyncio.Event(), asyncio.Event()
    cas_set = store.cas_set

    async def delayed_write(*args):
        entered.set()
        await release.wait()
        if failure:
            raise RuntimeError("store unavailable")
        return await cas_set(*args)

    monkeypatch.setattr(store, "cas_set", delayed_write)
    cleared = CompiledProfile(mount_modes=None,
                              hidden_paths=None,
                              hidden_vars=None,
                              env=None,
                              cwd=None,
                              commands=None)
    updating = asyncio.create_task(mgr.set_profile("agent", cleared))
    closing = None
    try:
        await asyncio.wait_for(entered.wait(), 5)
        closing = asyncio.create_task(mgr.close("agent"))
        await asyncio.sleep(0.02)
        assert not closing.done()
        release.set()
        await asyncio.gather(updating, return_exceptions=True)
        await closing
        with pytest.raises(KeyError):
            mgr.get("agent")
        assert "agent" not in await store.load()
    finally:
        release.set()
        await asyncio.gather(updating, return_exceptions=True)
        if closing is not None:
            await closing
