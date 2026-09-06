import asyncio
from types import SimpleNamespace

import pytest

from mirage.commands.config import ExecContext
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import spec_flag_names
from mirage.io import IOResult
from mirage.ops.types import NamespaceView
from mirage.resource.ram import RAMResource
from mirage.types import FileStat, FileType, MountMode, PathSpec
from mirage.workspace import Workspace
from mirage.workspace.executor.fanout import (_adjust_depth_texts,
                                              _fan_out_traversal,
                                              _filter_under_prefixes,
                                              _synthesize_find_mount_entries)


def _shown_mount_entries(target, descendants, texts, raw, stat_path=None):
    return "\n".join(p.raw_path
                     for p in asyncio.run(
                         _synthesize_find_mount_entries(
                             target, descendants, texts, raw, stat_path)))


class TraversalMount:

    def __init__(self,
                 prefix: str,
                 output: bytes = b"",
                 exit_code: int = 0,
                 error: Exception | None = None) -> None:
        self.prefix = prefix
        self.output = output
        self.exit_code = exit_code
        self.error = error
        self.command_limits = {}
        self.calls: list[ExecContext] = []

    async def execute_cmd(self,
                          name,
                          paths,
                          texts,
                          flags,
                          context=ExecContext()):
        self.calls.append(context)
        if self.error is not None:
            raise self.error
        stderr = b"backend failed\n" if self.exit_code else None
        return self.output, IOResult(
            exit_code=self.exit_code,
            stderr=stderr,
            matched_runs=[[
                PathSpec(
                    virtual=row, directory=row, resource_path="", raw_path=row)
                for row in self.output.decode().splitlines()
            ]] if name == "find" else None)


class TraversalRegistry:

    def __init__(self, descendants: list[TraversalMount]) -> None:
        self._descendants = descendants

    def descendant_mounts(self, path: str) -> list[TraversalMount]:
        return self._descendants


def _mounts(*prefixes):
    return [SimpleNamespace(prefix=p) for p in prefixes]


def test_synthesize_no_expression_emits_all():
    desc = _mounts("/ram/", "/disk/")
    assert _shown_mount_entries("/", desc, [], "/") == "/ram\n/disk"


def test_synthesize_positive_name():
    desc = _mounts("/ram/", "/disk/")
    assert _shown_mount_entries("/", desc, ["-name", "ram"], "/") == "/ram"


def test_synthesize_honors_not():
    desc = _mounts("/ram/", "/disk/", "/notes/")
    out = _shown_mount_entries("/", desc, ["-not", "-name", "ram"], "/")
    assert out == "/disk\n/notes"


def test_synthesize_honors_or():
    desc = _mounts("/ram/", "/disk/", "/notes/")
    out = _shown_mount_entries("/", desc,
                               ["-name", "ram", "-o", "-name", "disk"], "/")
    assert out == "/ram\n/disk"


def test_synthesize_type_file_excludes_mount_dirs():
    desc = _mounts("/ram/", "/disk/")
    assert _shown_mount_entries("/", desc, ["-type", "f"], "/") == ""


def test_synthesize_type_dir_includes_mount_dirs():
    desc = _mounts("/ram/", "/disk/")
    assert _shown_mount_entries("/", desc, ["-type", "d"],
                                "/") == "/ram\n/disk"


def test_synthesize_maxdepth_window():
    desc = _mounts("/ram/", "/a/b/")
    assert _shown_mount_entries("/", desc, ["-maxdepth", "1"],
                                "/") == "/ram\n/a"


def test_synthesize_namespace_ancestors():
    desc = _mounts("/ghost/very/deep/")
    assert _shown_mount_entries("/", desc, [],
                                "/") == "/ghost\n/ghost/very\n/ghost/very/deep"
    assert _shown_mount_entries("/ghost", desc, [],
                                "/ghost") == "/ghost/very\n/ghost/very/deep"


def test_synthesize_shared_ancestor_once():
    desc = _mounts("/a/b/", "/a/c/")
    assert _shown_mount_entries("/", desc, [], "/") == "/a\n/a/b\n/a/c"


def test_adjust_depth_texts_reduces_maxdepth_by_delta():
    out = _adjust_depth_texts(["-maxdepth", "3", "-name", "x"], "/",
                              "/data/sub")
    assert out == ["-maxdepth", "1", "-name", "x"]


