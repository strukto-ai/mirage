import errno
from typing import Any

import pytest

from mirage.policy import Action, Deny, Policy, VfsContext
from mirage.types import MountMode, PathSpec
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from mirage.workspace.executor.builtins.links import (
    accepts_line,
    follow_parent,
    follow_paths,
    prepare_mv,
)


def _ws() -> Workspace:
    return Workspace(
        {"/data": (RAMVFS(), MountMode.WRITE)}, mode=MountMode.WRITE
    )


def _refusing(ws: Workspace, method: str, path: str) -> None:
    """Make one namespace write refuse ``path`` with EACCES: the fault a
    command meets partway through, after it was admitted.

    Args:
        ws (Workspace): the workspace.
        method (str): the namespace write (``unlink``, ``symlink``).
        path (str): the link path it refuses.
    """
    real = getattr(ws.namespace, method)

    async def refusing(link: str, *args: Any, **kwargs: Any) -> Any:
        if link == path:
            raise PermissionError(errno.EACCES, "Permission denied", path)
        return await real(link, *args, **kwargs)

    setattr(ws.namespace, method, refusing)


@pytest.mark.asyncio
async def test_follow_parent_resolves_every_component_but_the_last():
    ws = _ws()
    await ws.shell("mkdir -p /data/real; ln -s /data/real /data/dlink")
    ns = ws.namespace
    assert follow_parent(ns, "/data/dlink/f2") == "/data/real/f2"
    assert follow_parent(ns, "/data/dlink") == "/data/dlink"


@pytest.mark.asyncio
async def test_follow_paths_follows_the_last_component_only_when_asked():
    ws = _ws()
    await ws.shell("mkdir -p /data/real; ln -s /data/real /data/dlink")
    ns = ws.namespace
    item = PathSpec.from_str_path("/data/dlink")
    kept = follow_paths(ns, [item], follow_last=False)
    assert kept[0].virtual == "/data/dlink"
    followed = follow_paths(ns, [item], follow_last=True)
    assert followed[0].virtual == "/data/real"
    slashed = follow_paths(
        ns, [PathSpec.from_str_path("/data/dlink/")], follow_last=False
    )
    assert slashed[0].virtual == "/data/real/"


@pytest.mark.asyncio
async def test_follow_paths_refuses_a_loop_per_operand():
    # A loop no longer fails the whole line: the operand stays as typed
    # with the walk's verdict on it, and its neighbours still resolve.
    ws = _ws()
    await ws.shell(
        "mkdir -p /data/real; ln -s /data/real /data/dlink; "
        "ln -s /data/l2 /data/l1; ln -s /data/l1 /data/l2"
    )
    ns = ws.namespace
    loop, link = follow_paths(
        ns,
        [
            PathSpec.from_str_path("/data/l1"),
            PathSpec.from_str_path("/data/dlink"),
        ],
    )
    assert (loop.virtual, loop.walk_error) == ("/data/l1", "ELOOP")
    assert (link.virtual, link.walk_error) == ("/data/real", None)
    under = follow_paths(
        ns, [PathSpec.from_str_path("/data/l1/x")], follow_last=False
    )
    assert under[0].walk_error == "ELOOP"
    # lstat semantics never reach the looping name itself.
    kept = follow_paths(
        ns, [PathSpec.from_str_path("/data/l1")], follow_last=False
    )
    assert kept[0].walk_error is None


@pytest.mark.asyncio
async def test_mv_onto_a_loop_replaces_the_link():
    # stat(2) of the destination fails ELOOP, which GNU mv reads as "not
    # a directory": the rename lands on the link's own name.
    ws = _ws()
    await ws.shell(
        "echo b > /data/b.txt; "
        "ln -s /data/l2 /data/l1; ln -s /data/l1 /data/l2"
    )
    r = await ws.shell("mv /data/b.txt /data/l1")
    assert r.exit_code == 0
    assert not ws.namespace.is_link("/data/l1")
    assert (await ws.shell("cat /data/l1")).stdout == b"b\n"


@pytest.mark.asyncio
@pytest.mark.parametrize("source", ["missing", "a.txt", "l1"])
async def test_mv_symlink_onto_a_loop_replaces_destination(source):
    ws = _ws()
    await ws.shell(
        "echo a > /data/a.txt; "
        "ln -s l2 /data/l1; ln -s l1 /data/l2; "
        f"ln -s {source} /data/src"
    )
    result = await ws.shell("mv /data/src /data/l1")
    assert result.exit_code == 0
    assert not result.stderr
    assert not ws.namespace.is_link("/data/src")
    assert (
        await ws.shell("readlink /data/l1")
    ).stdout == f"{source}\n".encode()


def test_accepts_line_refuses_what_the_command_layer_would():
    good = [PathSpec.from_str_path("/data/dlink")]
    assert accepts_line("rm", ("/data/dlink",), good, "/data")
    assert not accepts_line("rm", ("--bogus", "/data/dlink"), good, "/data")
    two = [
        PathSpec.from_str_path("/data/a"),
        PathSpec.from_str_path("/data/b"),
    ]
    assert not accepts_line("unlink", ("/data/a", "/data/b"), two, "/data")


