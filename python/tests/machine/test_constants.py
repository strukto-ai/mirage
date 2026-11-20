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

import os
import pathlib
import stat
import subprocess
import sys
import time
import tomllib
import uuid

import pytest

from mirage.execution.types import MachinePid
from mirage.machine.constants import (
    ENCODE_OUTPUT,
    MIRAGE_FUSE_FIND,
    MIRAGE_FUSE_LINE,
    MIRAGE_FUSE_VERSION,
    MOUNT_GUARD,
    NOT_RUNNING_STATUS,
    PROCESS,
    PROGRAM_CHECK,
    RUN_PROGRAM_AT,
    RUN_WRAPPER_JOINED,
    SSHFS_LINE,
    SSHFS_OPTIONS,
    TOOLS_PATH,
    darwin_start,
    decode_output,
    is_run,
    machine_dir_line,
    mount_field,
    run_argv,
    run_done_mark,
    run_exit_mark,
    run_tag,
    scan_line,
    signal_line,
    stop_line,
    wrap_line,
)
from mirage.machine.handle import _parse_scan
from mirage.mount.constants import FSPROTO_VERSION

PRELUDE = '/bin/sh -c \'CDPATH= cd -- "$1" || exit 126; shift; exec "$@"\' sh '


@pytest.mark.parametrize(
    ("argv", "env", "cwd", "wrapped"),
    [
        (
            ("echo", "hi"),
            {"A": "1"},
            "/w",
            f"{PRELUDE}'/w' env 'A=1' 'echo' 'hi'",
        ),
        (
            ("/bin/sh", "-c", "echo 'hi'"),
            {"M": "two words"},
            "/a b",
            f"{PRELUDE}'/a b' env 'M=two words' '/bin/sh' '-c' "
            "'echo '\\''hi'\\'''",
        ),
        (("pwd",), {}, "/", f"{PRELUDE}'/' env 'pwd'"),
    ],
    ids=["cwd-env-argv", "hostile-values", "no-env"],
)
def test_wrap_line_dresses_cwd_env_and_argv(argv, env, cwd, wrapped):
    assert wrap_line(argv, env, cwd) == wrapped


def test_the_wrapped_argv_reaches_the_program_unchanged(tmp_path):
    argv = ("/bin/sh", "-c", 'printf "[%s]\\n" "$@"', "sh", "a b", "$(x)", "")
    done = subprocess.run(
        ["/bin/sh", "-c", wrap_line(argv, {}, str(tmp_path))],
        capture_output=True,
        check=False,
    )
    assert (done.returncode, done.stdout) == (0, b"[a b]\n[$(x)]\n[]\n")


# A run's wrapper hands its program the words and the tag unchanged, and
# says how the program ended on stderr after all the program wrote, and
# ends its stdout with the same status.
def test_a_run_gives_its_program_its_words_and_says_how_it_ended():
    program = (
        "sh",
        "-c",
        f'printf "%s|" "$@" "${PROCESS}"; echo err >&2; exit 3',
        "sh",
        "a b",
        "",
    )
    argv = run_argv("w:7", "n1", program)
    assert (argv[RUN_PROGRAM_AT:], run_tag(argv)) == (program, "w:7")
    done = subprocess.run(argv, capture_output=True, check=False)
    assert (done.returncode, done.stdout) == (
        3,
        b"a b||w:7|" + run_done_mark("n1") + b"3\n",
    )
    assert done.stderr.endswith(b"err\n" + run_exit_mark("n1") + b"3\n")


# A joined run (`2>&1`) writes the program's stderr into its stdout where
# the program writes it, so the two keep its order; the wrapper's own pid
# and exit lines stay on stderr, and the check that reports a program the
# machine cannot run speaks on stdout too, as bash's redirect makes it.
def test_a_joined_run_writes_stderr_into_stdout_in_order():
    program = ("sh", "-c", "echo out1; echo err >&2; echo out2")
    argv = run_argv("w:7", "n1", program, joined=True)
    assert is_run(argv) and argv[2] == RUN_WRAPPER_JOINED
    done = subprocess.run(argv, capture_output=True, check=False)
    assert done.stdout == b"out1\nerr\nout2\n" + run_done_mark("n1") + b"0\n"
    assert b"err" not in done.stderr.replace(run_exit_mark("n1"), b"")
    missing = run_argv(
        "w:7", "n1", ("no-such-program-x",), ("bash: x: ", "nope", ""), True
    )
    gone = subprocess.run(missing, capture_output=True, check=False)
    assert (gone.returncode, gone.stdout) == (
        127,
        b"bash: x: nope\n" + run_done_mark("n1") + b"127\n",
    )


