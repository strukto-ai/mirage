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
import dataclasses
import re

import pytest
from pydantic import ValidationError

from mirage.agents.io_text import with_refusal
from mirage.commands.cli.specs import cli_spec_for
from mirage.context import reset_current_session, set_current_session
from mirage.policy import Action, Ask, CommandContext, Decision, Policy, Scope
from mirage.policy.constants import DEFAULT_ASK_REASON, DEFAULT_DENY_REASON
from mirage.policy.errors import PolicyError
from mirage.policy.match import Outcome
from mirage.policy.profile import SessionProfile
from mirage.policy.types import CommandRule, HideReason
from mirage.resource.ram import RAMResource
from mirage.runtime.base import Runtime
from mirage.runtime.mixin import LineExecutorMixin
from mirage.runtime.types import RunResult, ScriptSource
from mirage.types import HiddenPaths, HiddenVars, MountMode, ShowEntry
from mirage.workspace import Workspace
from mirage.workspace.abort import MirageAbortError
from mirage.workspace.session.state import seed_var

from mirage.policy.profile import (  # isort: skip
    CommandsBlock, MountCommandsBlock, PathsBlock, ProfileMount, VarsBlock)


def test_profile_from_dict_regroups_paths_and_vars():
    p = SessionProfile.model_validate({
        "cwd": "/scratch",
        "env": {
            "PAGER": "cat"
        },
        "mounts": {
            "/repo": "r",
            "scratch/": "rwx"
        },
        "paths": {
            "hide": ["/repo/.env", "*.pem"]
        },
        "vars": {
            "hide": ["AWS_*"]
        },
    })
    assert p.cwd == "/scratch"
    assert p.env == {"PAGER": "cat"}
    # A bare mode is sugar for the section that carries only a mode.
    assert p.mounts == {
        "/repo": ProfileMount(mode=MountMode.READ),
        "/scratch": ProfileMount(mode=MountMode.EXEC),
    }
    assert p.paths == PathsBlock(hide=("/repo/.env", "*.pem"))
    assert p.vars == VarsBlock(hide=("AWS_*", ))


def test_profile_unsaid_fields_are_none_so_a_reader_can_tell():
    p = SessionProfile()
    assert (p.cwd, p.env, p.mounts, p.paths, p.vars,
            p.commands) == (None, ) * 6


def test_a_mount_section_carries_a_mode_rules_and_hides():
    p = SessionProfile.model_validate({
        "mounts": {
            "/repo": {
                "mode": "rw",
                "commands": {
                    "deny": ["git push"],
                    "ask": ["git rebase"]
                },
                "paths": {
                    "hide": ["/repo/.env"]
                },
            }
        }
    })
    entry = p.mounts["/repo"]
    assert entry.mode is MountMode.WRITE
    assert entry.commands.deny[0].commands == ("git push", )
    assert entry.commands.ask[0].commands == ("git rebase", )
    assert entry.paths == PathsBlock(hide=("/repo/.env", ))
    # What a session can see is the session's property, not an
    # operand's, so a mount section has no allow list.
    with pytest.raises(ValidationError):
        SessionProfile.model_validate(
            {"mounts": {
                "/repo": {
                    "commands": {
                        "allow": ["ls"]
                    }
                }
            }})


def test_profile_mounts_refuses_a_bare_list():
    # A list used to mean "only these mounts are reachable"; a mount a
    # profile does not name now keeps its own mode, so the list would
    # quietly drop the confinement it used to carry.
    with pytest.raises(ValidationError,
                       match=re.escape(
                           "mounts must be a mapping of prefix to its "
                           "settings")):
        SessionProfile.model_validate({"mounts": ["/repo"]})


@pytest.mark.parametrize("mounts,message", [
    ({
        7: "read"
    }, "mounts keys must be strings"),
    ("/repo", "mounts must be a mapping of prefix to its settings"),
    (7, "mounts must be a mapping of prefix to its settings"),
    ({"/repo"}, "mounts must be a mapping of prefix to its settings"),
    ({
        "/repo": "nope"
    }, "'nope' is not a valid MountMode"),
    ({
        "/repo": {
            "mode": 7
        }
    }, "mount mode must be a mode name or alias"),
])
def test_profile_mounts_rejects_what_typescript_rejects(mounts, message):
    # The message is asserted, not just the type: a mode that is not a
    # string used to reach parse_mount_mode and come back as a bare
    # TypeError (unhashable dict/list key), which is not the ValueError
    # the loader's contract promises.
    with pytest.raises(ValidationError, match=re.escape(message)):
        SessionProfile.model_validate({"mounts": mounts})


def test_profile_rejects_unknown_and_unshipped_fields():
    for bad in ({
            "extends": "default"
    }, {
            "hidden_paths": {}
    }, {
            "hidden_vars": {}
    }, {
            "commands": {
                "hide": []
            }
    }, {
            "paths": {
                "carve": {}
            }
    }, {
            "vars": {
                "mask": []
            }
    }, {
            "mounts": {
                "/repo": {
                    "permissions": {}
                }
            }
    }):
        with pytest.raises(ValidationError):
            SessionProfile.model_validate(bad)


def test_profile_commands_block_takes_allow_ask_and_deny():
    p = SessionProfile.model_validate({
        "commands": {
            "allow": ["ls", "git log"],
            "ask": [
                "git push", {
                    "reason": "sign-off",
                    "commands": {
                        "rm": ["/shared/*"]
                    }
                }
            ],
            "deny": [{
                "reason": "no",
                "commands": {
                    "rm": ["/repo/*"]
                }
            }],
        }
    })
    assert p.commands is not None
    assert p.commands.allow == ("ls", "git log")
    # A bare ask entry carries ask's default reason, not deny's.
    assert p.commands.ask[0] == CommandRule(reason=DEFAULT_ASK_REASON,
                                            commands=("git push", ))
    assert p.commands.ask[1] == CommandRule(reason="sign-off",
                                            commands=("rm", ),
                                            paths=("/shared/*", ))
    assert p.commands.deny[0].reason == "no"
    # Unstated allow is None (everything installed), not an empty list.
    assert SessionProfile.model_validate({
        "commands": {
            "deny": ["rm"]
        }
    }).commands.allow is None


@pytest.mark.parametrize("bad", [
    {
        "allow": "ls"
    },
    {
        "allow": ["ls", ""]
    },
    {
        "allow": ["ls", "  "]
    },
    {
        "ask": "git push"
    },
    {
        "ask": [""]
    },
    {
        "deny": [{
            "reason": "x",
            "commands": [""]
        }]
    },
    {
        "ask": [{
            "reason": "x",
            "mount": "/repo"
        }]
    },
])
def test_commands_block_refuses_scalars_blank_patterns_and_mount(bad):
    # A blank pattern is a prefix of every line, so it would allow, ask
    # about or deny every command; `mount` is the compiler's field.
    with pytest.raises(ValidationError):
        SessionProfile.model_validate({"commands": bad})


def test_profile_is_frozen():
    p = SessionProfile(cwd="/x")
    with pytest.raises(ValidationError):
        p.cwd = "/y"  # type: ignore[misc]


def test_commands_deny_accepts_rules_and_bare_names():
    p = SessionProfile.model_validate({
        "commands": {
            "deny": [{
                "reason": "no deletes",
                "commands": {
                    "rm": ["/repo/*"]
                }
            }, "python3", {
                "commands": ["shred"]
            }]
        },
        "paths": {
            "hide": ["/shared/finance"]
        },
    })
    assert p.commands == CommandsBlock(deny=(
        CommandRule(
            reason="no deletes", commands=("rm", ), paths=("/repo/*", )),
        CommandRule(reason=DEFAULT_DENY_REASON, commands=("python3", )),
        CommandRule(reason=DEFAULT_DENY_REASON, commands=("shred", )),
    ))
    assert p.paths == PathsBlock(hide=("/shared/finance", ))


@pytest.mark.parametrize("deny", ["rm", {"rm": "no"}, 7])
def test_commands_deny_is_a_list_not_a_scalar(deny):
    with pytest.raises(ValidationError,
                       match=re.escape("commands.deny must be a list")):
        SessionProfile.model_validate({"commands": {"deny": deny}})


@pytest.mark.parametrize("rule", [
    {
        "commands": "rm"
    },
    {
        "reason": "no",
        "paths": "/repo/secret"
    },
    {
        "commands": ["rm", 3]
    },
    {
        "reason": 7,
        "commands": ["rm"]
    },
])
def test_deny_rule_refuses_scalar_lists_and_non_string_reasons(rule):
    # `commands: rm` would tuple() into ('r', 'm') and leave rm allowed;
    # the document fails to load instead, as it does in TypeScript.
    with pytest.raises(ValidationError):
        SessionProfile.model_validate({"commands": {"deny": [rule]}})