class PinLinks(Policy):
    async def pre_vfs(self, ctx: VfsContext) -> Action | None:
        if ctx.call.name == "unlink" and ctx.path.virtual.endswith(".pinned"):
            return Deny("pinned")
        return None


class RefuseSteps(Policy):
    async def pre_vfs(self, ctx: VfsContext) -> Action | None:
        name, virtual = ctx.call.name, ctx.path.virtual.rstrip("/")
        if (name, virtual) == ("readdir", "/data/p"):
            return Deny("unlisted")
        if name == "stat" and virtual.endswith(".hid"):
            return Deny("hidden")
        if name == "unlink" and virtual.endswith(".pinned"):
            return Deny("pinned")
        return None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line, stderr, made",
    [
        ("ln -s /data/f.txt /data/p/d", "", "/data/p/d/f.txt"),
        (
            "ln -s y /data/z.hid",
            "ln: failed to create symbolic link '/data/z.hid': "
            "Permission denied\n",
            None,
        ),
        (
            "ln -sf y /data/x.pinned",
            "ln: failed to create symbolic link '/data/x.pinned': "
            "Permission denied\n",
            None,
        ),
    ],
    ids=["unlisted-parent", "refused-name", "refused-unlink"],
)
async def test_ln_words_a_refusal_by_the_step_that_meets_it(
    line, stderr, made
):
    # GNU 9.7: a directory it may stat takes the link whatever its parent
    # lists; a name it may not stat refuses the link; under -f an unlink
    # refused after the lstat passed refuses the link, not the access.
    ws = Workspace(
        {"/data": (RAMVFS(), MountMode.WRITE)},
        mode=MountMode.WRITE,
        policies=[RefuseSteps()],
    )
    await ws.shell(
        "mkdir -p /data/p/d; printf f > /data/f.txt; printf x > /data/x.pinned"
    )
    r = await ws.shell(line)
    assert (r.exit_code, r.stderr or b"") == (
        1 if stderr else 0,
        stderr.encode(),
    )
    assert made is None or ws.namespace.is_link(made)


@pytest.mark.asyncio
async def test_ln_f_refuses_the_same_file_before_removing_it():
    # Pinned on coreutils 9.7: `ln -sf a a` and `ln -f a a` are refused
    # and the file survives, spelled as typed on both sides; a backup
    # waives the check; a destination that is not there is not the
    # same file and becomes a self-loop, as in GNU.
    ws = _ws()
    await ws.shell("printf hi > /data/a.txt")
    for line, wording in (
        ("ln -sf /data/a.txt /data/a.txt", "'/data/a.txt' and '/data/a.txt'"),
        ("ln -f /data/a.txt /data/a.txt", "'/data/a.txt' and '/data/a.txt'"),
        ("cd /data && ln -sf a.txt ./a.txt", "'a.txt' and './a.txt'"),
        ("cd /data && ln -sfT a.txt a.txt", "'a.txt' and 'a.txt'"),
    ):
        r = await ws.shell(line)
        assert r.exit_code == 1
        assert r.stderr == f"ln: {wording} are the same file\n".encode()
        assert (await ws.shell("cat /data/a.txt")).stdout == b"hi"
        assert not ws.namespace.is_link("/data/a.txt")
    r = await ws.shell("ln -sfb /data/a.txt /data/a.txt")
    assert r.exit_code == 0
    assert (await ws.shell("cat /data/a.txt~")).stdout == b"hi"
    assert ws.namespace.readlink("/data/a.txt") == "/data/a.txt"
    r = await ws.shell("ln -sf /data/nope /data/nope")
    assert r.exit_code == 0
    assert ws.namespace.readlink("/data/nope") == "/data/nope"


@pytest.mark.asyncio
async def test_ln_backup_refuses_a_directory_destination():
    # Pinned on coreutils 9.7: a backup moves a file aside, never a
    # directory, so `ln -bT a d` is refused with the directory intact
    # where mirage used to rename the whole tree to `d~`; a symlink
    # standing at the name is what -T names and is backed up; without
    # -T the directory is where the link goes.
    ws = _ws()
    await ws.shell("mkdir -p /data/d; printf hi > /data/a.txt")
    for line in (
        "ln -sbT /data/a.txt /data/d",
        "ln -bT /data/a.txt /data/d",
        "ln -sfbT /data/a.txt /data/d",
        "ln -s --backup=numbered -T /data/a.txt /data/d",
    ):
        r = await ws.shell(line)
        assert r.exit_code == 1
        assert r.stderr == b"ln: /data/d: cannot overwrite directory\n"
        assert (await ws.shell("ls /data")).stdout == b"a.txt\nd\n"
        assert not ws.namespace.is_link("/data/d")
    r = await ws.shell("ln -sb /data/a.txt /data/d")
    assert r.exit_code == 0
    assert ws.namespace.readlink("/data/d/a.txt") == "/data/a.txt"
    await ws.shell("ln -s /data/d /data/lk")
    r = await ws.shell("ln -sbT /data/a.txt /data/lk")
    assert r.exit_code == 0
    assert ws.namespace.readlink("/data/lk") == "/data/a.txt"
    assert ws.namespace.readlink("/data/lk~") == "/data/d"


class SealedReads(RAMVFS):
    async def read(
        self, path: PathSpec, offset: int = 0, size: int | None = None
    ) -> bytes:
        if path.virtual.endswith(".sealed"):
            raise PermissionError(
                errno.EACCES, "Permission denied", path.virtual
            )
        return await super().read(path, offset, size)


