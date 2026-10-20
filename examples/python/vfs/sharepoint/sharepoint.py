import asyncio
import os
import shlex
import uuid
from pathlib import Path

from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.types import PathSpec
from mirage.vfs.sharepoint import SharePointConfig, SharePointVFS

load_dotenv(".env.development")

REPORT_FILE = Path(__file__).parent / "test_results.md"
token = os.environ["MS_GRAPH_DRIVE_TOKEN"]


async def _pick_site_and_drive(ws: Workspace) -> tuple[str, str]:
    r = await ws.shell("ls /sharepoint/")
    sites = [
        s.strip()
        for s in (await r.stdout_str()).strip().splitlines()
        if s.strip()
    ]
    if not sites:
        raise RuntimeError("No SharePoint sites accessible")
    site = sites[0]
    r = await ws.shell(f"ls {shlex.quote(f'/sharepoint/{site}/')}")
    drives = [
        d.strip()
        for d in (await r.stdout_str()).strip().splitlines()
        if d.strip()
    ]
    if not drives:
        raise RuntimeError(f"No drives in site '{site}'")
    return site, drives[0]


def build_tests(test_dir: str, test_file: str):
    commands = [
        ("touch", f"touch {shlex.quote(test_file)}"),
        (
            "echo write",
            f'echo "hello world\nfoo bar\nhello again'
            f'\napple\nbanana" > {shlex.quote(test_file)}',
        ),
        ("ls", f"ls {shlex.quote(test_dir)}"),
        ("ls -l", f"ls -l {shlex.quote(test_dir)}"),
        ("ls -la", f"ls -la {shlex.quote(test_dir)}"),
        ("find", f"find {shlex.quote(test_dir)}"),
        ("tree", f"tree {shlex.quote(test_dir)}"),
        ("cat", f"cat {shlex.quote(test_file)}"),
        ("head", f"head {shlex.quote(test_file)}"),
        ("head -n 2", f"head -n 2 {shlex.quote(test_file)}"),
        ("tail", f"tail {shlex.quote(test_file)}"),
        ("tail -n 2", f"tail -n 2 {shlex.quote(test_file)}"),
        ("wc", f"wc {shlex.quote(test_file)}"),
        ("wc -l", f"wc -l {shlex.quote(test_file)}"),
        ("wc -c", f"wc -c {shlex.quote(test_file)}"),
        ("grep", f"grep hello {shlex.quote(test_file)}"),
        ("grep -c", f"grep -c hello {shlex.quote(test_file)}"),
        ("grep -n", f"grep -n hello {shlex.quote(test_file)}"),
        ("grep -i", f"grep -i HELLO {shlex.quote(test_file)}"),
        ("rg", f"rg hello {shlex.quote(test_dir)}"),
        ("rg -l", f"rg -l hello {shlex.quote(test_dir)}"),
        ("stat", f"stat {shlex.quote(test_file)}"),
        ("file", f"file {shlex.quote(test_file)}"),
        ("du", f"du {shlex.quote(test_dir)}"),
        ("basename", f"basename {shlex.quote(test_file)}"),
        ("dirname", f"dirname {shlex.quote(test_file)}"),
        ("realpath", f"realpath {shlex.quote(test_file)}"),
        ("nl", f"nl {shlex.quote(test_file)}"),
        ("rev", f"rev {shlex.quote(test_file)}"),
        ("tac", f"tac {shlex.quote(test_file)}"),
        ("sort", f"sort {shlex.quote(test_file)}"),
        ("uniq", f"uniq {shlex.quote(test_file)}"),
        ("cut -c1-5", f"cut -c1-5 {shlex.quote(test_file)}"),
        ("tr a-z A-Z", f"cat {shlex.quote(test_file)} | tr a-z A-Z"),
        ("fold -w 10", f"fold -w 10 {shlex.quote(test_file)}"),
        ("fmt", f"fmt {shlex.quote(test_file)}"),
        ("expand", f"expand {shlex.quote(test_file)}"),
        ("unexpand", f"unexpand {shlex.quote(test_file)}"),
        ("md5", f"md5 {shlex.quote(test_file)}"),
        ("sha256sum", f"sha256sum {shlex.quote(test_file)}"),
        ("base64", f"base64 {shlex.quote(test_file)}"),
        ("xxd", f"xxd {shlex.quote(test_file)}"),
        ("strings", f"strings {shlex.quote(test_file)}"),
        ("column", f"column {shlex.quote(test_file)}"),
        ("paste", f"paste {shlex.quote(test_file)} {shlex.quote(test_file)}"),
        ("join", f"join {shlex.quote(test_file)} {shlex.quote(test_file)}"),
        ("look", f"look h {shlex.quote(test_file)}"),
        (
            "diff (same)",
            f"diff {shlex.quote(test_file)} {shlex.quote(test_file)}",
        ),
        (
            "cmp (same)",
            f"cmp {shlex.quote(test_file)} {shlex.quote(test_file)}",
        ),
        (
            "cp",
            f"cp {shlex.quote(test_file)} {shlex.quote(f'{test_dir}/copy.txt')}",
        ),
        (
            "mv",
            f"mv {shlex.quote(f'{test_dir}/copy.txt')}"
            f" {shlex.quote(f'{test_dir}/moved.txt')}",
        ),
        (
            "ln",
            f"ln {shlex.quote(f'{test_dir}/moved.txt')}"
            f" {shlex.quote(f'{test_dir}/link.txt')}",
        ),
        ("rm link", f"rm {shlex.quote(f'{test_dir}/link.txt')}"),
        ("rm moved", f"rm {shlex.quote(f'{test_dir}/moved.txt')}"),
        (
            "cat > write2",
            f'echo "second file" > {shlex.quote(f"{test_dir}/file2.txt")}',
        ),
        (
            "sed -f",
            f"echo 's/hello/HELLO/' | tee {shlex.quote(f'{test_dir}/prog.sed')}"
            f" > /dev/null && sed -f {shlex.quote(f'{test_dir}/prog.sed')}"
            f" {shlex.quote(test_file)}"
            f" && rm {shlex.quote(f'{test_dir}/prog.sed')}",
        ),
        ("grep -r", f"grep -r hello {shlex.quote(test_dir)}"),
        ("grep -rl", f"grep -rl hello {shlex.quote(test_dir)}"),
        ("find -name", f'find {shlex.quote(test_dir)} -name "*.txt"'),
        ("find -type f", f"find {shlex.quote(test_dir)} -type f"),
    ]

    pipe_tests = [
        ("cat|wc -l", f"cat {shlex.quote(test_file)} | wc -l"),
        ("cat|grep", f"cat {shlex.quote(test_file)} | grep hello"),
        ("cat|head", f"cat {shlex.quote(test_file)} | head -n 2"),
        ("grep|sort", f"grep hello {shlex.quote(test_file)} | sort"),
        ("grep|wc", f"grep hello {shlex.quote(test_file)} | wc -l"),
        ("find|wc", f"find {shlex.quote(test_dir)} | wc -l"),
        ("find|head", f"find {shlex.quote(test_dir)} | head -2"),
        ("cat|sort|uniq", f"cat {shlex.quote(test_file)} | sort | uniq"),
        ("cat|grep|wc", f"cat {shlex.quote(test_file)} | grep hello | wc -l"),
        (
            "cat|tr|sort|uniq",
            f"cat {shlex.quote(test_file)} | tr a-z A-Z | sort | uniq",
        ),
        ("find|grep|wc", f"find {shlex.quote(test_dir)} | grep hello | wc -l"),
        ("cat|sed", f"cat {shlex.quote(test_file)} | sed 's/hello/HELLO/'"),
    ]

    shell_tests = [
        ("variable", "X=hello; echo $X"),
        ("arithmetic", "echo $((2 + 3))"),
        (
            "cmd substitution",
            f"echo $(cat {shlex.quote(test_file)} | wc -l) lines",
        ),
        (
            "if-else exists",
            f"if [ -f {shlex.quote(test_file)} ];"
            " then echo exists; else echo missing; fi",
        ),
        (
            "if-else missing",
            'if [ -f "/sharepoint/no/such/file" ];'
            " then echo exists; else echo missing; fi",
        ),
        ("for loop", "for i in 1 2 3; do echo $i; done"),
        ("while read", "seq 3 | while read n; do echo line$n; done"),
        ("functions", "greet() { echo hi; }; greet"),
        (
            "nested loops",
            "for i in 1 2; do for j in a b; do echo $i$j; done; done",
        ),
        ("error redirect", "ls /nonexistent 2>/dev/null; echo ok"),
    ]

    return commands, pipe_tests, shell_tests