def test_adjust_depth_texts_clamps_mindepth_at_zero():
    out = _adjust_depth_texts(["-mindepth", "1"], "/", "/data")
    assert out == ["-mindepth", "0"]


def test_adjust_depth_texts_no_depth_tokens_unchanged():
    out = _adjust_depth_texts(["-name", "x", "-o", "-name", "y"], "/", "/data")
    assert out == ["-name", "x", "-o", "-name", "y"]


def test_adjust_depth_texts_same_mount_unchanged():
    assert _adjust_depth_texts(["-maxdepth", "3"], "/data",
                               "/data") == ["-maxdepth", "3"]


def test_maxdepth_applies_to_child_mount_depth_end_to_end():
    parent = RAMResource()
    child = RAMResource()
    child._store.dirs.add("/a")
    child._store.files["/a/b.txt"] = b"deep\n"
    ws = Workspace(resources={
        "/": (parent, MountMode.EXEC),
        "/data/": (child, MountMode.EXEC),
    }, )
    io = asyncio.run(ws.execute("find / -maxdepth 2"))
    out = (io.stdout if isinstance(io.stdout, bytes) else b"").decode()
    assert "/data/a" in out
    assert "/data/a/b.txt" not in out


def _nested_ghost_workspace() -> Workspace:
    parent = RAMResource()
    parent._store.files["/top.txt"] = b"hello\n"
    deep = RAMResource()
    deep._store.files["/leaf.txt"] = b"deep\n"
    return Workspace(
        resources={
            "/": (parent, MountMode.EXEC),
            "/ghost/very/deep/": (deep, MountMode.EXEC),
        })


def test_find_ls_renders_namespace_ancestor_rows():
    ws = _nested_ghost_workspace()
    io = asyncio.run(ws.execute("find / -ls"))
    assert io.exit_code == 0
    out = (io.stdout if isinstance(io.stdout, bytes) else b"").decode()
    rows = [
        line.rsplit("\t", 1)[-1].rsplit(" ", 1)[-1]
        for line in out.splitlines()
    ]
    assert "/ghost" in rows
    assert "/ghost/very" in rows
    assert "/ghost/very/deep" in rows


def test_find_delete_skips_namespace_ancestors():
    ws = _nested_ghost_workspace()

    async def scenario():
        io = await ws.execute("find / -delete")
        after = await ws.execute("find /")
        return io, after

    io, after = asyncio.run(scenario())
    assert io.exit_code == 0
    assert (io.stderr if isinstance(io.stderr, bytes) else b"") == b""
    out = (after.stdout if isinstance(after.stdout, bytes) else b"").decode()
    assert "/ghost/very/deep" in out
    assert "/top.txt" not in out
    assert "leaf.txt" not in out


def test_fanout_preserves_partial_failure_exit_code():
    primary = TraversalMount("/", output=b"root\n")
    child = TraversalMount("/data/", exit_code=1)
    path = PathSpec.from_str_path("/")
    _, io, _ = asyncio.run(
        _fan_out_traversal("tree", [path], [], {}, TraversalRegistry([child]),
                           primary, "/", "tree /", None))
    assert io.exit_code == 1
    assert io.stderr == b"backend failed\n"


def test_fanout_propagates_unexpected_backend_error():
    primary = TraversalMount("/", output=b"root\n")
    child = TraversalMount("/data/", error=RuntimeError("backend exploded"))
    path = PathSpec.from_str_path("/")
    with pytest.raises(RuntimeError, match="backend exploded"):
        asyncio.run(
            _fan_out_traversal("tree", [path], [], {},
                               TraversalRegistry([child]), primary, "/",
                               "tree /", None))


def test_filter_reads_du_paths_after_the_size_column():
    """du renders SIZE\\tPATH, so the path is the second field; reading
    the first kept every shadowed du row in the parent's output."""
    out = asyncio.run(
        _filter_under_prefixes(b"1000\t/base/inner\n1010\t/base\n",
                               ["/base/inner"], "du"))
    assert out == b"1010\t/base\n"


def test_filter_still_reads_find_and_grep_paths_from_the_front():
    out = asyncio.run(
        _filter_under_prefixes(b"/base/inner/x\n/base/y\n", ["/base/inner"],
                               "find"))
    assert out == b"/base/y\n"
    out = asyncio.run(
        _filter_under_prefixes(b"/base/inner/x:hit\n/base/y:hit\n",
                               ["/base/inner"], "grep"))
    assert out == b"/base/y:hit\n"