@pytest.mark.asyncio
async def test_ln_keeps_going_after_a_source_it_cannot_read():
    # GNU names the source it cannot reach and links the rest, exit 1.
    # mirage's hard link is a byte copy, so a read the stat did not
    # foresee (the backend's refusal here) is that refusal, not an abort.
    ws = Workspace(
        {"/data": (SealedReads(), MountMode.WRITE)}, mode=MountMode.WRITE
    )
    await ws.shell(
        "mkdir /data/d; printf a > /data/a.sealed; printf b > /data/b.txt"
    )
    r = await ws.shell("ln /data/a.sealed /data/b.txt /data/d")
    assert r.exit_code == 1
    assert r.stderr == (
        b"ln: failed to access '/data/a.sealed': Permission denied\n"
    )
    assert (
        await ws.shell("ls /data/d; cat /data/d/b.txt")
    ).stdout == b"b.txt\nb"


@pytest.mark.asyncio
async def test_unlink_of_a_link_meets_the_op_methods():
    # The node table is written through the dispatcher, so a pre_vfs
    # policy protecting a link fires for an unlink of it as for any
    # other file call (the FUSE unlink hole). The mount is writable, so
    # only the policy can be what refuses.
    ws = Workspace(
        {"/data": (RAMVFS(), MountMode.WRITE)},
        mode=MountMode.WRITE,
        policies=[PinLinks()],
    )
    await ws.shell("echo b > /data/f.txt")
    await ws.shell("ln -s f.txt /data/lk.pinned")
    with pytest.raises(PermissionError):
        await ws.vfs.unlink("/data/lk.pinned")
    assert ws.namespace.is_link("/data/lk.pinned")


@pytest.mark.asyncio
async def test_rm_of_a_link_on_read_turf_answers_like_a_backend_file():
    # Byte for byte what `rm` of a backend file on the same grant
    # answers, because one grant must not describe itself two ways
    # depending on whether the name it stopped was a link.
    ws = _ws()
    await ws.shell("echo b > /data/f.txt; ln -s f.txt /data/lk")
    ws.create_session("agent", mounts={"/data/": "read"})
    r = await ws.shell("rm /data/lk", session_id="agent")
    assert r.exit_code == 1
    assert r.stderr == (
        b"rm: cannot remove '/data/lk': Read-only file system\n"
    )
    assert ws.namespace.is_link("/data/lk")


@pytest.mark.asyncio
async def test_ln_and_mv_answer_a_read_grant_per_operand():
    # Same rule for the other two verbs that write the node table: `ln`
    # answers as `touch` does on a read-only mount, and `mv` as `mv` of
    # a backend file does, in GNU's per-operand voice.
    ws = _ws()
    await ws.shell("echo b > /data/f.txt; ln -s f.txt /data/lk")
    ws.create_session("agent", mounts={"/data/": "read"})
    ln = await ws.shell("ln -s f.txt /data/lk2", session_id="agent")
    mv = await ws.shell("mv /data/lk /data/lk3", session_id="agent")
    assert ln.exit_code == 1
    assert ln.stderr == (
        b"ln: failed to create symbolic link '/data/lk2': "
        b"Read-only file system\n"
    )
    assert mv.exit_code == 1
    assert mv.stderr == (
        b"mv: cannot move '/data/lk' to '/data/lk3': Read-only file system\n"
    )
    assert ws.namespace.readlink("/data/lk") == "f.txt"


@pytest.mark.asyncio
async def test_a_refused_link_operand_keeps_the_rest_going():
    # GNU rm reports the operand it could not remove and removes the
    # others; the backend half of the line still runs and the exit code
    # says something failed.
    ws = _ws()
    await ws.shell("echo b > /data/f.txt")
    await ws.shell("ln -s f.txt /data/lk.pinned; ln -s f.txt /data/lk")
    _refusing(ws, "unlink", "/data/lk.pinned")
    r = await ws.shell("rm /data/lk.pinned /data/lk /data/f.txt")
    assert r.exit_code == 1
    assert r.stderr == (
        b"rm: cannot remove '/data/lk.pinned': Permission denied\n"
    )
    assert ws.namespace.is_link("/data/lk.pinned")
    assert not ws.namespace.is_link("/data/lk")
    assert (await ws.shell("test -e /data/f.txt; echo $?")).stdout == b"1\n"


@pytest.mark.asyncio
async def test_rm_f_still_reports_a_mode_refusal():
    # GNU -f silences only the absent; EROFS is not ENOENT.
    ws = _ws()
    await ws.shell("echo b > /data/f.txt; ln -s f.txt /data/lk")
    ws.create_session("agent", mounts={"/data/": "read"})
    r = await ws.shell("rm -f /data/lk", session_id="agent")
    assert r.exit_code == 1
    assert r.stderr == (
        b"rm: cannot remove '/data/lk': Read-only file system\n"
    )