# A program a signal ended gets no line at the end of its stdout, which may
# have no reader left; its status still comes on stderr.
def test_a_run_a_signal_ended_ends_its_stdout_with_nothing():
    argv = run_argv("w:7", "n1", ("sh", "-c", "echo out; kill -9 $$"))
    done = subprocess.run(argv, capture_output=True, check=False)
    assert (done.returncode, done.stdout) == (137, b"out\n")
    assert done.stderr.endswith(run_exit_mark("n1") + b"137\n")


def _checked(path):
    done = subprocess.run(
        [
            "/bin/sh",
            "-c",
            PROGRAM_CHECK,
            "sh",
            "x: ",
            "command not found",
            "",
            path,
        ],
        capture_output=True,
        check=False,
    )
    return done.returncode, done.stderr.decode()


# A path that names nothing the user can see is reported by its nearest
# folder that exists, as exec reports it: a file there is not a directory,
# a folder the user cannot search denies it, and only a folder that can be
# searched and lacks it makes the program missing.
def test_a_program_path_is_reported_by_its_nearest_folder(tmp_path):
    (tmp_path / "file").write_text("")
    assert _checked(str(tmp_path / "file" / "x")) == (
        126,
        "x: Not a directory\n",
    )
    assert _checked(str(tmp_path / "gone" / "x")) == (
        127,
        "x: No such file or directory\n",
    )
    if os.geteuid() == 0:
        return
    locked = tmp_path / "locked"
    (locked / "sub").mkdir(parents=True)
    locked.chmod(0)
    try:
        assert _checked(str(locked / "sub" / "x")) == (
            126,
            "x: Permission denied\n",
        )
        assert _checked(str(locked / "x")) == (126, "x: Permission denied\n")
    finally:
        locked.chmod(0o700)


def _folder(home, spare, prefixes):
    done = subprocess.run(
        [
            "/bin/sh",
            "-c",
            "umask 002; " + machine_dir_line(prefixes) + 'printf %s "$d"',
        ],
        capture_output=True,
        check=False,
        env={
            "PATH": os.environ["PATH"],
            "HOME": str(home),
            "TMPDIR": str(spare),
        },
    )
    assert done.returncode == 0, done.stderr
    return done.stdout.decode()


# Mirage's folder is the user's alone, made or tightened to 700, and never
# under a workspace prefix, which a mount there would cover, nor a symlink.
def test_mirages_folder_is_private_and_off_every_workspace_prefix(tmp_path):
    work, spare = tmp_path / "work", tmp_path / "spare"
    (work / "home").mkdir(parents=True)
    spare.mkdir()
    folder = spare / f".mirage-{os.getuid()}"
    folder.mkdir(mode=0o775)
    folder.chmod(0o775)
    assert _folder(work / "home", spare, [str(work)]) == str(folder)
    assert stat.S_IMODE(folder.stat().st_mode) == 0o700
    home = tmp_path / "home"
    home.mkdir()
    (home / ".mirage").symlink_to(work)
    assert _folder(home, spare, []) == str(folder)
    (home / ".mirage").unlink()
    assert _folder(home, spare, [str(work)]) == str(home / ".mirage")
    assert stat.S_IMODE((home / ".mirage").stat().st_mode) == 0o700


def test_a_path_without_sh_still_runs_the_line(tmp_path):
    wrapped = wrap_line(
        ("/bin/sh", "-c", "/bin/echo ok"),
        {"PATH": str(tmp_path)},
        str(tmp_path),
    )
    done = subprocess.run(
        ["/bin/sh", "-c", wrapped], capture_output=True, check=False
    )
    assert (done.returncode, done.stdout) == (0, b"ok\n")