def _shadowed_workspace(top: int = 10, real: int = 7) -> Workspace:
    parent = RAMResource()
    parent._store.files["/top.txt"] = b"T" * top
    parent._store.dirs.add("/inner")
    parent._store.files["/inner/leftover.txt"] = b"S" * 1000
    child = RAMResource()
    child._store.files["/real.txt"] = b"R" * real
    return Workspace(
        resources={
            "/base/": (parent, MountMode.EXEC),
            "/base/inner/": (child, MountMode.EXEC),
        })


def _stdout(io) -> str:
    return (io.stdout if isinstance(io.stdout, bytes) else b"").decode()


def test_du_fanout_folds_the_child_mount_into_its_ancestors():
    """A nested mount's bytes belong to every directory above it.

    Pinned on coreutils 9.7 over a tmpfs mounted at the same spot:
    ``du --apparent-size -B1 base`` prints ``7 base/inner`` then
    ``17 base``, children before parents. Only ``-x``, which mirage does
    not implement, reports the parent's own 10. The 1000 shadowed bytes
    under the mount point count nowhere, in GNU or here.
    """
    ws = _shadowed_workspace()
    io = asyncio.run(ws.execute("du /base"))
    assert _stdout(io) == "7\t/base/inner\n17\t/base\n"


def test_du_a_fanout_hides_shadowed_leaves():
    ws = _shadowed_workspace()
    io = asyncio.run(ws.execute("du -a /base"))
    assert _stdout(io) == ("7\t/base/inner/real.txt\n"
                           "7\t/base/inner\n"
                           "10\t/base/top.txt\n"
                           "17\t/base\n")


def test_du_s_fanout_is_one_row_per_operand():
    """``-s`` is one total per argument, mount boundary or not (GNU 9.7
    prints the single row ``17 base``)."""
    ws = _shadowed_workspace()
    io = asyncio.run(ws.execute("du -s /base"))
    assert _stdout(io) == "17\t/base\n"


def test_du_c_fanout_prints_one_total_across_the_mounts():
    """GNU ``du -c`` prints exactly one grand total covering everything it
    walked. Pinned on coreutils 9.7 over a tmpfs mounted at the same spot:
    ``du -c --apparent-size -B1 base`` reports ``7 base/inner``,
    ``17 base``, ``17 total``."""
    ws = _shadowed_workspace()
    io = asyncio.run(ws.execute("du -c /base"))
    assert _stdout(io) == "7\t/base/inner\n17\t/base\n17\ttotal\n"


def test_du_separate_dirs_fanout_scopes_only_the_rows():
    """``-S`` reaches the merge, and the ``-c`` total stays recursive.

    Pinned on coreutils 9.7 over a tmpfs mounted at the same spot:
    ``du -bS base`` prints ``7 base/inner`` then ``10 base`` (the parent
    counts only the file sitting in it), and ``du -bSc base`` still ends
    ``17 total``.
    """
    ws = _shadowed_workspace()
    assert _stdout(asyncio.run(
        ws.execute("du -S /base"))) == "7\t/base/inner\n10\t/base\n"
    assert _stdout(asyncio.run(ws.execute(
        "du -Sc /base"))) == "7\t/base/inner\n10\t/base\n17\ttotal\n"


def test_du_separate_dirs_summarize_fanout():
    ws = _shadowed_workspace()
    assert _stdout(asyncio.run(ws.execute("du -Ss /base"))) == "10\t/base\n"
    assert _stdout(asyncio.run(
        ws.execute("du -Ssc /base"))) == "10\t/base\n17\ttotal\n"


def test_du_separate_dirs_all_fanout():
    ws = _shadowed_workspace()
    assert _stdout(asyncio.run(
        ws.execute("du -Sa /base"))) == ("7\t/base/inner/real.txt\n"
                                         "7\t/base/inner\n"
                                         "10\t/base/top.txt\n"
                                         "10\t/base\n")


def test_du_sc_fanout_prints_one_total():
    ws = _shadowed_workspace()
    io = asyncio.run(ws.execute("du -sc /base"))
    assert _stdout(io) == "17\t/base\n17\ttotal\n"


def test_du_ch_fanout_humanizes_the_total_once():
    # Summing each mount's already-humanized total would round twice and
    # report 2.2K; the sub-runs render exact bytes and only the merge
    # humanizes. 1025 bytes rather than 1500 because GNU rounds up: 1500
    # doubles to 3000, which single- and double-rounding both render
    # 3.0K, so those sizes could no longer tell the two apart.
    ws = _shadowed_workspace(top=1025, real=1025)
    io = asyncio.run(ws.execute("du -ch /base"))
    assert _stdout(io) == "1.1K\t/base/inner\n2.1K\t/base\n2.1K\ttotal\n"