@pytest.mark.asyncio
async def test_rm_f_silences_a_hidden_link():
    # A hidden link answers ENOENT (the no-name-leak rule), which is
    # exactly what -f silences; without -f the miss is reported.
    ws = _ws()
    await ws.shell("echo b > /data/f.txt; ln -s f.txt /data/lk.sec")
    ws.create_session("agent", profile={"paths": {"hide": ["/data/lk.sec"]}})
    silent = await ws.shell("rm -f /data/lk.sec", session_id="agent")
    loud = await ws.shell("rm /data/lk.sec", session_id="agent")
    assert silent.exit_code == 0
    assert silent.stderr in (None, b"")
    assert loud.exit_code == 1
    assert loud.stderr == (
        b"rm: cannot remove '/data/lk.sec': No such file or directory\n"
    )
    assert ws.namespace.is_link("/data/lk.sec")


@pytest.mark.asyncio
async def test_test_and_cd_see_no_hidden_link():
    # test and cd resolve through the session's links, so a hidden link
    # is no link and leads nowhere, as every other command meets it.
    ws = _ws()
    await ws.shell(
        "echo b > /data/f.txt; mkdir /data/d; "
        "ln -s f.txt /data/lk.sec; ln -s d /data/dl.sec"
    )
    ws.create_session(
        "agent", profile={"paths": {"hide": ["/data/lk.sec", "/data/dl.sec"]}}
    )
    probe = "test -L /data/lk.sec; echo $?; [ -e /data/lk.sec ]; echo $?"
    hidden = await ws.shell(probe, session_id="agent")
    cd = await ws.shell("cd /data/dl.sec", session_id="agent")
    assert hidden.stdout == b"1\n1\n"
    assert cd.exit_code == 1
    assert cd.stderr == b"bash: cd: /data/dl.sec: No such file or directory\n"
    seen = await ws.shell(f"{probe}; cd /data/dl.sec && pwd")
    assert seen.stdout == b"0\n0\n/data/dl.sec\n"


@pytest.mark.asyncio
async def test_every_refused_operand_speaks_in_one_voice():
    # GNU reports each operand it could not remove, so a read grant is
    # one line per operand -- a link the node table refuses and a
    # backend file the dispatcher refuses say the same thing.
    ws = _ws()
    await ws.shell("echo b > /data/f.txt")
    await ws.shell("ln -s f.txt /data/l1; ln -s f.txt /data/l2")
    ws.create_session("agent", mounts={"/data/": "read"})
    for operands in (["l1", "l2"], ["l1", "f.txt"], ["l1", "l2", "f.txt"]):
        line = "rm " + " ".join(f"/data/{name}" for name in operands)
        r = await ws.shell(line, session_id="agent")
        assert r.exit_code == 1, line
        assert r.stderr == b"".join(
            f"rm: cannot remove '/data/{name}': Read-only file system\n".encode()
            for name in operands
        ), line
    assert ws.namespace.is_link("/data/l1")
    assert ws.namespace.is_link("/data/l2")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "option", ["-n", "--update=none", "--update=none-fail"]
)
@pytest.mark.parametrize(
    "operands",
    [
        "/data/l /data/dst",
        "/data/l /data/a /data/dst",
        "-t /data/dst /data/l /data/a",
    ],
)
async def test_mv_link_obeys_overwrite_policy(option, operands):
    ws = _ws()
    await ws.shell(
        "mkdir /data/dst; echo old > /data/dst/l; "
        "ln -s missing /data/l; echo a > /data/a"
    )
    result = await ws.shell(f"mv {option} {operands}")
    assert result.exit_code == (1 if option == "--update=none-fail" else 0)
    assert (await ws.shell("cat /data/dst/l")).stdout == b"old\n"
    assert (await ws.shell("readlink /data/l")).stdout == b"missing\n"


@pytest.mark.asyncio
async def test_prepare_mv_follows_a_linked_destination_for_many_sources():
    # GNU stats the destination of `mv a b dlink` through the link, so the
    # generic mv is handed the directory it names (coreutils 9.7), and
    # each source lands inside it.
    ws = _ws()
    await ws.shell(
        "mkdir -p /data/dst; printf a > /data/a; printf b > /data/b"
    )
    await ws.shell("ln -s /data/dst /data/dlink")
    items: list[str | PathSpec] = [
        PathSpec.from_str_path("/data/a"),
        PathSpec.from_str_path("/data/b"),
        PathSpec(
            vfs_path="dlink",
            virtual="/data/dlink",
            directory="/data/",
            raw_path="dlink",
        ),
    ]
    rewritten, early = await prepare_mv(
        ws.namespace, ws.dispatch, items, ("a", "b", "dlink"), "/data"
    )
    assert early is None
    dst = rewritten[-1]
    assert isinstance(dst, PathSpec)
    assert (dst.virtual, dst.raw_path) == ("/data/dst", "dlink")


@pytest.mark.asyncio
async def test_prepare_mv_leaves_link_sources_for_the_generic():
    # A link has no backend entry for the generic mv to move, so a
    # several-source mv lost it (`mv: cannot stat 'l'`); the namespace
    # renames it into the directory and the rest go to the backend.
    ws = _ws()
    await ws.shell("mkdir -p /data/dst; printf a > /data/a")
    await ws.shell("ln -s /data/a /data/l")
    link = PathSpec.from_str_path("/data/l")
    items: list[str | PathSpec] = [
        link,
        PathSpec.from_str_path("/data/a"),
        PathSpec.from_str_path("/data/dst"),
    ]
    rewritten, early = await prepare_mv(
        ws.namespace,
        ws.dispatch,
        items,
        ("/data/l", "/data/a", "/data/dst"),
        "/",
    )
    assert early is None
    assert link in rewritten
    assert not ws.namespace.is_link("/data/dst/l")
    assert ws.namespace.is_link("/data/l")