def test_a_rule_maps_each_command_to_its_own_paths():
    # One command to many paths, never a list of commands beside a list
    # of paths: the document says which command each path belongs to,
    # and compiles one rule per command.
    p = SessionProfile.model_validate({
        "commands": {
            "deny": [{
                "reason": "prod is protected",
                "commands": {
                    "rm": ["/repo/prod/*", "/shared/*"],
                    "mv": ["/repo/prod/*"]
                }
            }],
            "ask": [{
                "commands": {
                    "git push": ["/repo/*"]
                }
            }],
        }
    })
    assert p.commands.deny == (
        CommandRule(reason="prod is protected",
                    commands=("rm", ),
                    paths=("/repo/prod/*", "/shared/*")),
        CommandRule(reason="prod is protected",
                    commands=("mv", ),
                    paths=("/repo/prod/*", )),
    )
    assert p.commands.ask == (CommandRule(reason=DEFAULT_ASK_REASON,
                                          commands=("git push", ),
                                          paths=("/repo/*", )), )


@pytest.mark.parametrize("bad,message", [
    ({
        "reason": "x",
        "commands": ["rm", "mv"],
        "paths": ["/a"]
    }, "map each command to its paths"),
    ({
        "reason": "x",
        "commands": {
            "rm": ["/a"]
        },
        "paths": ["/b"]
    }, "takes no paths of its own"),
    ({
        "reason": "x"
    }, "names no command and no path"),
    ({
        "reason": "x",
        "commands": {}
    }, "must name at least one command"),
    ({
        "reason": "x",
        "commands": {
            "rm": []
        }
    }, "must list at least one path"),
    ({
        "reason": "x",
        "commands": {
            "rm": "/a"
        }
    }, "must be a list of strings"),
    ({
        "reason": "x",
        "commands": {
            " ": ["/a"]
        }
    }, "keys must name a command"),
    ({
        "reason": "x",
        "commands": {
            "rm": ["/a", " "]
        }
    }, "commands[rm][1] must name a path"),
    ({
        "reason": "x",
        "paths": [""]
    }, "paths[0] must name a path"),
    (7, "must be a command pattern or a mapping"),
])
def test_a_rule_that_does_not_say_whose_path_it_is_is_refused(bad, message):
    for doc in (SessionProfile, MountCommandsBlock):
        payload = ({
            "commands": {
                "deny": [bad]
            }
        } if doc is SessionProfile else {
            "deny": [bad]
        })
        with pytest.raises(ValidationError, match=re.escape(message)):
            doc.model_validate(payload)


@pytest.mark.parametrize("entry", ["xxx", "secrets/*", "./x", "~/x", "a/b"])
def test_a_relative_path_is_refused_everywhere(entry):
    # Every path in the document is a virtual path: `xxx` would silently
    # read as `/xxx` and `secrets/*` as `/secrets/*`. A name pattern (no
    # slash) is the one relative spelling with a meaning, and it means
    # the same thing inside a mount section as outside one.
    with pytest.raises(ValidationError, match="is relative"):
        SessionProfile.model_validate({"paths": {"hide": [entry]}})
    with pytest.raises(ValidationError, match="is relative"):
        SessionProfile.model_validate(
            {"commands": {
                "ask": [{
                    "commands": {
                        "rm": ["/ok", entry]
                    }
                }]
            }})
    with pytest.raises(ValidationError, match="is relative"):
        SessionProfile.model_validate(
            {"commands": {
                "deny": [{
                    "paths": [entry]
                }]
            }})
    with pytest.raises(ValidationError, match="is relative"):
        SessionProfile.model_validate(
            {"mounts": {
                "/repo": {
                    "paths": {
                        "hide": [entry]
                    }
                }
            }})
    SessionProfile.model_validate({"paths": {"hide": ["/" + entry, "*.pem"]}})


@pytest.mark.parametrize("entry", ["/other/x", "/repository/x", "/"])
def test_a_mount_sections_paths_must_lie_under_that_mount(entry):
    # The section is about that mount, so a path written under it names
    # something inside it. This is what a rebase used to do by joining,
    # which turned `/repo/secret` under `/repo` into `/repo/repo/secret`
    # and protected nothing.
    for block in ({
            "paths": {
                "hide": [entry]
            }
    }, {
            "commands": {
                "deny": [{
                    "paths": [entry]
                }]
            }
    }):
        with pytest.raises(ValidationError, match="outside the mount"):
            SessionProfile.model_validate({"mounts": {"/repo": block}})
    # The root itself, anything under it, and a name pattern all pass.
    ok = SessionProfile.model_validate({
        "mounts": {
            "/repo": {
                "paths": {
                    "hide": ["/repo", "/repo/a", "*.pem"]
                }
            }
        }
    })
    assert ok.mounts["/repo"].paths.hide == ("/repo", "/repo/a", "*.pem")


def test_the_root_mounts_section_holds_every_path_under_it():
    # A workspace mounted at `/` has one section to write, and `root +
    # "/"` is `"//"` there, which no path starts with, so the boundary
    # check used to leave it able to name nothing but `/` itself.
    profile = SessionProfile.model_validate({
        "mounts": {
            "/": {
                "paths": {
                    "hide": ["/secret", "*.pem"]
                },
                "commands": {
                    "deny": [{
                        "reason": "sealed",
                        "paths": ["/secret/*"]
                    }],
                },
            }
        }
    })
    assert profile.mounts["/"].paths.hide == ("/secret", "*.pem")
    assert profile.mounts["/"].commands.deny[0].paths == ("/secret/*", )


def test_a_blank_hide_entry_is_refused():
    # "" is the root under the subtree rule: it would hide the whole tree.
    with pytest.raises(ValidationError, match="hide\\[1\\] must name a path"):
        SessionProfile.model_validate({"paths": {"hide": ["/a", ""]}})
    with pytest.raises(ValidationError, match="hide\\[1\\] must name a path"):
        SessionProfile.model_validate(
            {"mounts": {
                "/a": {
                    "paths": {
                        "hide": ["/a/x", ""]
                    }
                }
            }})


def test_paths_show_takes_a_mapping_or_a_plain_list():
    # A mapping states path -> mode; a plain list inherits the mount's
    # mode, which the entry records as None until the mode law asks.
    p = SessionProfile.model_validate({
        "paths": {
            "hide": ["/repo"],
            "show": {
                "/repo/public": "r",
                "/repo/build": "rw"
            },
        }
    })
    assert p.paths.show == (ShowEntry(path="/repo/public",
                                      mode=MountMode.READ),
                            ShowEntry(path="/repo/build",
                                      mode=MountMode.WRITE))
    bare = SessionProfile.model_validate(
        {"paths": {
            "show": ["/repo/public", "/repo/docs/*"]
        }})
    assert bare.paths.show == (ShowEntry(path="/repo/public", mode=None),
                               ShowEntry(path="/repo/docs/*", mode=None))


@pytest.mark.parametrize("entry", ["public", "*.md", "docs/site", ""])
def test_a_show_entry_is_absolute_or_refused(entry):
    # A show anchors to a place and a name pattern names none, so the
    # slashless spelling hide accepts is refused here.
    with pytest.raises(ValidationError,
                       match="anchor to a place|must name a path"):
        SessionProfile.model_validate({"paths": {"show": [entry]}})


def test_a_show_mode_must_be_a_mode_name_or_alias():
    with pytest.raises(ValidationError, match="mode name or alias"):
        SessionProfile.model_validate({"paths": {"show": {"/repo/public": 7}}})
    with pytest.raises(ValidationError, match="not a valid MountMode"):
        SessionProfile.model_validate(
            {"paths": {
                "show": {
                    "/repo/public": "admin"
                }
            }})


def test_a_hide_group_carries_its_reason_into_the_side_table():
    # The group is a spelling of `hide`: its patterns join the flat list
    # (so matching never consults the reason) and the reason lands in
    # `reasons`, which no agent-facing surface renders.
    p = SessionProfile.model_validate({
        "paths": {
            "hide": [
                "/repo/.env",
                {
                    "patterns": ["/repo/secrets", "*.pem"],
                    "reason": "credentials",
                },
            ]
        }
    })
    assert p.paths.hide == ("/repo/.env", "/repo/secrets", "*.pem")
    assert p.paths.reasons == (HideReason(patterns=("/repo/secrets", "*.pem"),
                                          reason="credentials"), )
    again = SessionProfile.model_validate(p.model_dump(exclude_none=True))
    assert again.paths.hide == p.paths.hide
    assert again.paths.reasons == p.paths.reasons


@pytest.mark.parametrize("group, message", [
    ({
        "patterns": [],
        "reason": "x"
    }, "at least one pattern"),
    ({
        "patterns": ["/a"],
        "reason": "  "
    }, "non-empty string"),
    ({
        "patterns": ["/a"]
    }, "non-empty string"),
    ({
        "patterns": ["/a"],
        "reason": "x",
        "why": "no"
    }, "unknown field"),
])
def test_a_malformed_hide_group_is_refused(group, message):
    with pytest.raises(ValidationError, match=message):
        SessionProfile.model_validate({"paths": {"hide": [group]}})