# A box that holds no process of the run says so, apart from one whose
# processes it stopped.
@pytest.mark.skipif(not os.path.isdir("/proc/self"), reason="needs /proc")
def test_the_stop_line_answers_a_run_it_does_not_hold():
    done = subprocess.run(
        ["/bin/sh", "-c", stop_line(uuid.uuid4().hex)], check=False, timeout=10
    )
    assert done.returncode == NOT_RUNNING_STATUS


# A run's program may ignore TERM, and the config may set a PATH that
# holds no grep: the stop line still ends every process of the run.
@pytest.mark.skipif(not os.path.isdir("/proc/self"), reason="needs /proc")
@pytest.mark.parametrize("path", [None, "/nowhere"], ids=["path", "no-grep"])
def test_the_stop_line_ends_a_run_that_ignores_term(path):
    tag = f"{uuid.uuid4().hex}:9"
    program = subprocess.Popen(
        [
            "/bin/sh",
            "-c",
            'trap "" TERM; echo ready; while :; do sleep 1; done',
        ],
        env={**os.environ, PROCESS: tag},
        stdout=subprocess.PIPE,
    )
    assert program.stdout is not None
    try:
        assert program.stdout.readline() == b"ready\n"
        done = subprocess.run(
            ["/bin/sh", "-c", stop_line(tag)],
            env=dict(os.environ) if path is None else {"PATH": path},
            check=False,
            timeout=10,
        )
        assert done.returncode == 0
        assert program.wait(timeout=5) == -9
    finally:
        if program.poll() is None:
            program.kill()
        program.stdout.close()


# A tag names one process: the stop line for w:9 leaves the run of w:90
# running.
@pytest.mark.skipif(not os.path.isdir("/proc/self"), reason="needs /proc")
def test_the_stop_line_matches_its_process_tag_whole():
    workspace = uuid.uuid4().hex
    program = subprocess.Popen(
        ["/bin/sh", "-c", "echo ready; while :; do sleep 1; done"],
        env={**os.environ, PROCESS: f"{workspace}:90"},
        stdout=subprocess.PIPE,
    )
    assert program.stdout is not None
    try:
        assert program.stdout.readline() == b"ready\n"
        done = subprocess.run(
            ["/bin/sh", "-c", stop_line(f"{workspace}:9")],
            check=False,
            timeout=10,
        )
        assert done.returncode == NOT_RUNNING_STATUS
        assert program.poll() is None
    finally:
        program.kill()
        program.wait(timeout=5)
        program.stdout.close()


def guarded(table, *entries):
    return subprocess.run(
        [
            "/bin/sh",
            "-c",
            MOUNT_GUARD,
            "sh",
            "",
            "command not found",
            "",
            str(table),
            *entries,
        ]
        + ["--", "/bin/echo", "ran"],
        capture_output=True,
        env={"PATH": "/nowhere"},
        check=False,
        timeout=10,
    )


def expected(prefix, source, kind):
    return (
        mount_field(prefix),
        mount_field(source, source=True),
        kind,
        f"lost {prefix}",
    )


def test_mount_field_escapes_what_the_kernel_escapes():
    assert mount_field("/a b\tc\nd\\e#") == "/a\\040b\\011c\\012d\\134e#"
    assert mount_field("m:/a b#", source=True) == "m:/a\\040b\\043"


# The guard runs the program once every mount it expects is on top, read
# through the kernel's escapes, with only sh's builtins on the PATH.
def test_the_mount_guard_runs_the_program_over_its_mounts(tmp_path):
    table = tmp_path / "mounts"
    table.write_text(
        "mirage-x:/my\\040notes /my\\040notes fuse.sshfs rw 0 0\n"
        "tmpfs /a\\134b tmpfs rw 0 0\n"
    )
    done = guarded(
        table,
        *expected("/my notes", "mirage-x:/my notes", "fuse.sshfs"),
        *expected("/a\\b", "tmpfs", "tmpfs"),
    )
    assert (done.returncode, done.stdout, done.stderr) == (0, b"ran\n", b"")