def test_du_max_depth_prunes_printing_not_accounting():
    """``--max-depth`` prunes only what is printed: the mount's bytes
    still reach the operand row (GNU 9.7 prints ``10 base/sub`` and
    ``20 base`` for a mount two levels down)."""
    ws = _shadowed_workspace()
    io = asyncio.run(ws.execute("du --max-depth=0 /base"))
    assert _stdout(io) == "17\t/base\n"


def test_fanout_offers_the_namespace_view_to_every_sub_run():
    primary = TraversalMount("/", output=b"root\n")
    child = TraversalMount("/data/")
    path = PathSpec.from_str_path("/")
    view = NamespaceView()
    asyncio.run(
        _fan_out_traversal("find", [path], [], {},
                           TraversalRegistry([child]),
                           primary,
                           "/",
                           "find /",
                           None,
                           ns=view))
    for mount in (primary, child):
        assert mount.calls[0].ns is view


def _linked_workspace(nested: bool) -> Workspace:
    parent = RAMResource()
    parent._store.files["/top.txt"] = b"T" * 10
    parent._store.dirs.add("/inner")
    resources = {"/base/": (parent, MountMode.EXEC)}
    if nested:
        child = RAMResource()
        child._store.files["/real.txt"] = b"R" * 7
        resources["/base/inner/"] = (child, MountMode.EXEC)
    ws = Workspace(resources=resources)
    asyncio.run(ws.execute("ln -s /base/top.txt /base/link.txt"))
    return ws


def test_fanout_sub_runs_still_see_symlinks():
    """A nested mount is not a reason for a link to disappear. GNU lists
    ``/base/link.txt`` and sizes it at 13 (its target string) whether or
    not something is mounted at ``/base/inner``; the fan-out used to run
    every sub-command link-blind, so both rows vanished."""
    ws = _linked_workspace(nested=True)
    found = _stdout(asyncio.run(ws.execute("find /base")))
    assert "/base/link.txt" in found
    sized = _stdout(asyncio.run(ws.execute("du -a /base")))
    assert "13\t/base/link.txt\n" in sized
    # Post-order, siblings sorted: inner, link.txt, top.txt, then the
    # operand carrying all three (7 + 13 + 10).
    assert sized == ("7\t/base/inner/real.txt\n"
                     "7\t/base/inner\n"
                     "13\t/base/link.txt\n"
                     "10\t/base/top.txt\n"
                     "30\t/base\n")


def test_fanout_link_rows_match_the_unmounted_tree():
    plain = _stdout(
        asyncio.run(_linked_workspace(nested=False).execute("du -a /base")))
    assert "13\t/base/link.txt\n" in plain


def _spanning_workspace() -> Workspace:
    parent = RAMResource()
    parent._store.files["/top.txt"] = b"T" * 10
    parent._store.dirs.add("/inner")
    parent._store.files["/inner/leftover.txt"] = b"S" * 1000
    child = RAMResource()
    child._store.files["/real.txt"] = b"hit here\n"
    other = RAMResource()
    other._store.files["/o.txt"] = b"hit there\n"
    return Workspace(
        resources={
            "/base/": (parent, MountMode.EXEC),
            "/base/inner/": (child, MountMode.EXEC),
            "/other/": (other, MountMode.EXEC),
        })


def test_operands_spanning_mounts_still_fan_out_inside_each_operand():
    """A per-operand native run is single-mount, so an operand holding a
    nested mount used to report the parent's shadowed keys and none of the
    mount's own: `du /base` and `du /base /other` disagreed about the same
    tree. GNU counts a mounted filesystem in the same run either way."""
    ws = _spanning_workspace()
    io = asyncio.run(ws.execute("du -c /base /other"))
    assert _stdout(io) == ("9\t/base/inner\n"
                           "19\t/base\n"
                           "10\t/other\n"
                           "29\ttotal\n")