def test_a_mount_sections_show_must_lie_under_that_mount():
    with pytest.raises(ValidationError, match="outside the mount"):
        SessionProfile.model_validate(
            {"mounts": {
                "/repo": {
                    "paths": {
                        "show": {
                            "/other/x": "r"
                        }
                    }
                }
            }})
    ok = SessionProfile.model_validate({
        "mounts": {
            "/repo": {
                "paths": {
                    "hide": ["/repo"],
                    "show": ["/repo/public"]
                }
            }
        }
    })
    assert ok.mounts["/repo"].paths.show == (ShowEntry(path="/repo/public",
                                                       mode=None), )


def _ws() -> Workspace:
    a = RAMResource()
    a._store.files["/x.txt"] = b"public\n"
    a._store.files["/secrets/token.txt"] = b"s3cr3t\n"
    a._store.dirs.add("/secrets")
    b = RAMResource()
    b._store.files["/y.txt"] = b"other\n"
    return Workspace({
        "/a": (a, MountMode.WRITE),
        "/b": (b, MountMode.WRITE)
    },
                     mode=MountMode.WRITE)


ANALYST = SessionProfile(mounts={"/a": "write"},
                         paths=PathsBlock(hide=("/a/secrets", )),
                         vars=VarsBlock(hide=("SLACK_TOKEN", )),
                         env={"ROLE": "analyst"})


def test_profile_applies_every_narrowing_field():
    ws = _ws()
    sess = ws.create_session("agent", profile=ANALYST)
    assert sess.mount_modes is not None
    assert sess.mount_modes["/a"] == MountMode.WRITE
    # A mount the profile never names is absent from the map and keeps the
    # mode the workspace gave it; naming one mount is not an allowlist.
    assert "/b" not in sess.mount_modes
    assert sess.hidden_paths == HiddenPaths(paths=("/a/secrets", ))
    assert sess.hidden_vars == HiddenVars(names=("SLACK_TOKEN", ))
    assert sess.env["ROLE"] == "analyst"


def test_one_profile_serves_many_sessions():
    # A profile is a profile, not a session: frozen, so two agents share
    # one object and neither can bend the other's view.
    ws = _ws()
    s1 = ws.create_session("agent1", profile=ANALYST)
    s2 = ws.create_session("agent2", profile=ANALYST)
    assert s1.hidden_paths == s2.hidden_paths
    seed_var(s1, "ROLE", "changed")
    assert s2.env["ROLE"] == "analyst"


def test_explicit_mounts_can_only_weaken_a_mode_never_raise_it():
    # An inline document restricts: a mode both sides state settles at
    # the weaker one, and a mount only the inline document names is
    # narrowed from whatever the workspace gave it, never raised.
    ws = _ws()
    sess = ws.create_session("agent",
                             mounts={
                                 "/a": "read",
                                 "/b": "read"
                             },
                             profile=ANALYST)
    assert sess.mount_modes == {"/a": MountMode.READ, "/b": MountMode.READ}
    assert sess.hidden_paths == HiddenPaths(paths=("/a/secrets", ))
    raised = ws.create_session("wider", mounts={"/a": "rwx"}, profile=ANALYST)
    assert raised.mount_modes["/a"] == MountMode.WRITE


def test_profiled_session_is_narrowed_end_to_end():
    ws = _ws()
    ws.create_session("agent", profile=ANALYST)

    async def run():
        listing = await ws.execute("ls /a", session_id="agent")
        denied = await ws.execute("cat /a/secrets/token.txt",
                                  session_id="agent")
        profile = await ws.execute('echo "$ROLE"', session_id="agent")
        return (await listing.stdout_str(), denied, await profile.stdout_str())

    listing_out, denied, role_out = asyncio.run(run())
    assert "x.txt" in listing_out
    assert "secrets" not in listing_out
    assert denied.exit_code != 0
    assert role_out == "analyst\n"


def test_profile_env_reaches_the_process_view():
    # A profile's env is a process environment, so every name in it is
    # exported. Seeded plain, `$ROLE` expanded while `env`, an installed
    # CLI and a guest runtime all saw nothing, because all three read
    # `env_snapshot` and that is the exported set.
    ws = _ws()
    ws.create_session("agent", profile=ANALYST)

    async def run():
        listed = await ws.execute("env", session_id="agent")
        return await listed.stdout_str()

    assert "ROLE=analyst\n" in asyncio.run(run())


# Two profiles, each the whole document it runs under: there is no
# inheritance, so reading one is reading everything it may do.
PROFILES = {
    "default":
    SessionProfile(cwd="/b",
                   env={"PAGER": "cat"},
                   mounts={
                       "/a": "rw",
                       "/b": "rwx"
                   }),
    "reviewer":
    SessionProfile(cwd="/b",
                   env={"PAGER": "cat"},
                   mounts={
                       "/a": "r",
                       "/b": "rwx"
                   },
                   paths=PathsBlock(hide=("/a/secrets", ))),
}


def _profiled_ws() -> Workspace:
    a = RAMResource()
    a._store.files["/x.txt"] = b"public\n"
    a._store.files["/secrets/token.txt"] = b"s3cr3t\n"
    a._store.dirs.add("/secrets")
    return Workspace(
        {
            "/a": (a, MountMode.WRITE),
            "/b": (RAMResource(), MountMode.WRITE)
        },
        mode=MountMode.WRITE,
        profiles=PROFILES,
    )


def test_create_session_by_profile_name_reads_that_whole_document():
    ws = _profiled_ws()
    sess = ws.create_session("agent", profile="reviewer")
    assert sess.mount_modes is not None
    assert sess.mount_modes["/a"] == MountMode.READ
    assert sess.hidden_paths == HiddenPaths(paths=("/a/secrets", ))
    assert sess.cwd == "/b"
    assert sess.env["PAGER"] == "cat"


def test_create_session_without_a_profile_takes_the_default_one():
    ws = _profiled_ws()
    sess = ws.create_session("agent")
    assert sess.mount_modes is not None
    assert sess.mount_modes["/a"] == MountMode.WRITE
    assert sess.hidden_paths is None
    assert sess.cwd == "/b"
    # A workspace with no default profile leaves the session unrestricted.
    plain = _ws().create_session("free")
    assert plain.mount_modes is None and plain.cwd == "/"


def test_default_profile_shapes_the_workspace_session_too():
    # The workspace's own session is a session created without a name,
    # so `profiles.default` reaches it: the primary agent starts in the
    # profile's cwd, sees its exported env and its per-mount modes, and
    # cannot see what it hides. A workspace with no default profile leaves
    # that session as it always was.
    ws = Workspace(
        {
            "/a": (RAMResource(), MountMode.WRITE),
            "/b": (RAMResource(), MountMode.WRITE)
        },
        mode=MountMode.WRITE,
        profiles={
            "default":
            SessionProfile(cwd="/b",
                           env={"PAGER": "cat"},
                           mounts={"/b": "rwx"},
                           paths=PathsBlock(hide=("/b/vault", ))),
        },
    )
    default = ws.get_session(ws.default_session_id)
    assert default.mount_modes is not None
    assert default.mount_modes["/b"] == MountMode.EXEC
    assert "/a" not in default.mount_modes
    assert default.hidden_paths == HiddenPaths(paths=("/b/vault", ))
    assert default.cwd == "/b"

    async def run():
        pwd = await ws.execute("pwd")
        pager = await ws.execute('echo "$PAGER"')
        other = await ws.execute("ls /a")
        vault = await ws.execute("mkdir /b/vault")
        return (await pwd.stdout_str(), await
                pager.stdout_str(), other.exit_code, vault.exit_code)

    pwd_out, pager_out, other_exit, vault_exit = asyncio.run(run())
    assert pwd_out == "/b\n"
    assert pager_out == "cat\n"
    # A mount the profile does not name is reachable at its own mode: the
    # `mounts` mapping narrows, it is not an allowlist.
    assert other_exit == 0
    assert vault_exit != 0
    plain_ws = _ws()
    plain = plain_ws.get_session(plain_ws.default_session_id)
    assert plain.mount_modes is None and plain.hidden_paths is None


def test_a_role_keeps_a_mount_away_by_hiding_it_not_by_omitting_it():
    # Omission is not a refusal, so exclusion is a hide: the mount reads
    # as nonexistent rather than as a permission error naming something
    # the profile cannot see.
    ws = Workspace(
        {
            "/a": (RAMResource(), MountMode.WRITE),
            "/b": (RAMResource(), MountMode.WRITE)
        },
        mode=MountMode.WRITE,
        profiles={
            "default":
            SessionProfile(mounts={"/b": "rwx"},
                           paths=PathsBlock(hide=("/a", ))),
        },
    )

    async def run():
        listed = await ws.execute("ls /a")
        root = await ws.execute("ls /")
        return (listed.exit_code, await listed.stderr_str(), await
                root.stdout_str())

    code, err, root_out = asyncio.run(run())
    assert code != 0 and "No such file or directory" in err
    assert "b" in root_out and "a\n" not in root_out


def test_create_session_rejects_an_unknown_profile_name():
    ws = _profiled_ws()
    with pytest.raises(PolicyError, match="unknown profile 'nope'"):
        ws.create_session("agent", profile="nope")