# The kernel escapes a # in a source, never in a mountpoint; an older mount
# under ours is no matter.
@pytest.mark.parametrize(
    ("rows", "prefix", "source"),
    [
        (
            "mirage-x:/a\\043b /a#b fuse.sshfs rw 0 0\n",
            "/a#b",
            "mirage-x:/a#b",
        ),
        (
            "tmpfs /data tmpfs rw 0 0\nmirage-x:/data /data fuse.sshfs rw 0 0\n",
            "/data",
            "mirage-x:/data",
        ),
    ],
    ids=["hash", "over-an-older-mount"],
)
def test_the_mount_guard_runs_over_the_top_mount(
    tmp_path, rows, prefix, source
):
    table = tmp_path / "mounts"
    table.write_text(rows)
    done = guarded(table, *expected(prefix, source, "fuse.sshfs"))
    assert (done.returncode, done.stdout, done.stderr) == (0, b"ran\n", b"")


# The guard's own names never reach the program's environment.
def test_the_mount_guard_hands_the_program_its_environment(tmp_path):
    table = tmp_path / "mounts"
    table.write_text("mirage-x:/data /data fuse.sshfs rw 0 0\n")
    words = ("t", "f", "s", "m", "k", "o")
    done = subprocess.run(
        [
            "/bin/sh",
            "-c",
            MOUNT_GUARD,
            "sh",
            "",
            "command not found",
            "",
            str(table),
        ]
        + list(expected("/data", "mirage-x:/data", "fuse.sshfs"))
        + ["--", "/usr/bin/env"],
        capture_output=True,
        env={"PATH": "/nowhere", **{w: f"keep-{w}" for w in words}},
        check=False,
        timeout=10,
    )
    assert done.returncode == 0
    assert {f"{w}=keep-{w}" for w in words} <= set(
        done.stdout.decode().splitlines()
    )


def test_the_mount_guard_checks_every_mount(tmp_path):
    table = tmp_path / "mounts"
    table.write_text("mirage-x:/data /data fuse.sshfs rw 0 0\n")
    done = guarded(
        table,
        *expected("/data", "mirage-x:/data", "fuse.sshfs"),
        *expected("/a\\b", "tmpfs", "tmpfs"),
    )
    assert (done.returncode, done.stdout, done.stderr) == (
        126,
        b"",
        b"lost /a\\b\n",
    )


@pytest.mark.parametrize(
    "rows",
    [
        "",
        "mirage-y:/data /data fuse.sshfs rw 0 0\n",
        "mirage-x:/data /data tmpfs rw 0 0\n",
        "mirage-x:/data /data fuse.sshfs rw 0 0\ntmpfs /data tmpfs rw 0 0\n",
    ],
    ids=["gone", "another-source", "another-type", "covered"],
)
def test_the_mount_guard_refuses_a_mount_not_on_top(tmp_path, rows):
    table = tmp_path / "mounts"
    table.write_text(rows)
    done = guarded(table, *expected("/data", "mirage-x:/data", "fuse.sshfs"))
    assert (done.returncode, done.stdout, done.stderr) == (
        126,
        b"",
        b"lost /data\n",
    )


def test_the_mount_guard_refuses_without_a_mount_table(tmp_path):
    done = guarded(
        tmp_path / "missing",
        *expected("/data", "mirage-x:/data", "fuse.sshfs"),
    )
    assert (done.returncode, done.stdout, done.stderr) == (
        126,
        b"",
        b"lost /data\n",
    )


# A line the machine's own shell writes (no encoder there) is not base64
# and comes back as it is, between the decoded lines; a blank line adds
# nothing.
def test_decode_output_keeps_a_plain_line_as_it_is():
    text = "YQ==\r\nmirage: no base64\n\nAP8=\n"
    assert decode_output(text) == b"amirage: no base64\n\x00\xff"