@pytest.mark.asyncio
async def test_prepare_mv_leaves_a_refused_destination_to_the_generic():
    # A store refusing the destination's stat ended the line; the generic
    # mv names it through its own stat (`cannot stat 'b'`).
    ws = _ws()
    await ws.shell("printf a > /data/a; ln -s /data/a /data/l")
    real = ws.dispatch

    async def refusing(op: str, path: PathSpec, **kwargs: Any) -> Any:
        if op == "stat" and path.virtual == "/data/b":
            raise PermissionError(errno.EACCES, "Permission denied", "b")
        return await real(op, path, **kwargs)

    items: list[str | PathSpec] = [
        PathSpec.from_str_path("/data/a"),
        PathSpec.from_str_path("/data/b"),
    ]
    rewritten, early = await prepare_mv(
        ws.namespace, refusing, items, ("/data/a", "/data/b"), "/"
    )
    assert (rewritten, early) == (items, None)


class SealedTarget(Policy):
    async def pre_vfs(self, ctx: VfsContext) -> Action | None:
        if ctx.call.name == "stat" and ctx.path.virtual == "/data/sealed":
            return Deny("sealed")
        return None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line, check, shown",
    [
        ("mv /data/z /data/dlink", "cat /data/dlink", b"z"),
        ("mv /data/sl /data/dlink", "readlink /data/dlink", b"z\n"),
        ("mv -T /data/z /data/dlink", "cat /data/dlink", b"z"),
    ],
    ids=["file", "link", "no-target-directory"],
)
async def test_mv_replaces_a_link_whose_target_it_may_not_stat(
    line, check, shown
):
    # GNU 9.7: a destination it cannot stat is no directory, so the move
    # renames over the link and exits 0, whatever the source is.
    ws = Workspace(
        {"/data": (RAMVFS(), MountMode.WRITE)},
        mode=MountMode.WRITE,
        policies=[SealedTarget()],
    )
    await ws.shell(
        "printf z > /data/z; printf s > /data/sealed; "
        "ln -s /data/sealed /data/dlink; ln -s z /data/sl"
    )
    r = await ws.shell(line)
    assert (r.exit_code, r.stderr or b"") == (0, b"")
    assert (await ws.shell(check)).stdout == shown


@pytest.mark.asyncio
@pytest.mark.parametrize("skip", [False, True])
async def test_partial_mv_only_reanchors_completed_sources(skip):
    ws = _ws()
    await ws.shell(
        "mkdir -p /data/src /data/out/src; echo x > /data/src/f; "
        "ln -s f /data/src/l"
    )
    result = await ws.shell(
        f"mv {'-n' if skip else ''} /data/missing /data/src /data/out"
    )
    assert result.exit_code == 1
    kept = "/data/src/l" if skip else "/data/out/src/l"
    absent = "/data/out/src/l" if skip else "/data/src/l"
    assert (await ws.shell(f"cat {kept}")).stdout == b"x\n"
    assert not ws.namespace.is_link(absent)


@pytest.mark.asyncio
async def test_a_link_below_a_renamed_directory_moves_with_it():
    ws = _ws()
    await ws.shell("mkdir -p /data/d; printf 't\\n' > /data/t")
    await ws.shell("ln -s /data/t /data/d/link")
    assert (await ws.shell("mv /data/d /data/moved")).exit_code == 0
    read = await ws.shell("readlink /data/moved/link")
    assert read.exit_code == 0
    assert read.stdout == b"/data/t\n"
    assert (await ws.shell("cat /data/moved/link")).stdout == b"t\n"
    assert (await ws.shell("readlink /data/d/link")).exit_code != 0


@pytest.mark.asyncio
async def test_ln_refuses_a_slashed_link_name_that_is_not_there():
    # Pinned on coreutils 9.7: symlink(2) and link(2) answer `missing/`
    # with ENOENT and create nothing, the hard-link line naming its
    # source; a directory takes the link inside it as before, and a file
    # behind the slash is still the dispatcher's "File exists".
    ws = _ws()
    await ws.shell(
        "printf hi > /data/a.txt; printf y > /data/reg; mkdir -p /data/d"
    )
    for line, wording in (
        (
            "ln -s /data/a.txt /data/missing/",
            "ln: failed to create symbolic link '/data/missing/': "
            "No such file or directory\n",
        ),
        (
            "ln -sT /data/a.txt /data/missing/",
            "ln: failed to create symbolic link '/data/missing/': "
            "No such file or directory\n",
        ),
        (
            "ln /data/a.txt /data/missing/",
            "ln: failed to create hard link '/data/missing/' => "
            "'/data/a.txt': No such file or directory\n",
        ),
        (
            "ln -s /data/a.txt /data/d/missing/",
            "ln: failed to create symbolic link '/data/d/missing/': "
            "No such file or directory\n",
        ),
        (
            "ln -s /data/a.txt /data/reg/",
            "ln: failed to create symbolic link '/data/reg/': File exists\n",
        ),
    ):
        r = await ws.shell(line)
        assert r.exit_code == 1, line
        assert r.stderr == wording.encode(), line
    assert (await ws.shell("test -e /data/missing")).exit_code == 1
    assert (await ws.shell("test -e /data/d/missing")).exit_code == 1
    assert not ws.namespace.is_link("/data/missing")
    r = await ws.shell("ln -s /data/a.txt /data/d/ && readlink /data/d/a.txt")
    assert r.exit_code == 0
    assert r.stdout == b"/data/a.txt\n"