def test_du_fan_out_accounts_for_every_du_flag():
    """The du merge re-derives the whole tree centrally, so the sub-runs
    are asked with the presentation flags stripped and each one is then
    applied once, here. A flag nobody classified is neither stripped nor
    re-applied, so it silently does nothing across a nested mount, which
    is exactly how -S first shipped. Adding an option to du's spec fails
    this until it is sorted into one of the two lists."""
    # Applied centrally by _DuFanFlags, and neutralized in the sub-runs.
    central = {"a", "s", "c", "h", "max_depth", "separate_dirs"}
    # Chooses whether a run counts the symlinks on its own mount, which
    # is a per-run question; the merge only ever sees the rows.
    per_run = {"L", "P"}
    assert spec_flag_names(SPECS["du"]) == central | per_run


def test_operands_spanning_mounts_separate_dirs():
    """-S has to survive both fan-outs at once: the per-operand one that
    splits the operands across mounts, and the traversal one that folds
    `/base/inner` into `/base`. GNU (coreutils 9.7, tmpfs at the nested
    spot) scopes -S to each printed row and keeps the grand total
    recursive, so `/base` reports only `top.txt` while the total still
    covers every byte."""
    ws = _spanning_workspace()
    io = asyncio.run(ws.execute("du -Sc /base /other"))
    assert _stdout(io) == ("9\t/base/inner\n"
                           "10\t/base\n"
                           "10\t/other\n"
                           "29\ttotal\n")


def test_operands_spanning_mounts_fan_out_for_find_and_grep():
    ws = _spanning_workspace()
    found = _stdout(asyncio.run(ws.execute("find /base /other")))
    assert "/base/inner/real.txt" in found
    assert "/base/inner/leftover.txt" not in found
    hits = _stdout(asyncio.run(ws.execute("grep -r hit /base /other")))
    assert hits == ("/base/inner/real.txt:hit here\n"
                    "/other/o.txt:hit there\n")


def test_ls_r_drops_the_shadowed_group_whole():
    """`ls -R` renders `PATH:` then bare names, so a line filter that reads
    a path off every line drops the header and keeps the entries, landing
    the shadowed `leftover.txt` in `/base`'s own group. GNU (coreutils 9.7
    over a tmpfs at the same spot) prints the mounted directory's entries
    under its own header, one blank line between groups."""
    ws = _shadowed_workspace()
    io = asyncio.run(ws.execute("ls -R /base"))
    assert _stdout(io) == ("/base:\ninner\ntop.txt\n\n"
                           "/base/inner:\nreal.txt\n")


def _unnamed_mountpoint_workspace() -> Workspace:
    """A nested mount whose name the parent's backend does not hold.

    The mirror image of `_shadowed_workspace`, where the parent owns keys
    under `inner/` and so names the mountpoint from its own readdir
    whatever the namespace says.
    """
    parent = RAMResource()
    parent._store.files["/top.txt"] = b"T\n"
    child = RAMResource()
    child._store.files["/real.txt"] = b"hit\n"
    return Workspace(
        resources={
            "/base/": (parent, MountMode.EXEC),
            "/base/nested/": (child, MountMode.EXEC),
        })


def test_ls_r_lists_a_mountpoint_the_parent_backend_cannot_name():
    """A mount root is an ordinary directory entry of its parent.

    Pinned on coreutils 9.7 over a tmpfs mounted at `base/nested`:
    `ls -R base` prints `nested` in `base`'s own listing, then its group.
    `-R` used to withhold the namespace merge and leave the whole nested
    mount to the fan-out, which contributes the group but not the row, so
    the row went missing wherever the parent's backend held no key of
    that name.
    """
    ws = _unnamed_mountpoint_workspace()
    io = asyncio.run(ws.execute("ls -R /base"))
    assert _stdout(io) == ("/base:\nnested\ntop.txt\n\n"
                           "/base/nested:\nreal.txt\n")


def test_ls_r_lists_a_mountpoint_below_the_operand():
    """The merge is per directory listed, not per operand.

    Pinned on coreutils 9.7 over a tmpfs mounted at `base/sub/deep`:
    `deep` is a row of `base/sub`, which is a directory the parent's own
    backend serves.
    """
    parent = RAMResource()
    parent._store.dirs.add("/sub")
    parent._store.files["/sub/p.txt"] = b"P\n"
    child = RAMResource()
    child._store.files["/real.txt"] = b"hit\n"
    ws = Workspace(
        resources={
            "/base/": (parent, MountMode.EXEC),
            "/base/sub/deep/": (child, MountMode.EXEC),
        })
    io = asyncio.run(ws.execute("ls -R /base"))
    assert _stdout(io) == ("/base:\nsub\n\n"
                           "/base/sub:\ndeep\np.txt\n\n"
                           "/base/sub/deep:\nreal.txt\n")