# A sandbox without dd or base64 runs nothing: the script says so in
# plain text and exits 127.
def test_a_sandbox_without_the_encoder_runs_nothing(tmp_path):
    script = ENCODE_OUTPUT.replace(TOOLS_PATH, str(tmp_path))
    done = subprocess.run(
        ["/bin/sh", "-c", script, "sh", "/bin/sh", "-c", "echo ran"],
        capture_output=True,
        check=False,
        timeout=10,
    )
    assert (done.returncode, done.stdout, done.stderr) == (
        127,
        b"",
        b"mirage: the machine needs dd and base64 to return output\n",
    )


def test_sshfs_keeps_names_and_attributes_a_second_and_never_contents():
    assert {
        "attr_timeout=1",
        "entry_timeout=1",
        "negative_timeout=1",
        "dir_cache=no",
        "direct_io",
    } <= set(SSHFS_OPTIONS.split(","))


# Stand-ins for the tools SSHFS_LINE calls, on a PATH of their own: sudo
# runs what it is given when SUDO_OK is set, apt-get installs sshfs only once
# its lists were updated, and every call is logged.
_FAKE_TOOLS = {
    "id": '#!/bin/sh\necho "${FAKE_UID:-1000}"\n',
    "sudo": (
        '#!/bin/sh\n[ -n "$SUDO_OK" ] || exit 1\n[ "$1" = -n ] && shift\n'
        '[ "$1" = true ] && exit 0\nexec "$@"\n'
    ),
    "env": (
        '#!/bin/sh\nwhile case "$1" in *=*) true;; *) false;; esac; do '
        'export "$1"; shift; done\nexec "$@"\n'
    ),
    "apt-get": (
        '#!/bin/sh\necho "apt-get $*" >> "$LOG"\n'
        'case " $* " in *" update "*) : > "$TOOLS/lists"; exit 0;; esac\n'
        '[ -f "$TOOLS/lists" ] || exit 100\n'
        "printf '#!/bin/sh\\n' > \"$TOOLS/sshfs\"\n"
        '/bin/chmod +x "$TOOLS/sshfs"\n'
    ),
}


def _sshfs_line(tmp_path, tools, **env):
    for name in tools:
        path = tmp_path / name
        path.write_text(_FAKE_TOOLS[name])
        path.chmod(0o755)
    log = tmp_path / "log"
    log.touch()
    done = subprocess.run(
        ["/bin/sh", "-c", SSHFS_LINE],
        env={
            "PATH": str(tmp_path),
            "TOOLS": str(tmp_path),
            "LOG": str(log),
            **env,
        },
        check=False,
    )
    return done.returncode, log.read_text().splitlines()


def test_sshfs_line_leaves_a_machine_that_has_sshfs_alone(tmp_path):
    sshfs = tmp_path / "sshfs"
    sshfs.write_text("#!/bin/sh\n")
    sshfs.chmod(0o755)
    assert _sshfs_line(tmp_path, ["id", "apt-get"]) == (0, [])


def test_sshfs_line_installs_through_sudo_from_fresh_lists(tmp_path):
    code, calls = _sshfs_line(
        tmp_path, ["id", "sudo", "env", "apt-get"], SUDO_OK="1"
    )
    assert code == 0
    assert calls == [
        "apt-get -y -qq install --no-install-recommends sshfs",
        "apt-get -y -qq update",
        "apt-get -y -qq install --no-install-recommends sshfs",
    ]


def test_sshfs_line_installs_as_root_without_sudo(tmp_path):
    (tmp_path / "lists").touch()
    code, calls = _sshfs_line(tmp_path, ["id", "env", "apt-get"], FAKE_UID="0")
    assert (code, calls) == (
        0,
        ["apt-get -y -qq install --no-install-recommends sshfs"],
    )


@pytest.mark.parametrize(
    ("tools", "env"),
    [
        (["id", "sudo", "env", "apt-get"], {}),
        (["id", "sudo", "env"], {"SUDO_OK": "1"}),
    ],
    ids=["no sudo", "no package manager"],
)
def test_sshfs_line_fails_when_it_cannot_install(tmp_path, tools, env):
    code, calls = _sshfs_line(tmp_path, tools, **env)
    assert (code, calls) == (1, [])