@pytest.mark.asyncio
async def test_ln_settles_a_slashed_name_before_force_or_backup_touch_it():
    # Pinned on coreutils 9.7: -f and -b lstat the link name first, and
    # `reg/` over a file (or a link to one) is `failed to access 'reg/':
    # Not a directory`, so the file is neither unlinked nor renamed aside.
    ws = _ws()
    await ws.shell(
        "printf hi > /data/a.txt; printf y > /data/reg;"
        " ln -s /data/reg /data/flink"
    )
    for line in (
        "ln -sf /data/a.txt /data/reg/",
        "ln -sb /data/a.txt /data/reg/",
        "ln -f /data/a.txt /data/reg/",
        "ln -b /data/a.txt /data/reg/",
        "ln -sf /data/a.txt /data/flink/",
    ):
        r = await ws.shell(line)
        assert r.exit_code == 1, line
        target = line.split()[-1]
        assert (
            r.stderr
            == (f"ln: failed to access '{target}': Not a directory\n").encode()
        ), line
    assert (await ws.shell("cat /data/reg")).stdout == b"y"
    assert (await ws.shell("test -e /data/reg~")).exit_code == 1
    assert ws.namespace.readlink("/data/flink") == "/data/reg"
    r = await ws.shell("ln -sf /data/a.txt /data/missing/")
    assert r.stderr == (
        b"ln: failed to create symbolic link '/data/missing/': "
        b"No such file or directory\n"
    )
    assert (await ws.shell("test -e /data/missing")).exit_code == 1


@pytest.mark.asyncio
async def test_mv_of_a_link_refuses_a_slashed_destination():
    # Pinned on coreutils 9.7: rename(2) never follows the source, so a
    # link is not a directory whatever it points at; `mv dlnk missing/`
    # refuses at the rename and `mv dlnk reg/` at the destination's stat,
    # and the link stays where it was either way.
    ws = _ws()
    await ws.shell(
        "mkdir -p /data/sd /data/e; printf y > /data/reg;"
        " ln -s /data/sd /data/dlnk"
    )
    r = await ws.shell("mv /data/dlnk /data/missing/")
    assert r.exit_code == 1
    assert r.stderr == (
        b"mv: cannot move '/data/dlnk' to '/data/missing/': Not a directory\n"
    )
    r = await ws.shell("mv /data/dlnk /data/reg/")
    assert r.exit_code == 1
    assert r.stderr == b"mv: cannot stat '/data/reg/': Not a directory\n"
    r = await ws.shell("mv /data/dlnk /data/nodir/name/")
    assert r.exit_code == 1
    assert r.stderr == (
        b"mv: cannot move '/data/dlnk' to '/data/nodir/name/': "
        b"No such file or directory\n"
    )
    assert ws.namespace.readlink("/data/dlnk") == "/data/sd"
    assert (await ws.shell("test -e /data/missing")).exit_code == 1
    assert (await ws.shell("cat /data/reg")).stdout == b"y"
    r = await ws.shell("mv /data/dlnk /data/e/ && readlink /data/e/dlnk")
    assert r.exit_code == 0
    assert r.stdout == b"/data/sd\n"


@pytest.mark.asyncio
@pytest.mark.parametrize("source", ["missing", "a.txt", "loop"])
async def test_mv_link_into_loop_reports_destination_and_keeps_source(source):
    ws = _ws()
    await ws.shell(
        f"cd /data; echo hello > a.txt; ln -s loop loop; ln -s {source} src"
    )
    result = await ws.shell("cd /data; mv src loop/child")
    assert result.exit_code == 1
    assert result.stderr == (
        b"mv: cannot stat 'loop/child': Too many levels of symbolic links\n"
    )
    assert ws.namespace.is_link("/data/src")