def test_ls_r_lists_a_namespace_only_ancestor_under_a_served_root():
    """`/ghost` exists only because a mount lives below it, and `/` is
    served by a backend, so the withheld merge dropped the row and the
    two groups the walk renders from it. Only a mount root is left to the
    fan-out; the namespace-only directories above one are this walk's,
    because no other run renders them."""
    ws = _nested_ghost_workspace()
    io = asyncio.run(ws.execute("ls -R /"))
    assert _stdout(io).startswith("/:\ndev\nghost\ntop.txt\n\n"
                                  "/ghost:\nvery\n\n"
                                  "/ghost/very:\ndeep\n")


def test_ls_r_relative_operand_never_descends_the_mount_root():
    """A mount root is listed but not descended, so the shadowed group is
    never produced rather than produced and filtered.

    `_drop_shadowed_ls_groups` only recognizes an absolute header, so a
    relative operand printed `base/inner:` twice: once with the parent's
    shadowed `leftover.txt`, once with the mount's own listing. GNU 9.7
    prints the mounted directory once.
    """
    ws = _shadowed_workspace()
    io = asyncio.run(ws.execute("ls -R base"))
    assert _stdout(io) == ("base:\ninner\ntop.txt\n\n"
                           "base/inner:\nreal.txt\n")


def test_ls_r_renders_a_file_mount_as_one_row_and_no_group():
    """`/.bash_history` is a whole mount serving a single file.

    GNU (coreutils 9.7, `mount --bind` of one file onto another) lists a
    file that happens to be a mountpoint as an ordinary row of its
    parent -- no `/` under -F, no block of its own. The row used to be
    synthesized as a directory, and the fan-out ran a sub-run for the
    mount on top of it, so the same name arrived twice in two wrong
    shapes.
    """
    root = RAMResource()
    root._store.files["/top.txt"] = b"T\n"
    ws = Workspace(resources={"/": (root, MountMode.EXEC)})
    io = asyncio.run(ws.execute("ls -aRF /"))
    assert _stdout(io) == ("/:\n.bash_history\ndev/\ntop.txt\n\n"
                           "/dev:\nnull\nzero\n")


def test_tree_renders_one_document_across_a_nested_mount():
    """`tree` is not fanned out at all: one root line, one drawing, one
    summary, with the nested mount crossed inside the generic. Pinned on
    tree 2.2.1, which draws the mounted entries under the mount point and
    none of the ones it covers."""
    ws = _shadowed_workspace()
    io = asyncio.run(ws.execute("tree /base"))
    assert _stdout(io) == ("/base\n"
                           "|-- inner\n"
                           "|   `-- real.txt\n"
                           "`-- top.txt\n"
                           "\n"
                           "2 directories, 2 files\n")


def test_ls_r_spanning_mounts_separates_every_group():
    ws = _spanning_workspace()
    io = asyncio.run(ws.execute("ls -R /base /other"))
    assert _stdout(io) == ("/base:\ninner\ntop.txt\n\n"
                           "/base/inner:\nreal.txt\n\n"
                           "/other:\no.txt\n")


def test_synthesize_respells_entries_with_the_typed_base():
    desc = _mounts("/ram/", "/disk/")
    assert _shown_mount_entries("/", desc, [], ".") == "./ram\n./disk"
    assert _shown_mount_entries("/", desc, [], "") == "ram\ndisk"


def test_synthesize_honors_the_time_window():
    # -newermt lives beside the predicate tree; a mount point is held to
    # it like every real row, so a future cutoff drops it and a past one
    # keeps it, and a candidate that cannot be statted is dropped.
    mounts = [TraversalMount("/child")]
    stats = {
        "/child":
        FileStat(name="child",
                 type=FileType.DIRECTORY,
                 modified="2026-01-02T00:00:00Z")
    }

    async def stat_path(path):
        return stats.get(path)

    assert _shown_mount_entries("/", mounts, ["-newermt", "2099-01-01"], "/",
                                stat_path) == ""
    assert _shown_mount_entries("/", mounts, ["-newermt", "2020-01-01"], "/",
                                stat_path) == "/child"
    assert _shown_mount_entries("/", mounts, [], "/", stat_path) == "/child"
    stats.clear()
    assert _shown_mount_entries("/", mounts, ["-newermt", "2020-01-01"], "/",
                                stat_path) == ""