# Stand-ins for the installers MIRAGE_FUSE_LINE calls, on a PATH of their
# own: each logs its call and, unless told to fail, puts a mirage-fuse
# speaking this host's fsproto where it was asked to. npm, as npm does,
# refuses to replace a file there without --force.
_FUSE = f'#!/bin/sh\necho "mirage-fuse 0 fsproto {FSPROTO_VERSION}"\n'
_FAKE_INSTALLERS = {
    "uv": (
        '#!/bin/sh\necho "uv $* in $UV_TOOL_BIN_DIR" >> "$LOG"\n'
        '[ -z "$UV_FAILS" ] || exit 1\n/bin/mkdir -p "$UV_TOOL_BIN_DIR"\n'
        f"printf '%s' '{_FUSE}' > \"$UV_TOOL_BIN_DIR/mirage-fuse\"\n"
        '/bin/chmod +x "$UV_TOOL_BIN_DIR/mirage-fuse"\n'
    ),
    "npm": (
        '#!/bin/sh\necho "npm $*" >> "$LOG"\nf=; p=\n'
        "while [ $# -gt 0 ]; do case $1 in --force) f=1;; "
        "--prefix) p=$2;; esac; shift; done\n"
        '[ -e "$p/bin/mirage-fuse" ] && [ -z "$f" ] && exit 1\n'
        '/bin/mkdir -p "$p/bin"\n'
        f"printf '%s' '{_FUSE}' > \"$p/bin/mirage-fuse\"\n"
        '/bin/chmod +x "$p/bin/mirage-fuse"\n'
    ),
}


def _mirage_fuse_line(tmp_path, tools, **env):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    for name in tools:
        path = bin_dir / name
        path.write_text(_FAKE_INSTALLERS[name])
        path.chmod(0o755)
    log = tmp_path / "log"
    log.touch()
    done = subprocess.run(
        ["/bin/sh", "-c", MIRAGE_FUSE_LINE],
        env={
            "PATH": str(bin_dir),
            "HOME": str(tmp_path / "home"),
            "LOG": str(log),
            **env,
        },
        check=False,
    )
    return done.returncode, log.read_text().splitlines()


def test_mirage_fuse_version_is_the_npm_spelling_of_this_release():
    cargo = pathlib.Path(__file__).parents[3] / "rust/Cargo.toml"
    version = tomllib.loads(cargo.read_text())["workspace"]["package"]
    assert MIRAGE_FUSE_VERSION == version["version"]


def test_mirage_fuse_line_leaves_a_machine_that_has_it_alone(tmp_path):
    (tmp_path / "bin").mkdir()
    fuse = tmp_path / "bin/mirage-fuse"
    fuse.write_text(_FUSE)
    fuse.chmod(0o755)
    assert _mirage_fuse_line(tmp_path, ["uv", "npm"]) == (0, [])


def test_mirage_fuse_line_installs_with_uv_into_mirages_folder(tmp_path):
    code, calls = _mirage_fuse_line(tmp_path, ["uv", "npm"])
    folder = tmp_path / "home/.mirage/bin"
    assert code == 0
    assert calls == [
        f"uv tool install --force mirage-fuse=={MIRAGE_FUSE_VERSION} "
        f"in {folder}"
    ]
    assert (folder / "mirage-fuse").is_file()


def test_mirage_fuse_line_falls_back_to_npm(tmp_path):
    code, calls = _mirage_fuse_line(tmp_path, ["uv", "npm"], UV_FAILS="1")
    home = tmp_path / "home"
    assert code == 0
    assert calls == [
        f"uv tool install --force mirage-fuse=={MIRAGE_FUSE_VERSION} "
        f"in {home}/.mirage/bin",
        f"npm install -g --force --prefix {home}/.mirage "
        f"@struktoai/mirage-fuse@{MIRAGE_FUSE_VERSION}",
    ]