@pytest.mark.asyncio
async def test_follow_paths_collapses_a_relative_target_and_keeps_the_name():
    # `../a` climbs from the link's own directory; left uncollapsed the
    # followed path no longer matched the word that spelled it, and every
    # command named the operand `/data/sub/../a`.
    ws = _ws()
    await ws.shell(
        "mkdir -p /data/sub && printf 'x\\n' > /data/a && "
        "ln -s ../a /data/sub/al && ln -s ../nowhere /data/sub/d"
    )
    followed = follow_paths(
        ws.namespace, [PathSpec.from_str_path("/data/sub/al")]
    )
    assert followed[0].virtual == "/data/a"
    r = await ws.shell("cd /data && wc -c sub/al && cat sub/d")
    assert await r.materialize_stdout() == b"2 sub/al\n"
    assert await r.materialize_stderr() == (
        b"cat: sub/d: No such file or directory\n"
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", [None, "read", "unlink", "symlink"])
async def test_crossmount_mv_preserves_tree_links_and_partial_transfers(
    failure,
):
    ws = Workspace(
        {
            "/data": SealedReads() if failure == "read" else RAMVFS(),
            "/other": RAMVFS(),
        },
        mode=MountMode.WRITE,
    )
    setup = await ws.shell(
        "mkdir -p /data/tree/sub; printf kept > /data/tree/sub/file; "
        "printf sealed > /data/tree/file.sealed; "
        "ln -s sub /data/tree/dir; ln -s sub/file /data/tree/file; "
        "ln -s missing /data/tree/dangling; ln -s loop /data/tree/loop; "
        "ln -s sub /data/tree/link.pinned"
    )
    assert setup.exit_code == 0
    if failure == "unlink":
        _refusing(ws, "unlink", "/data/tree/link.pinned")
    if failure == "symlink":
        _refusing(ws, "symlink", "/other/tree/loop")
    result = await ws.shell("mv /data/tree /other/tree")
    assert result.exit_code == (0 if failure is None else 1)
    expected_error = {
        None: None,
        "read": (
            b"mv: cannot open '/data/tree/file.sealed' for reading: "
            b"Permission denied\n"
        ),
        "unlink": b"mv: cannot remove '/data/tree/link.pinned': Permission denied\n",
        "symlink": (
            b"mv: cannot create symbolic link '/other/tree/loop': "
            b"Permission denied\n"
        ),
    }
    assert result.stderr == expected_error[failure]
    links = {
        "dir": "sub",
        "file": "sub/file",
        "dangling": "missing",
        "loop": "loop",
        "link.pinned": "sub",
    }
    for name, target in links.items():
        if failure == "symlink" and name == "loop":
            assert not ws.namespace.is_link(f"/other/tree/{name}")
        else:
            assert ws.namespace.readlink(f"/other/tree/{name}") == target
        assert ws.namespace.is_link(f"/data/tree/{name}") == (
            failure in ("read", "symlink")
            or failure == "unlink"
            and name == "link.pinned"
        )
    assert (
        await ws.shell("cat /other/tree/dir/file /other/tree/file")
    ).stdout == b"keptkept"
    assert (await ws.shell("test -e /data/tree")).exit_code == (
        1 if failure is None else 0
    )
    assert (await ws.shell("test -e /data/tree/sub/file")).exit_code == (
        0 if failure in ("read", "symlink") else 1
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("destination", ["/data", "/other"])
async def test_mv_directory_backup_keeps_links_only_in_backup(destination):
    ws = Workspace(
        {"/data": RAMVFS(), "/other": RAMVFS()}, mode=MountMode.WRITE
    )
    setup = await ws.shell(
        f"mkdir -p /data/src {destination}/dst/sub; "
        f"printf old > {destination}/dst/sub/file; "
        f"ln -s sub {destination}/dst/link; "
        f"ln -s missing {destination}/dst/dangling; "
        "printf new > /data/src/new"
    )
    assert setup.exit_code == 0
    result = await ws.shell(f"mv -bT /data/src {destination}/dst")
    assert result.exit_code == 0
    assert result.stderr is None
    assert ws.namespace.readlink(f"{destination}/dst~/link") == "sub"
    assert ws.namespace.readlink(f"{destination}/dst~/dangling") == "missing"
    assert not ws.namespace.is_link(f"{destination}/dst/link")
    assert not ws.namespace.is_link(f"{destination}/dst/dangling")
    assert (
        await ws.shell(
            f"cat {destination}/dst/new {destination}/dst~/link/file"
        )
    ).stdout == b"newold"
    assert (await ws.shell(f"test -e {destination}/dst/sub")).exit_code == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("destination", ["/data", "/other"])
@pytest.mark.parametrize("source_link", [False, True])
@pytest.mark.parametrize("backup_target", ["safe", "missing", "dst~", "dir"])
async def test_cp_backup_replaces_link_without_touching_its_referent(
    destination, source_link, backup_target
):
    ws = Workspace(
        {"/data": RAMVFS(), "/other": RAMVFS()}, mode=MountMode.WRITE
    )
    setup = await ws.shell(
        f"mkdir -p {destination}/dir; printf safe > {destination}/safe; "
        f"printf child > {destination}/dir/file; "
        f"printf old > {destination}/dst; "
        f"ln -s {backup_target} {destination}/dst~; "
        + (
            "ln -s absent /data/src"
            if source_link
            else "printf new > /data/src"
        )
    )
    assert setup.exit_code == 0
    result = await ws.shell(f"cp -Pb /data/src {destination}/dst")
    assert result.exit_code == 0
    assert result.stderr is None
    assert not ws.namespace.is_link(f"{destination}/dst~")
    assert (
        await ws.shell(
            f"cat {destination}/dst~ {destination}/safe {destination}/dir/file"
        )
    ).stdout == b"oldsafechild"
    assert (await ws.shell(f"test -e {destination}/missing")).exit_code == 1
    if source_link:
        assert ws.namespace.readlink(f"{destination}/dst") == "absent"
    else:
        assert (await ws.shell(f"cat {destination}/dst")).stdout == b"new"


@pytest.mark.asyncio
@pytest.mark.parametrize("source_link", [False, True])
async def test_cp_refused_backup_unlink_preserves_destination(source_link):
    ws = Workspace(
        {"/data": RAMVFS(), "/other": RAMVFS()}, mode=MountMode.WRITE
    )
    setup = await ws.shell(
        "printf safe > /other/safe; printf old > /other/dst; "
        "ln -s safe /other/dst.pinned; "
        + (
            "ln -s absent /data/src"
            if source_link
            else "printf new > /data/src"
        )
    )
    assert setup.exit_code == 0
    _refusing(ws, "unlink", "/other/dst.pinned")
    result = await ws.shell("cp -Pb --suffix=.pinned /data/src /other/dst")
    assert result.exit_code == 1
    assert result.stderr == (
        b"cp: cannot backup '/other/dst': Permission denied\n"
    )
    assert ws.namespace.readlink("/other/dst.pinned") == "safe"
    assert (await ws.shell("cat /other/dst /other/safe")).stdout == b"oldsafe"
    assert (
        await ws.shell("test -e /data/src || test -L /data/src")
    ).exit_code == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("command", ["cp -P", "mv"])
@pytest.mark.parametrize("destination", ["/data", "/other"])
async def test_numbered_backup_counts_namespace_links(command, destination):
    ws = Workspace(
        {"/data": RAMVFS(), "/other": RAMVFS()}, mode=MountMode.WRITE
    )
    setup = await ws.shell(
        f"printf old > {destination}/dst; "
        f"ln -s missing {destination}/dst.~1~; printf new > /data/src"
    )
    assert setup.exit_code == 0
    result = await ws.shell(
        f"{command} --backup=numbered /data/src {destination}/dst"
    )
    assert result.exit_code == 0
    assert ws.namespace.readlink(f"{destination}/dst.~1~") == "missing"
    assert (
        await ws.shell(f"cat {destination}/dst {destination}/dst.~2~")
    ).stdout == b"newold"


_LOOPS = (
    "cd /data && ln -s l2 l1 && ln -s l3 l2 && ln -s l4 l3 && ln -s l1 l4"
    " && ln -s m2 m1 && ln -s m3 m2 && ln -s m1 m3"
)


@pytest.mark.asyncio
async def test_realpath_and_readlink_refuse_a_loop():
    ws = _ws()
    await ws.shell(_LOOPS)
    result = await ws.shell(
        "cd /data; realpath /data/l1; echo rc=$?; realpath -e l1; echo rc=$?;"
        " readlink -f l2; echo rc=$?; readlink -e l2; echo rc=$?"
    )
    assert await result.stdout_str() == "rc=1\nrc=1\nrc=1\nrc=1\n"
    assert await result.stderr_str() == (
        "realpath: /data/l1: Too many levels of symbolic links\n"
        "realpath: l1: Too many levels of symbolic links\n"
    )


@pytest.mark.asyncio
async def test_missing_mode_keeps_the_21st_link_of_a_loop():
    # GNU 9.7 keeps l((20 mod k) + 1) of a loop of k links: l1 of four
    # (from l1), l3 of four (from l3), m3 of three.
    ws = _ws()
    await ws.shell(_LOOPS)
    result = await ws.shell(
        "cd /data; realpath -m /data/l1/x /data/m1/x; readlink -m l3"
    )
    assert await result.stdout_str() == "/data/l1/x\n/data/m3/x\n/data/l3\n"


@pytest.mark.asyncio
async def test_missing_mode_keeps_the_first_link_of_a_loop_behind_a_chain():
    # GNU 9.7: behind 25 links (rt1 -> ... -> rt25 -> rq1) the loop's own
    # first link stays; behind 19 (from rt7) the 21st step lands on rq2.
    ws = _ws()
    await ws.shell(
        "cd /data && ln -s rq2 rq1 && ln -s rq3 rq2 && ln -s rq1 rq3"
        " && ln -s rq1 rt25 && for i in $(seq 24 -1 1); do"
        " ln -s rt$((i+1)) rt$i; done"
    )
    result = await ws.shell(
        "cd /data; realpath -m rt1/x; readlink -m rt7; readlink -m"
        " rt1/../rt3/y; realpath rt1; echo rc=$?"
    )
    assert await result.stdout_str() == (
        "/data/rq1/x\n/data/rq2\n/data/rq1/y\nrc=1\n"
    )
    assert await result.stderr_str() == (
        "realpath: rt1: Too many levels of symbolic links\n"
    )


@pytest.mark.asyncio
async def test_realpath_follows_a_long_chain_up_to_the_link_limit():
    # GNU 9.7 follows a chain of any length; here 1,024 links resolve and
    # the 1,025th is refused as a loop, as is a link that grows its path.
    ws = _ws()
    await ws.shell(
        "cd /data && echo z > c0 && for i in $(seq 1025); do"
        " ln -s c$((i-1)) c$i; done && ln -s g/x g"
    )
    result = await ws.shell(
        "cd /data; realpath c300 c1024; readlink -f /data/c300;"
        " realpath -m c300/x; realpath c1025 g; echo rc=$?"
    )
    assert await result.stdout_str() == (
        "/data/c0\n/data/c0\n/data/c0\n/data/c0/x\nrc=1\n"
    )
    assert await result.stderr_str() == (
        "realpath: c1025: Too many levels of symbolic links\n"
        "realpath: g: Too many levels of symbolic links\n"
    )