async def run_test(
    ws: Workspace, name: str, cmd: str
) -> tuple[str, str, bool, str, str]:
    try:
        r = await ws.shell(cmd)
        stdout = (await r.stdout_str()) or ""
        stderr = (await r.stderr_str()) or ""
        ok = r.exit_code == 0
        return name, cmd, ok, stdout.rstrip(), stderr.rstrip()
    except Exception as e:
        return name, cmd, False, "", str(e)


async def run_section(ws, tests):
    results = []
    for name, cmd in tests:
        result = await run_test(ws, name, cmd)
        results.append(result)
        _, _, ok, stdout, stderr = result
        status = "✅" if ok else "❌"
        print(f"  {status} {name}")
        if stdout:
            for line in stdout.splitlines()[:5]:
                print(f"      | {line}")
            if len(stdout.splitlines()) > 5:
                print(f"      | ... ({len(stdout.splitlines())} lines)")
        if stderr:
            print(f"      ERR: {stderr[:100]}")
    return results


def escape_md(s: str) -> str:
    return s.replace("|", "\\|").replace("\n", " ↵ ").strip()[:120]


def write_report(
    site: str,
    drive: str,
    cmd_results,
    pipe_results,
    shell_results,
):
    lines = ["# SharePoint Comprehensive Integration Test Results\n"]
    lines.append(f"**Site:** {site}  \n**Drive:** {drive}\n")

    all_results = cmd_results + pipe_results + shell_results
    total = len(all_results)
    passed = sum(1 for *_, ok, _, _ in all_results if ok)
    failed = total - passed
    pct = (passed / total * 100) if total else 0
    lines.append(
        f"**Total: {passed} passed, {failed} failed,"
        f" {total} total ({pct:.1f}%)**\n"
    )

    for section, results in [
        ("Individual Commands", cmd_results),
        ("Piping", pipe_results),
        ("Shell Features", shell_results),
    ]:
        lines.append(f"\n## {section}\n")
        lines.append("| # | Test | Command | Status | Output |")
        lines.append("|---|------|---------|--------|--------|")
        for i, (name, cmd, ok, stdout, stderr) in enumerate(results, 1):
            status = "✅" if ok else "❌"
            detail = escape_md(stdout) if ok else escape_md(stderr or stdout)
            lines.append(
                f"| {i} | {escape_md(name)} "
                f"| `{escape_md(cmd)}` "
                f"| {status} | {detail} |"
            )
        sec_passed = sum(1 for *_, ok, _, _ in results if ok)
        lines.append(f"\n**{sec_passed}/{len(results)} passed**\n")

    with open(REPORT_FILE, "w") as f:
        f.write("\n".join(lines) + "\n")
    print(f"\nReport: {REPORT_FILE}")


