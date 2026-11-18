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
import stat
import subprocess
import uuid

import pytest

from mirage.machine.constants import (
    ENCODE_OUTPUT,
    MOUNT_GUARD,
    NOT_RUNNING_STATUS,
    PROCESS,
    PROGRAM_CHECK,
    RUN_PROGRAM_AT,
    SSHFS_LINE,
    SSHFS_OPTIONS,
    TOOLS_PATH,
    decode_output,
    machine_dir_line,
    mount_field,
    run_argv,
    run_done_mark,
    run_exit_mark,
    run_tag,
    stop_line,
    wrap_line,
)

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


# A program a signal ended gets no line at the end of its stdout, which may
# have no reader left; its status still comes on stderr.
def test_a_run_a_signal_ended_ends_its_stdout_with_nothing():
    argv = run_argv("w:7", "n1", ("sh", "-c", "echo out; kill -9 $$"))
    done = subprocess.run(argv, capture_output=True, check=False)
    assert (done.returncode, done.stdout) == (137, b"out\n")
    assert done.stderr.endswith(run_exit_mark("n1") + b"137\n")


def _checked(path):
    done = subprocess.run(
        ["/bin/sh", "-c", PROGRAM_CHECK, "sh", "x: ", "command not found", "", path],
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
    assert _checked(str(tmp_path / "file" / "x")) == (126, "x: Not a directory\n")
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
        assert _checked(str(locked / "sub" / "x")) == (126, "x: Permission denied\n")
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