def test_mirage_fuse_line_replaces_one_speaking_another_fsproto(tmp_path):
    (tmp_path / "home/.mirage/bin").mkdir(parents=True)
    stale = tmp_path / "home/.mirage/bin/mirage-fuse"
    stale.write_text('#!/bin/sh\necho "mirage-fuse 0 fsproto 0"\n')
    stale.chmod(0o755)
    code, calls = _mirage_fuse_line(tmp_path, ["npm"])
    assert code == 0
    assert len(calls) == 1
    assert "fsproto 0" not in stale.read_text()


def test_mirage_fuse_line_takes_the_path_one_past_a_stale_home_one(tmp_path):
    (tmp_path / "home/.mirage/bin").mkdir(parents=True)
    stale = tmp_path / "home/.mirage/bin/mirage-fuse"
    stale.write_text('#!/bin/sh\necho "mirage-fuse 0 fsproto 0"\n')
    stale.chmod(0o755)
    (tmp_path / "bin").mkdir()
    fuse = tmp_path / "bin/mirage-fuse"
    fuse.write_text(_FUSE)
    fuse.chmod(0o755)
    assert _mirage_fuse_line(tmp_path, []) == (0, [])
    found = subprocess.run(
        ["/bin/sh", "-c", MIRAGE_FUSE_FIND + 'printf %s "$f"'],
        env={"PATH": str(tmp_path / "bin"), "HOME": str(tmp_path / "home")},
        capture_output=True,
        text=True,
        check=False,
    )
    assert found.stdout == str(fuse)


def test_mirage_fuse_line_fails_without_uv_or_npm(tmp_path):
    assert _mirage_fuse_line(tmp_path, []) == (1, [])


MAC = pytest.mark.skipif(sys.platform != "darwin", reason="reads a Mac's ps")


def _sh(line):
    return subprocess.run(
        ["/bin/sh", "-c", line], capture_output=True, text=True
    )


@MAC
def test_a_mac_knows_a_run_by_its_program_and_what_runs_under_it():
    tagged = {**os.environ, PROCESS: "w1:9"}
    untagged = {k: v for k, v in os.environ.items() if k != PROCESS}
    wrapper = subprocess.Popen(
        ["/bin/sh", "-c", "/bin/sleep 30", "sh", f"{PROCESS}=w1:9"],
        env=untagged,
    )
    other = subprocess.Popen(
        ["/bin/sh", "-c", "exec /bin/sleep 31"],
        env={**os.environ, PROCESS: "w1:90"},
    )
    program = subprocess.Popen(
        ["/bin/sh", "-c", "/bin/sleep 32 & wait"], env=tagged
    )
    try:
        time.sleep(0.5)
        started = float(_sh(darwin_start(str(program.pid))).stdout)
        rows = _parse_scan(
            _sh(
                scan_line("w1", {program.pid: ("w1:9", started)})
            ).stdout.encode()
        )
        assert {(r.tag, r.ppid == program.pid or r.pid) for r in rows} == {
            ("w1:9", program.pid),
            ("w1:9", True),
        }
        stale = MachinePid(program.pid, started + 100)
        assert _sh(signal_line(stale, 0)).returncode == NOT_RUNNING_STATUS
        assert (
            _sh(signal_line(MachinePid(program.pid, started), 0)).returncode
            == 0
        )
        root = MachinePid(program.pid, started)
        assert _sh(stop_line("w1:9", 15, root)).returncode == 0
        assert program.wait(5) != 0
        assert (
            _sh(stop_line("w1:9", 15, root)).returncode == NOT_RUNNING_STATUS
        )
        assert wrapper.poll() is None and other.poll() is None
    finally:
        for left in (wrapper, other, program):
            left.kill()
            left.wait(5)