async def make_scratch_dir(ws: Workspace, path: str) -> None:
    r = await ws.shell(f"mkdir {shlex.quote(path)}")
    if r.exit_code != 0:
        err = (await r.stderr_str()).strip()
        raise RuntimeError(f"mkdir {path} failed: {err}")


async def run_suite(ws: Workspace, test_dir: str, test_file: str):
    commands, pipe_tests, shell_tests = build_tests(test_dir, test_file)

    print("=== Individual Commands ===")
    cmd_results = await run_section(ws, commands)

    print("\n=== Piping ===")
    pipe_results = await run_section(ws, pipe_tests)

    print("\n=== Shell Features ===")
    shell_results = await run_section(ws, shell_tests)

    # chmod/chown/touch never hit the Graph API: attrs land in the
    # workspace namespace (durable, snapshot-captured) and merge into
    # dispatch-level stat.
    print(f"=== metadata overlay on {test_file} ===")
    meta_res = await ws.shell(
        f"chmod 640 {shlex.quote(test_file)}"
        f" && chown 500:dev {shlex.quote(test_file)}"
        f" && touch -t 202601021530 {shlex.quote(test_file)}"
    )
    print(f"  chmod/chown/touch exit={meta_res.exit_code}")
    meta_st, _ = await ws.dispatch(
        "stat", PathSpec.from_str_path(f"{test_file}")
    )
    meta_mode = oct(meta_st.mode)[2:] if meta_st.mode is not None else "-"
    print(
        f"  dispatch stat: mode={meta_mode} uid={meta_st.uid} "
        f"gid={meta_st.gid} mtime={meta_st.modified}"
    )

    return cmd_results, pipe_results, shell_results


async def main():
    print("Token loaded ✓\n")

    ws = Workspace(
        {"/sharepoint/": SharePointVFS(SharePointConfig(access_token=token))},
        mode=MountMode.WRITE,
    )

    site, drive = await _pick_site_and_drive(ws)
    base = f"/sharepoint/{site}/{drive}"
    test_dir = f"{base}/mirage-sp-test-{uuid.uuid4().hex[:8]}"
    test_file = f"{test_dir}/hello.txt"
    print(f"Site: {site}, Drive: {drive}")
    print(f"Test dir: {test_dir}\n")

    await make_scratch_dir(ws, test_dir)
    try:
        cmd_results, pipe_results, shell_results = await run_suite(
            ws, test_dir, test_file
        )
    finally:
        print("\n=== Cleanup ===")
        await ws.shell(f"rm -r {shlex.quote(test_dir)}")
        print("  done")

    write_report(site, drive, cmd_results, pipe_results, shell_results)

    all_results = cmd_results + pipe_results + shell_results
    total = len(all_results)
    passed = sum(1 for *_, ok, _, _ in all_results if ok)
    print(f"\n✓ {passed}/{total} tests passed ({passed / total * 100:.1f}%)")
    await ws.close()


asyncio.run(main())