def test_workspace_names_a_default_role_by_name():
    # `profile=` on the workspace picks which profile shapes a session
    # created without one, including its own.
    ws = Workspace(
        {
            "/a": (RAMResource(), MountMode.WRITE),
            "/b": (RAMResource(), MountMode.WRITE)
        },
        mode=MountMode.WRITE,
        profiles=PROFILES,
        profile="reviewer",
    )
    assert ws.get_session(
        ws.default_session_id).mount_modes["/a"] == (MountMode.READ)
    assert ws.create_session("agent").mount_modes["/a"] == MountMode.READ
    with pytest.raises(PolicyError, match="unknown profile 'gone'"):
        Workspace({"/a": (RAMResource(), MountMode.WRITE)},
                  profiles=PROFILES,
                  profile="gone")


def test_inline_permissions_add_to_the_named_profile():
    ws = _profiled_ws()
    sess = ws.create_session("agent",
                             profile="reviewer",
                             permissions=SessionProfile(
                                 cwd="/a",
                                 mounts={"/a": "rw"},
                                 paths=PathsBlock(hide=("*.key", )),
                                 vars=VarsBlock(hide=("AWS_*", ))))
    assert sess.mount_modes is not None
    # The profile says read and the inline document says write: the weaker
    # one wins, which is the profile's.
    assert sess.mount_modes["/a"] == MountMode.READ
    assert sess.hidden_paths == HiddenPaths(paths=("/a/secrets", ),
                                            patterns=("*.key", ))
    assert sess.hidden_vars == HiddenVars(patterns=("AWS_*", ))
    assert sess.cwd == "/a"


def test_inline_permissions_may_not_state_an_allow_list():
    # The one rule about combining two documents: an inline document
    # restricts, so an allow list there would install a command the profile
    # was never given.
    ws = _profiled_ws()
    with pytest.raises(PolicyError, match="not an allow list"):
        ws.create_session("agent",
                          profile="reviewer",
                          permissions={"commands": {
                              "allow": ["ls"]
                          }})


def test_profile_cwd_is_where_the_session_starts():
    ws = _profiled_ws()
    ws.create_session("agent", profile="reviewer")

    async def run():
        out = await ws.execute("pwd", session_id="agent")
        return await out.stdout_str()

    assert asyncio.run(run()) == "/b\n"


# One mount section, written the same way by both profiles below: rules
# here reach a line that works inside /repo, by cwd or by operand, which
# is what a path-scoped rule cannot express (`cd /repo && git commit`
# names no path).
REPO_SECTION = {
    "commands": {
        "deny": [{
            "reason": "history is read-only here",
            "commands": ["git commit", "git reset --hard"]
        }]
    }
}
COMMANDS_DOC = {
    "commands": {
        "allow": [
            "ls", "cat", "echo", "rm", "git", "python3", "mkdir", "touch",
            "head", "xargs", "wc", "man", "find", "type", "command", "which",
            "cd", "["
        ],
        "deny": [{
            "reason": "no deletes in the repo",
            "commands": {
                "rm": ["/repo/*"]
            }
        }, {
            "reason": "frozen",
            "paths": ["/repo/locked/*"]
        }],
    },
    "mounts": {
        "/repo": REPO_SECTION
    },
}
REVIEWER_COMMANDS = {
    "commands": {
        "allow": [
            "ls", "cat", "echo", "git log", "git status", "xargs", "type",
            "eval"
        ]
    },
    "mounts": {
        "/repo": REPO_SECTION
    },
}


def _commands_ws() -> Workspace:
    # The frozen subtree is seeded on the resource: the pure path rule
    # holds at every op door, the host's `ws.fs` included.
    repo = RAMResource()
    repo._store.dirs.add("/locked")
    repo._store.files["/locked/y"] = b"y\n"
    ws = Workspace(
        {
            "/repo/": (repo, MountMode.WRITE),
            "/scratch/": (RAMResource(), MountMode.WRITE),
        },
        mode=MountMode.WRITE,
        profiles={
            "default": COMMANDS_DOC,
            "reviewer": REVIEWER_COMMANDS
        },
    )
    ws.register_cli("git", cli_spec_for("git"))
    return ws


async def _line(ws: Workspace, line: str, sid: str | None = None):
    r = (await ws.execute(line, session_id=sid)
         if sid is not None else await ws.execute(line))
    return (r.exit_code, await
            r.stdout_str(), with_refusal(await r.stderr_str(), r.refusal))


@pytest.mark.asyncio
async def test_allow_list_hides_unlisted_tools_from_dispatch_and_enumerators():
    ws = _commands_ws()
    try:
        await ws.execute("mkdir -p /repo/d && touch /repo/d/x")
        # An unlisted tool is not a command for the session: 127 before
        # any admission hook, and every enumerator agrees.
        assert await _line(ws,
                           "sort /repo/d/x") == (127, "",
                                                 "sort: command not found\n")
        assert await _line(ws,
                           "type sort; echo $?") == (0, "1\n",
                                                     "type: sort: not found\n")
        assert await _line(ws, "command -v sort; echo $?") == (0, "1\n", "")
        assert await _line(ws, "which sort; echo $?") == (0, "1\n", "")
        code, out, _ = await _line(ws, "man")
        assert code == 0 and "- cat" in out and "- sort" not in out
        assert (await _line(ws, "man sort"))[0] == 1
        # Builtins are subjects like everything else: the listed cd and
        # [ run, the unlisted pwd and history are not commands at all.
        # Functions are the one exemption, and every line of a body
        # passes the gate itself.
        assert await _line(
            ws, "cd /repo && [ -f d/x ] && echo yes") == (0, "yes\n", "")
        assert await _line(ws, "f() { echo in-f; }; f") == (0, "in-f\n", "")
        assert (await _line(ws, "cat /repo/d/x"))[0] == 0
        assert await _line(ws, "pwd") == (127, "", "pwd: command not found\n")
        assert await _line(ws,
                           "type pwd; echo $?") == (0, "1\n",
                                                    "type: pwd: not found\n")
        assert await _line(ws, "history") == (127, "",
                                              "history: command not found\n")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_profiles_allow_list_is_the_only_one_a_session_reads():
    ws = _commands_ws()
    ws.create_session("rev", profile="reviewer")
    try:
        await ws.execute("mkdir -p /repo/d && touch /repo/d/x")
        # The reviewer profile lists `cat` and not python3, whatever the
        # default profile lists; it lists `git log`, so `git` is visible but
        # a `git commit` line is covered by nothing (a refusal that names
        # the program, not "command not found").
        assert (await _line(ws, "cat /repo/d/x", "rev"))[0] == 0
        assert await _line(ws, "python3 -c 1",
                           "rev") == (127, "", "python3: command not found\n")
        assert (await _line(ws, "type git", "rev"))[0] == 0
        assert await _line(
            ws, "git commit -m x",
            "rev") == (126, "", "git: Permission denied\n"
                       "policy denied: git commit is not allowed\n")
        # The verb walk normalizes the line: options before the verb are
        # not the verb, so `git -C /repo status` is `git status`.
        code, _, err = await _line(ws, "git -C /repo status", "rev")
        assert "not allowed" not in err
        # Nested runners re-enter the chokepoint: the hidden `rm` stays
        # hidden inside xargs, eval and a function body.
        assert await _line(ws, "echo /repo/d/x | xargs rm",
                           "rev") == (127, "", "rm: command not found\n")
        assert await _line(ws, "eval 'rm /repo/d/x'",
                           "rev") == (127, "", "rm: command not found\n")
        assert await _line(ws, "f() { rm /repo/d/x; }; f",
                           "rev") == (127, "", "rm: command not found\n")
        # An inline document restricts what is left: it cannot shorten
        # the allow list, but a deny rule of its own still speaks.
        ws.create_session("tight",
                          profile="reviewer",
                          permissions={
                              "commands": {
                                  "deny": [{
                                      "reason": "read-only session",
                                      "commands": ["echo"]
                                  }]
                              }
                          })
        assert (await _line(ws, "cat /repo/d/x", "tight"))[0] == 0
        assert await _line(ws, "echo hi", "tight") == (
            126, "",
            "echo: Permission denied\npolicy denied: read-only session\n")
        code, _, err = await _line(ws, "git log", "tight")
        assert "not allowed" not in err
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_deny_rules_by_source_scope_and_voice():
    ws = _commands_ws()
    try:
        await ws.execute("mkdir -p /repo/d && touch /repo/d/x /scratch/z")
        # Operand-scoped: the GNU voice at 1, the operand as typed.
        assert await _line(
            ws,
            "cd /repo/d && rm x") == (1, "", "rm: x: no deletes in the repo\n")
        assert (await _line(ws, "rm /scratch/z"))[0] == 0
        # A pure path rule holds at the command plane for any command
        # and at the op door for every op, whatever door.
        assert await _line(
            ws,
            "cat /repo/locked/y") == (1, "", "cat: /repo/locked/y: frozen\n")
        with pytest.raises(PermissionError):
            await ws.fs.write("/repo/locked/y", b"changed")
        assert await ws.fs.read("/repo/d/x") == b""
        # A mount section's rule applies when the line works inside the
        # mount (cwd under it, or a path under it), whole command; the
        # verb walk reads `-C /repo reset --hard` as `git reset --hard`.
        assert await _line(ws, "cd /repo && git commit -m x") == (
            126, "", "git: Permission denied\n"
            "policy denied: history is read-only here\n")
        assert await _line(ws, "cd /scratch && git -C /repo reset --hard") == (
            126, "", "git: Permission denied\n"
            "policy denied: history is read-only here\n")
        code, _, err = await _line(ws, "cd /scratch && git commit -m x")
        assert "read-only" not in err
        code, _, err = await _line(ws, "cd /repo && git reset --soft HEAD")
        assert "read-only" not in err
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_find_delete_is_gated_at_the_op_door_not_by_a_named_rule():
    # mirage's find has no -exec; -delete is find's own action, not an
    # `rm` line, so a rule naming `rm` does not cover it (the same
    # honest limit as a guest's os.remove), while a pure path rule
    # does, at the op door the removal clears.
    ws = _commands_ws()
    try:
        await ws.execute("mkdir -p /repo/d && touch /repo/d/x")
        await ws.execute("find /repo/d -name x -delete")
        assert (await _line(ws, "cat /repo/d/x"))[0] != 0
        assert await _line(ws, "find /repo/locked -name y -delete") == (
            1, "", "find: cannot delete '/repo/locked/y': frozen\n")
        assert (await _line(ws, "cat /repo/locked/y"))[0] == 1
        # The same rule holds for the host's own door, read or write.
        with pytest.raises(PermissionError):
            await ws.fs.read("/repo/locked/y")
    finally:
        await ws.close()