@MAC
def test_a_mac_stop_kills_what_outlives_the_program(tmp_path):
    untagged = {k: v for k, v in os.environ.items() if k != PROCESS}
    pidfile = tmp_path / "child"
    program = subprocess.Popen(
        [
            "/bin/sh",
            "-c",
            '/bin/sh -c \'trap "" TERM; echo $$ > "$1"; '
            'while :; do /bin/sleep 0.05; done\' sh "$0" & wait',
            str(pidfile),
        ],
        env=untagged,
    )
    child = 0
    try:
        for _ in range(50):
            if pidfile.exists() and pidfile.read_text().strip():
                break
            time.sleep(0.1)
        child = int(pidfile.read_text())
        started = float(_sh(darwin_start(str(program.pid))).stdout)
        root = MachinePid(program.pid, started)
        assert _sh(stop_line("w1:9", 15, root)).returncode == 0
        assert program.wait(5) != 0
        time.sleep(0.2)
        assert _sh(f"kill -0 {child}").returncode != 0
    finally:
        program.kill()
        program.wait(5)
        if child:
            _sh(f"kill -KILL {child}")


# A hangup reaches only what is still in the run's session, and nothing
# is killed after it: a setsid daemon and a child that ignores HUP keep
# running, as a dropped terminal leaves them.
@pytest.mark.skipif(not os.path.isdir("/proc/self"), reason="needs /proc")
def test_the_hangup_spares_what_left_the_run_or_ignores_it():
    tag = f"{uuid.uuid4().hex}:9"
    program = subprocess.Popen(
        [
            "/bin/sh",
            "-c",
            "setsid sleep 300 & echo $!; "
            "(trap '' HUP; exec sleep 301) & echo $!; "
            "while :; do sleep 1; done",
        ],
        env={**os.environ, PROCESS: tag},
        stdout=subprocess.PIPE,
        start_new_session=True,
    )
    assert program.stdout is not None
    left = [int(program.stdout.readline()) for _ in range(2)]
    try:
        time.sleep(0.5)
        done = subprocess.run(
            ["/bin/sh", "-c", stop_line(tag, 1, MachinePid(program.pid, 0.0))],
            check=False,
            timeout=10,
        )
        assert done.returncode == 0
        assert program.wait(timeout=5) == -1
        for pid in left:
            os.kill(pid, 0)
    finally:
        subprocess.run(
            ["/bin/sh", "-c", stop_line(tag)], check=False, timeout=10
        )
        if program.poll() is None:
            program.kill()
        program.stdout.close()


def _ended(pid: int) -> bool:
    try:
        stat = pathlib.Path(f"/proc/{pid}/stat").read_text()
    except OSError:
        return True
    return stat.rsplit(")", 1)[1].split()[0] in ("Z", "X")


# Once the run's program has exited, a hangup still spares what setsid
# moved out of the session, even once that session's leader has exited
# too (a zombie or reaped), and a stopped process is continued so the
# hangup ends it.
@pytest.mark.skipif(not os.path.isdir("/proc/self"), reason="needs /proc")
def test_the_hangup_keeps_to_the_session_once_the_program_is_gone():
    tag = f"{uuid.uuid4().hex}:9"
    program = subprocess.Popen(
        [
            "/bin/sh",
            "-c",
            "setsid sleep 300 & echo k $!; sleep 301 & echo h $!; "
            "sleep 302 & echo s $!; setsid sh -c 'sleep 303 & echo o $!'; "
            'sh -c \'setsid sh -c "sleep 304 & echo z \\$!" & '
            "exec sleep 305' &",
        ],
        env={**os.environ, PROCESS: tag},
        stdout=subprocess.PIPE,
        start_new_session=True,
    )
    assert program.stdout is not None
    pids: dict[str, int] = {}
    for _ in range(5):
        label, pid = program.stdout.readline().split()
        pids[label.decode()] = int(pid)
    program.wait(timeout=5)
    try:
        os.kill(pids["s"], 19)
        done = subprocess.run(
            ["/bin/sh", "-c", stop_line(tag, 1, MachinePid(program.pid, 0.0))],
            check=False,
            timeout=10,
        )
        assert done.returncode == 0
        for _ in range(50):
            if _ended(pids["h"]) and _ended(pids["s"]):
                break
            time.sleep(0.1)
        assert _ended(pids["h"]) and _ended(pids["s"])
        assert not any(_ended(pids[k]) for k in ("k", "o", "z"))
    finally:
        subprocess.run(
            ["/bin/sh", "-c", stop_line(tag)], check=False, timeout=10
        )
        program.stdout.close()