LINK_DOC = {
    "commands": {
        "deny": [{
            "reason": "sealed",
            "commands": {
                "cat": ["/data/secret*"],
                "head": ["/data/secret*"]
            }
        }, {
            "reason": "keep the link",
            "commands": {
                "rm": ["/data/link"]
            }
        }],
    }
}


@pytest.mark.asyncio
async def test_a_command_scoped_path_rule_reads_the_path_the_command_touches():
    # A command-scoped rule never runs at the op door, so the command
    # plane has to see the path the command will actually touch: for a
    # command that follows links (open(2)) that is the target, for one
    # that acts on the link itself (rm, lstat(2)) it is the link.
    ws = Workspace({"/data/": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE,
                   profiles={"default": LINK_DOC})
    try:
        await ws.execute("echo top > /data/secret && "
                         "ln -s /data/secret /data/link && "
                         "ln -s /data/secret /data/other")
        assert await _line(
            ws, "cat /data/secret") == (1, "", "cat: /data/secret: sealed\n")
        # Through the link: refused, the operand named as typed.
        assert await _line(ws,
                           "cat /data/link") == (1, "",
                                                 "cat: /data/link: sealed\n")
        assert await _line(
            ws,
            "head -n 1 /data/other") == (1, "", "head: /data/other: sealed\n")
        # rm removes the link, not the target: the target's rule does
        # not apply, the link's own does.
        assert await _line(ws, "rm /data/other") == (0, "", "")
        assert await _line(
            ws, "rm /data/link") == (1, "", "rm: /data/link: keep the link\n")
        assert (await _line(ws, "cat /data/link"))[0] == 1
    finally:
        await ws.close()


SEALED_REDIRECT_DOC = {
    "commands": {
        "deny": [{
            "reason": "sealed",
            "commands": {
                "cat": ["/data/secret*"]
            }
        }, {
            "reason": "audit is append-only",
            "commands": {
                "echo": ["/data/audit.log"]
            }
        }],
    }
}


@pytest.mark.asyncio
async def test_redirect_targets_are_judged_with_the_line():
    # The shell reads `<` and writes `>` on its own fds, outside the
    # admitted command's gate window, so the targets are judged at the
    # line's admission: the refused read never happens and the refused
    # write never truncates.
    ws = Workspace({"/data/": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE,
                   profiles={"default": SEALED_REDIRECT_DOC})
    try:
        await ws.execute("echo top > /data/secret && "
                         "printf 'one\\n' > /data/audit.log")
        assert await _line(
            ws, "cat < /data/secret") == (1, "", "cat: /data/secret: sealed\n")
        assert await _line(ws, "echo two > /data/audit.log") == (
            1, "", "echo: /data/audit.log: audit is append-only\n")
        # The refused write did not truncate, and clean redirects run.
        assert await _line(ws, "cat /data/audit.log") == (0, "one\n", "")
        assert await _line(ws, "cat < /data/audit.log") == (0, "one\n", "")
        assert await _line(
            ws, "echo ok > /data/out && cat < /data/out") == (0, "ok\n", "")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_mount_rule_speaks_on_a_walk_from_above():
    # `grep -r x /scratch` enters /scratch/child: the fan-out reruns
    # the traversal inside each descendant mount and no admission fires
    # again there, so the child mount's rule must speak on the ancestor
    # operand. A walk elsewhere, or a non-recursive read of the parent,
    # is not its business.
    ws = Workspace(
        {
            "/scratch/": (RAMResource(), MountMode.WRITE),
            "/scratch/child/": (RAMResource(), MountMode.WRITE),
            "/elsewhere/": (RAMResource(), MountMode.WRITE),
        },
        mode=MountMode.WRITE,
        profiles={
            "default": {
                "mounts": {
                    "/scratch/child": {
                        "commands": {
                            "deny": [{
                                "reason": "boxed",
                                "commands": ["grep"]
                            }]
                        }
                    }
                }
            }
        })
    try:
        await ws.execute("echo x > /scratch/a && echo x > /elsewhere/a && "
                         "echo x > /scratch/child/c")
        assert await _line(ws, "grep -r x /scratch") == (
            126, "", "grep: Permission denied\npolicy denied: boxed\n")
        code, out, _ = await _line(ws, "grep -r x /elsewhere")
        assert (code, out) == (0, "/elsewhere/a:x\n")
        # Inside the mount the rule needs no ancestor help.
        assert await _line(ws, "grep x /scratch/child/c") == (
            126, "", "grep: Permission denied\npolicy denied: boxed\n")
        # A non-recursive grep of the parent never enters the child.
        code, _, err = await _line(ws, "grep x /scratch")
        assert code == 2 and "Is a directory" in err
    finally:
        await ws.close()


class _Box(Runtime, LineExecutorMixin):
    """A runtime that takes every line raw, recording what reached it."""

    name = "box"
    captures = ("*", )

    def __init__(self) -> None:
        self.lines: list[str] = []

    async def run_line(self, line: str, stdin: bytes | None,
                       env: dict[str, str], cwd: str) -> RunResult:
        self.lines.append(line)
        return RunResult(stdout=b"box:" + line.encode(),
                         stderr=None,
                         exit_code=0)


@pytest.mark.asyncio
async def test_a_whole_line_runtime_is_gated_like_the_tree():
    # A runtime that captures the raw line runs it under the same
    # rules: every parsed command clears visibility, the policy chain
    # and the approval door before the runtime sees a byte, so a
    # captured line cannot run what the tree would refuse.
    box = _Box()
    ws = Workspace({"/repo/": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE,
                   profiles={
                       "default": COMMANDS_DOC,
                       "reviewer": REVIEWER_COMMANDS
                   },
                   runtimes=[box, "vfs"])
    ws.register_cli("git", cli_spec_for("git"))
    try:
        assert await _line(ws, "sort /repo/x") == (127, "",
                                                   "sort: command not found\n")
        assert await _line(
            ws, "cat /repo/a | sort") == (127, "", "sort: command not found\n")
        assert await _line(
            ws,
            "rm /repo/x") == (1, "", "rm: /repo/x: no deletes in the repo\n")
        assert await _line(ws, "cat /repo/a; rm -f /repo/x") == (
            1, "", "rm: /repo/x: no deletes in the repo\n")
        assert box.lines == []
        assert await _line(
            ws, "cat /repo/a | wc -l") == (0, "box:cat /repo/a | wc -l", "")
        ws.create_session("rev", profile="reviewer")
        assert await _line(ws, "git add x", "rev") == (
            126, "",
            "git: Permission denied\npolicy denied: git add is not allowed\n")
        assert (await _line(ws, "git status", "rev"))[0] == 0
        assert box.lines == ["cat /repo/a | wc -l", "git status"]
    finally:
        await ws.close()


LITERAL_DOC = {
    "commands": {
        "deny": [{
            "reason": "no deletes",
            "commands": ["rm"]
        }, {
            "reason": "sealed",
            "commands": {
                "cat": ["/repo/secret*"]
            }
        }, {
            "reason": "no pushes",
            "commands": ["git push"]
        }],
    }
}


@pytest.mark.asyncio
async def test_a_whole_line_runtime_reads_only_literal_words():
    # The runtime expands the line, so the gate reads it as typed and
    # refuses what only the runtime could read where a rule in force
    # would have read it: the command name under any rule, an argument
    # where a rule reads that command's arguments, and a line a word
    # runs that the gate cannot see into.
    box = _Box()
    ws = Workspace({"/repo/": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE,
                   profiles={"default": LITERAL_DOC},
                   runtimes=[box, "vfs"])
    ws.register_cli("git", cli_spec_for("git"))
    try:
        unread = ("Permission denied\n"
                  "policy denied: cannot read {} before the runtime "
                  "expands it\n")
        assert await _line(ws, "rm /repo/x") == (
            126, "", "rm: Permission denied\npolicy denied: no deletes\n")
        assert await _line(ws, "$cmd /repo/x") == (126, "", "$cmd: " +
                                                   unread.format("$cmd"))
        assert await _line(ws, "PAYLOAD='rm /repo/x'; eval \"$PAYLOAD\"") == (
            126, "", '"$PAYLOAD": ' + unread.format('"$PAYLOAD"'))
        assert await _line(ws, "eval 'rm /repo/x'") == (
            126, "", "rm: Permission denied\npolicy denied: no deletes\n")
        assert await _line(ws, 'cat "$f"') == (126, "",
                                               "cat: " + unread.format('"$f"'))
        assert await _line(ws,
                           'git "$verb" origin') == (126, "", "git: " +
                                                     unread.format('"$verb"'))
        assert await _line(ws, "ls /repo | xargs rm") == (
            126, "", "rm: Permission denied\npolicy denied: no deletes\n")
        assert await _line(ws, "ls /repo | xargs cat") == (
            126, "", "cat: Permission denied\n"
            "policy denied: runs on operands the gate cannot read\n")
        assert await _line(ws, "source /repo/env.sh") == (
            126, "", "source: Permission denied\n"
            "policy denied: runs lines the gate cannot read\n")
        assert await _line(ws, "sh -c 'timeout 5 rm /repo/x'") == (
            126, "", "rm: Permission denied\npolicy denied: no deletes\n")
        assert await _line(ws, "builtin eval 'rm /repo/x'") == (
            126, "", "rm: Permission denied\npolicy denied: "
            "no deletes\n")
        assert box.lines == []
        # Literal words, and dynamic ones no rule reads, reach the runtime.
        for line in ('echo "$HOME" $(date)', "git status", "'cat' /repo/a",
                     "ls | xargs echo", "command -v rm"):
            assert (await _line(ws, line))[0] == 0
        assert box.lines == [
            'echo "$HOME" $(date)', "git status", "'cat' /repo/a",
            "ls | xargs echo", "command -v rm"
        ]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_bare_listing_in_a_ruled_directory_is_refused():
    # `ls`, `find`, `du`, `tree` and `grep -r` typed bare read the
    # working directory: the executor injects that operand after the
    # gate, so the gate supplies it itself, typed as `.`.
    ws = Workspace({"/repo/": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE,
                   profiles={
                       "default": {
                           "commands": {
                               "deny": [{
                                   "reason": "sealed",
                                   "commands": {
                                       "ls": ["/repo/sealed"],
                                       "find": ["/repo/sealed"],
                                       "grep": ["/repo/sealed"]
                                   }
                               }]
                           }
                       }
                   })
    try:
        await ws.execute("mkdir -p /repo/sealed && echo x > /repo/sealed/f")
        assert await _line(ws,
                           "ls /repo/sealed") == (1, "",
                                                  "ls: /repo/sealed: sealed\n")
        assert await _line(ws, "cd /repo/sealed && ls") == (1, "",
                                                            "ls: .: sealed\n")
        assert await _line(
            ws,
            "cd /repo/sealed && find -name f") == (1, "", "find: .: sealed\n")
        assert await _line(
            ws,
            "cd /repo/sealed && grep -r x") == (1, "",
                                                "grep: /repo/sealed: sealed\n")
        # With an operand, or without the recursion that reads the
        # directory, nothing is implied.
        assert await _line(ws,
                           "cd /repo/sealed && ls /repo") == (0, "sealed\n",
                                                              "")
        assert await _line(ws,
                           "cd /repo/sealed && echo x | grep x") == (0, "x\n",
                                                                     "")
    finally:
        await ws.close()


VEILED_DOC = {
    "commands": {
        "allow": ["mkdir", "echo", "touch", "cat", "rm", "ls", "head"],
        "ask": [{
            "reason": "sign-off",
            "commands": {
                "rm": ["/repo/shared/*"]
            }
        }],
        "deny": [{
            "reason": "private",
            "commands": {
                "cat": ["/repo/private"]
            }
        }, {
            "reason": "sealed",
            "paths": ["/repo/sealed/*"]
        }, {
            "reason": "no heads",
            "commands": ["head"]
        }],
    }
}


@pytest.mark.asyncio
async def test_a_hidden_path_reads_as_absent_to_every_rule():
    # hide outranks every rule: a path the session cannot see
    # is dropped before any hook, so a deny never names it, an ask is
    # never raised for it, and the door answers ENOENT as for any
    # absent path. The same lines under a session that sees them meet
    # the rules as usual.
    ws = Workspace({"/repo/": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE,
                   profiles={"default": VEILED_DOC})
    try:
        await ws.execute("mkdir -p /repo/private /repo/shared && "
                         "echo k > /repo/private/k && touch /repo/shared/a")
        # The same rules plus three hides: what the hides cover is gone
        # before any rule is asked.
        ws.create_session(
            "veiled",
            profile=SessionProfile.model_validate({
                **VEILED_DOC, "paths": {
                    "hide": ["/repo/private", "/repo/shared", "/repo/sealed"]
                }
            }))
        assert await _line(
            ws, "cat /repo/private/k") == (1, "",
                                           "cat: /repo/private/k: private\n")
        assert await _line(
            ws, "cat /repo/private/k",
            "veiled") == (1, "",
                          "cat: /repo/private/k: No such file or directory\n")
        assert await _line(
            ws,
            "cat /repo/sealed/x") == (1, "", "cat: /repo/sealed/x: sealed\n")
        assert await _line(
            ws, "cat /repo/sealed/x",
            "veiled") == (1, "",
                          "cat: /repo/sealed/x: No such file or directory\n")
        code, _, err = await _line(ws, "rm /repo/shared/a")
        assert code == 126 and err.startswith(
            "rm: Permission denied\nrequires approval: sign-off")
        assert await _line(ws, "rm /repo/shared/a", "veiled") == (
            1, "",
            "rm: cannot remove '/repo/shared/a': No such file or directory\n")
        assert [r.session_id for r in ws.decisions.pending()
                ] == [ws._session_mgr.default_id]
        assert await _line(ws, "ls /repo", "veiled") == (0, "", "")
        # A rule with no path in it still speaks: nothing hidden is named.
        assert await _line(
            ws, "head /repo/private/k",
            "veiled") == (126, "",
                          "head: Permission denied\npolicy denied: no heads\n")
    finally:
        await ws.close()


ASK_DOC = {
    "commands": {
        "ask": [{
            "reason": "sign-off",
            "commands": ["rm"]
        }, "head"],
        "deny": [{
            "reason": "no deletes in the repo",
            "commands": {
                "rm": ["/repo/*"]
            }
        }],
    }
}


class AskWc(Policy):
    """A coded condition that asks: every wc line."""

    async def pre_command(self, ctx: CommandContext) -> Action | None:
        if ctx.command == "wc":
            return Ask("looks risky")
        return None


def _ask_ws(**kwargs) -> Workspace:
    ws = Workspace(
        {
            "/repo/": (RAMResource(), MountMode.WRITE),
            "/scratch/": (RAMResource(), MountMode.WRITE),
        },
        mode=MountMode.WRITE,
        profiles={"default": ASK_DOC},
        policies=[AskWc()],
        **kwargs,
    )
    return ws


@pytest.mark.asyncio
async def test_an_asked_line_is_refused_until_the_host_answers():
    ws = _ask_ws()
    try:
        await ws.execute("mkdir -p /repo/d && touch /repo/d/x /scratch/z")
        # Asked: 126 in the requires-approval voice, quoting an id; the
        # request is on ws.decisions with what was asked; a retry quotes
        # the same id and adds nothing.
        code, _, err = await _line(ws, "rm /scratch/z")
        assert code == 126
        (request, ) = ws.decisions.pending()
        assert err == (f"rm: Permission denied\nrequires approval: sign-off "
                       f"(ask {request.id})\n")
        assert (request.command, request.argv, request.cwd,
                request.paths) == ("rm", ("/scratch/z", ), "/",
                                   ("/scratch/z", ))
        assert request.session_id == ws._session_mgr.default_id
        assert await _line(ws, "rm /scratch/z") == (126, "", err)
        assert len(ws.decisions.pending()) == 1
        # The request names the agent of the call that asked, not the
        # workspace's default agent, so a shared workspace attributes an
        # approval to whoever raised it.
        assert request.agent_id == ""
        by_bob = await ws.execute("rm /scratch/z2", agent_id="bob")
        assert by_bob.exit_code == 126
        assert [r.agent_id for r in ws.decisions.pending()] == ["", "bob"]
        # The agent rides with the execution, not the workspace: a line
        # asked through a nested eval keeps its caller's, and two lines
        # in flight at once keep their own.
        #
        # The substitution's own command is a command of the line, so
        # the line is refused whole rather than running `echo` over an
        # empty substitution and exiting 0, which used to leave the
        # agent reading success for a removal that never happened.
        nested = await ws.execute("echo $(rm /scratch/z3)", agent_id="carol")
        assert nested.exit_code == 126
        await asyncio.gather(
            ws.execute("rm /scratch/z4", agent_id="dan"),
            ws.execute("eval 'rm /scratch/z5'", agent_id="eve"))
        by_agent = {
            r.command + " " + " ".join(r.argv): r.agent_id
            for r in ws.decisions.pending()
        }
        assert by_agent == {
            "rm /scratch/z": "",
            "rm /scratch/z2": "bob",
            "rm /scratch/z3": "carol",
            "rm /scratch/z4": "dan",
            "rm /scratch/z5": "eve",
        }
        for r in ws.decisions.pending():
            if r.agent_id not in ("", "bob"):
                await ws.decisions.answer(r.id, Outcome.DENY)
        (bobs, ) = (r for r in ws.decisions.pending() if r.agent_id == "bob")
        await ws.decisions.answer(bobs.id, Outcome.DENY)
        # Granted once: the exact retry passes, and the next one asks.
        await ws.decisions.answer(request.id, Outcome.ALLOW)
        assert ws.decisions.pending() == ()
        assert (await _line(ws, "rm /scratch/z"))[0] == 0
        assert (await _line(ws, "cat /scratch/z"))[0] == 1
        code, _, err = await _line(ws, "rm /scratch/z")
        assert code == 126 and "requires approval" in err
        # A bare pattern asks with the default reason.
        code, _, err = await _line(ws, "head /repo/d/x")
        assert code == 126
        assert err.startswith(
            "head: Permission denied\nrequires approval: no standing approval")
        # Denied: the retry is refused once in the deny voice, then the
        # question is open again.
        pending = {r.command: r for r in ws.decisions.pending()}
        await ws.decisions.answer(pending["head"].id, Outcome.DENY)
        assert await _line(ws, "head /repo/d/x") == (
            126, "",
            "head: Permission denied\npolicy denied: no standing approval\n")
        code, _, err = await _line(ws, "head /repo/d/x")
        assert code == 126 and "requires approval" in err
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_session_grant_covers_the_rule_and_a_deny_is_never_reopened():
    ws = _ask_ws()
    try:
        await ws.execute("mkdir -p /repo/d && touch /repo/d/x /scratch/y "
                         "/scratch/z")
        code, _, _ = await _line(ws, "rm /scratch/y")
        assert code == 126
        (request, ) = ws.decisions.pending()
        await ws.decisions.answer(request.id, Outcome.ALLOW, Scope.SESSION)
        # Every rm line passes now, in any directory of the session ...
        assert (await _line(ws, "rm /scratch/y"))[0] == 0
        assert (await _line(ws, "cd /scratch && rm z"))[0] == 0
        # ... except where a deny rule speaks: deny outranks ask at the
        # same anchor depth, so no grant can re-open it, and the denied line
        # raises no request (nothing for the host to answer; the battery
        # cannot see this, so it is pinned here).
        assert await _line(
            ws,
            "cd /repo/d && rm x") == (1, "", "rm: x: no deletes in the repo\n")
        assert ws.decisions.pending() == ()
        # The answer is session state: on the record, and not another
        # session's.
        default = ws._session_mgr.get(ws._session_mgr.default_id)
        stored = default.to_dict()["decisions"][0]
        assert (stored["outcome"], stored["scope"]) == ("allow", "session")
        ws.create_session("other")
        await ws.execute("touch /scratch/w", session_id="other")
        code, _, err = await _line(ws, "rm /scratch/w", "other")
        assert code == 126 and "requires approval" in err
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_coded_ask_routes_to_the_same_door():
    ws = _ask_ws()
    try:
        await ws.execute("touch /scratch/z")
        code, _, err = await _line(ws, "wc -c /scratch/z")
        assert code == 126
        (request, ) = ws.decisions.pending()
        assert err == (
            f"wc: Permission denied\nrequires approval: looks risky "
            f"(ask {request.id})\n")
        # The synthesized rule names the program, so a session grant
        # covers every wc line.
        assert request.rule == CommandRule(reason="looks risky",
                                           commands=("wc", ))
        await ws.decisions.answer(request.id, Outcome.ALLOW, Scope.SESSION)
        assert await _line(ws, "wc -c /scratch/z") == (0, "0 /scratch/z\n", "")
        assert await _line(ws, "wc -l /scratch/z") == (0, "0 /scratch/z\n", "")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_grant_is_consumed_through_a_fork():
    ws = _ask_ws()
    try:
        await ws.execute("touch /scratch/z")
        code, _, _ = await _line(ws, "rm /scratch/z")
        assert code == 126
        (request, ) = ws.decisions.pending()
        await ws.decisions.answer(request.id, Outcome.ALLOW)
        # execute(env=) runs the line in a fork of the session: the once
        # grant is read and consumed through the manager, so the fork
        # spends it for the session it forked from.
        forked = await ws.execute("rm /scratch/z", env={"X": "1"})
        assert forked.exit_code == 0
        code, _, err = await _line(ws, "rm /scratch/z")
        assert code == 126 and "requires approval" in err
    finally:
        await ws.close()


async def _host_allows_once(record: Decision) -> Decision:
    return dataclasses.replace(record, outcome=Outcome.ALLOW, scope=Scope.ONCE)


async def _host_denies(record: Decision) -> Decision:
    return dataclasses.replace(record, outcome=Outcome.DENY)


@pytest.mark.asyncio
async def test_a_blocking_host_answers_inside_the_line():
    # The host is a plain coroutine over the ledger's own record, not a
    # class implementing a protocol: it answers by returning the record
    # with an outcome set.
    ws = _ask_ws(on_ask=_host_allows_once)
    try:
        await ws.execute("touch /scratch/z")
        assert (await _line(ws, "rm /scratch/z"))[0] == 0
        assert ws.decisions.pending() == ()
    finally:
        await ws.close()
    ws = _ask_ws(on_ask=_host_denies)
    try:
        await ws.execute("touch /scratch/z")
        assert await _line(ws, "rm /scratch/z") == (
            126, "", "rm: Permission denied\npolicy denied: sign-off\n")
        assert (await _line(ws, "cat /scratch/z"))[0] == 0
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_host_still_deciding_does_not_outlive_the_run():
    started = asyncio.Event()

    async def never(record: Decision) -> Decision:
        # A host that never answers. Before the wait was bounded, the
        # line below sat here forever and the cancel event it was given
        # was never observed at all.
        started.set()
        await asyncio.Event().wait()
        raise AssertionError("unreachable")

    cancel = asyncio.Event()
    ws = _ask_ws(on_ask=never)
    try:
        await ws.execute("touch /scratch/z")
        line = asyncio.ensure_future(ws.execute("rm /scratch/z",
                                                cancel=cancel))
        await started.wait()
        cancel.set()
        with pytest.raises(MirageAbortError):
            await line
        # The kill is not an answer: the question is still open, and the
        # file the line would have removed is still there.
        assert len(ws.decisions.pending()) == 1
        assert (await _line(ws, "cat /scratch/z"))[0] == 0
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_compound_line_asked_before_it_runs_is_killable_too():
    started = asyncio.Event()

    async def never(record: Decision) -> Decision:
        started.set()
        await asyncio.Event().wait()
        raise AssertionError("unreachable")

    cancel = asyncio.Event()
    ws = _ask_ws(on_ask=never)
    try:
        await ws.execute("touch /scratch/z")
        # More than one command, so the question is put by the prejudge
        # pass rather than the per-command gate. That pass took no kill
        # channel, so this shape sat on the host after the single
        # command one stopped doing so.
        line = asyncio.ensure_future(
            ws.execute("rm /scratch/z; echo done", cancel=cancel))
        await started.wait()
        cancel.set()
        with pytest.raises(MirageAbortError):
            await line
        assert len(ws.decisions.pending()) == 1
        assert (await _line(ws, "cat /scratch/z"))[0] == 0
    finally:
        await ws.close()


# A plain document, passed raw: the constructor validates it, so the
# whole walk battery also pins the raw-doc door.
WALK_DOC = {
    "paths": {
        "hide": ["/data/t/ghost"]
    },
    "commands": {
        "allow": [
            "mkdir", "echo", "ls", "cat", "grep", "find", "du", "cp", "tar",
            "tree", "stat", "rm", "test"
        ],
        "ask": [{
            "reason": "nod",
            "commands": {
                "grep": ["/data/t/asked/*"]
            }
        }],
        "deny": [{
            "reason": "private",
            "commands": {
                "grep": ["/data/t/private"],
                "ls": ["/data/t/private"]
            }
        }, {
            "reason": "sealed",
            "paths": ["/data/t/sealed"]
        }, {
            "reason": "frozen",
            "paths": ["/data/t/locked/*"]
        }],
    }
}


def _walk_ws() -> Workspace:
    # The rules live on a profile so the tree can be seeded under the
    # unrestricted default session; every probe runs as "g".
    ws = Workspace({"/data/": (RAMResource(), MountMode.WRITE)},
                   mode=MountMode.WRITE,
                   profiles={"guarded": WALK_DOC})
    ws.create_session("g", profile="guarded")
    return ws


async def _seed_walk_tree(ws: Workspace) -> None:
    await ws.execute(
        "mkdir -p /data/t/private /data/t/sealed/deep /data/t/locked "
        "/data/t/open /data/t/asked /data/t/ghost && "
        "echo k > /data/t/private/k && echo s > /data/t/sealed/s && "
        "echo d > /data/t/sealed/deep/d && echo y > /data/t/locked/y && "
        "echo o > /data/t/open/o && echo a > /data/t/asked/a && "
        "echo g > /data/t/ghost/g")


@pytest.mark.asyncio
async def test_a_walk_below_the_operand_meets_the_rule_guard():
    # The gate judges the operands; the entries a walk reaches below
    # them pass the same rules at the command's own I/O, and each
    # walker reports the refusal the way GNU reports an unreadable
    # entry (pinned on debian:stable-slim): names and sizes still show,
    # the content is what is refused, and a hidden path is simply not
    # there.
    ws = _walk_ws()
    try:
        await _seed_walk_tree(ws)
        code, out, err = await _line(ws, "grep -r . /data/t", "g")
        assert code == 2
        assert out == "/data/t/open/o:o\n"
        assert err == ("grep: /data/t/asked/a: Permission denied\n"
                       "grep: /data/t/locked/y: Permission denied\n"
                       "grep: /data/t/private: Permission denied\n"
                       "grep: /data/t/sealed: Permission denied\n")
        code, out, err = await _line(ws, "ls -R /data/t", "g")
        assert code == 1
        assert "locked:\ny\n" in out and "asked:\na\n" in out
        assert "ghost" not in out
        assert err == (
            "ls: cannot open directory '/data/t/private': Permission denied\n"
            "ls: cannot open directory '/data/t/sealed': Permission denied\n")
        code, out, err = await _line(ws, "find /data/t -name '*'", "g")
        assert code == 1
        assert "/data/t/sealed\n" in out and "/data/t/sealed/s" not in out
        assert "/data/t/locked/y\n" in out and "/data/t/private/k\n" in out
        assert err == "find: '/data/t/sealed': Permission denied\n"
        code, out, err = await _line(ws, "du -a /data/t", "g")
        assert code == 1
        assert "2\t/data/t/locked/y\n" in out and "sealed" not in out
        assert err == ("du: cannot read directory '/data/t/sealed': "
                       "Permission denied\n")
        code, out, err = await _line(ws, "cp -r /data/t /data/copy", "g")
        assert code == 1
        assert err == (
            "cp: cannot access '/data/t/sealed': Permission denied\n"
            "cp: cannot open '/data/t/locked/y' for reading: "
            "Permission denied\n")
        assert (await _line(ws, "cat /data/copy/private/k", "g"))[1] == "k\n"
        assert (await _line(ws, "test -d /data/copy/sealed", "g"))[0] == 0
        assert (await _line(ws, "test -e /data/copy/locked/y", "g"))[0] == 1
        code, out, err = await _line(ws, "tar -cf /data/a.tar /data/t", "g")
        assert code == 2
        assert err == ("tar: Removing leading `/' from member names\n"
                       "tar: /data/t/sealed: Cannot open: Permission denied\n"
                       "tar: /data/t/locked/y: Cannot open: Permission "
                       "denied\n"
                       "tar: Exiting with failure status due to previous "
                       "errors\n")
        code, out, err = await _line(ws, "tar -tf /data/a.tar", "g")
        assert "data/t/sealed/\n" in out and "locked/y" not in out
        assert "data/t/private/k\n" in out and "ghost" not in out
        code, out, err = await _line(ws, "tree /data/t", "g")
        assert code == 2 and err == ""
        assert "`-- sealed  [error opening dir]\n" in out
        assert "|   `-- y\n" in out
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_an_asked_scope_reached_by_a_walk_is_refused_until_named():
    # A walk gets no nod mid-command: the entry is refused without a
    # request, the agent names the path, the grant covers that line.
    ws = _walk_ws()
    try:
        await _seed_walk_tree(ws)
        assert await _line(
            ws, "grep -r a /data/t/asked",
            "g") == (2, "", "grep: /data/t/asked/a: Permission denied\n")
        assert ws.decisions.pending() == ()
        code, _, err = await _line(ws, "grep a /data/t/asked/a", "g")
        assert code == 126 and err.startswith(
            "grep: Permission denied\nrequires approval: nod")
        (request, ) = ws.decisions.pending()
        await ws.decisions.answer(request.id, Outcome.ALLOW)
        assert await _line(ws, "grep a /data/t/asked/a", "g") == (0, "a\n", "")
        # A standing grant covers the walk too.
        code, _, err = await _line(ws, "grep a /data/t/asked/a", "g")
        (request, ) = ws.decisions.pending()
        await ws.decisions.answer(request.id, Outcome.ALLOW, Scope.SESSION)
        assert await _line(ws, "grep -r a /data/t/asked",
                           "g") == (0, "/data/t/asked/a:a\n", "")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_the_op_door_stats_a_refused_entry_and_withholds_its_content():
    ws = _walk_ws()
    try:
        await _seed_walk_tree(ws)
        sess = ws.get_session("g")
        token = set_current_session(sess)
        try:
            assert (await ws.fs.stat("/data/t/locked/y")).size == 2
            with pytest.raises(PermissionError):
                await ws.fs.read("/data/t/locked/y")
            with pytest.raises(FileNotFoundError):
                await ws.fs.stat("/data/t/ghost/g")
        finally:
            reset_current_session(token)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_every_permissions_door_accepts_the_plain_document():
    # `profiles`, `create_session(profile=)` and `create_session
    # (permissions=)` all validate raw mappings internally, so the
    # Python API reads like the YAML and the TypeScript object literal;
    # a built model still passes unchanged.
    ws = Workspace(
        {
            "/data/": (RAMResource(), MountMode.WRITE),
            "/box/": (RAMResource(), MountMode.WRITE),
        },
        mode=MountMode.WRITE,
        profiles={
            "default": {
                "commands": {
                    "deny": [{
                        "reason": "walled",
                        "paths": ["/data/w"]
                    }]
                },
                "mounts": {
                    "/box": {
                        "commands": {
                            "deny": [{
                                "reason": "boxed",
                                "paths": ["/box/top"]
                            }]
                        }
                    }
                },
            }
        },
    )
    try:
        assert await _line(ws,
                           "cat /data/w") == (1, "", "cat: /data/w: walled\n")
        assert await _line(ws,
                           "cat /box/top") == (1, "", "cat: /box/top: boxed\n")
        ws.create_session("i", profile={"commands": {"allow": ["echo"]}})
        assert (await _line(ws, "ls /data", "i"))[0] == 127
        ws.create_session("d",
                          permissions={
                              "commands": {
                                  "deny": [{
                                      "reason": "no",
                                      "commands": {
                                          "cat": ["/data/*"]
                                      }
                                  }]
                              }
                          })
        assert await _line(ws, "cat /data/x",
                           "d") == (1, "", "cat: /data/x: no\n")
    finally:
        await ws.close()


def test_a_misspelled_document_field_fails_at_construction():
    with pytest.raises(ValidationError):
        Workspace({"/data/": RAMResource()}, profiles={"g": {"commandz": {}}})
    ws = Workspace({"/data/": RAMResource()})
    with pytest.raises(ValidationError):
        ws.create_session("x", permissions={"command": {"deny": []}})


def test_a_policy_alone_is_a_whole_profile():
    # The document is optional beside a policy: nothing is hidden, and
    # the policy is the profile's whole admission policy.
    profile = SessionProfile.model_validate({
        "policy": {
            "script": ScriptSource("None"),
            "runtime": "monty",
        },
    })
    assert profile.policy is not None
    assert isinstance(profile.policy.script, ScriptSource)
    assert profile.policy.runtime == "monty"
    assert profile.commands is None


def test_a_policy_rides_beside_the_document():
    profile = SessionProfile.model_validate({
        "commands": {
            "allow": ["ls"]
        },
        "policy": {
            "script": ScriptSource("None"),
            "runtime": "monty",
        },
    })
    assert profile.policy is not None
    assert isinstance(profile.policy.script, ScriptSource)
    assert profile.commands is not None


def test_a_policy_without_a_runtime_is_refused():
    # There is no default engine, so a policy that names none is a
    # config error, not a guess.
    with pytest.raises(ValidationError, match="runtime"):
        SessionProfile.model_validate(
            {"policy": {
                "script": ScriptSource("None")
            }})


def test_a_policy_is_a_block_not_a_path():
    with pytest.raises(ValidationError):
        SessionProfile.model_validate({"policy": "roles/x.py"})


def test_the_old_script_and_runtime_keys_are_told_where_they_went():
    # Shipped first as `script` with `runtime` beside it; the refusal
    # says where they went.
    with pytest.raises(ValidationError, match="now one policy block"):
        SessionProfile.model_validate({
            "script": ScriptSource("None"),
            "runtime": "monty",
        })
    with pytest.raises(ValidationError, match="now one policy block"):
        SessionProfile.model_validate({"runtime": "monty"})
