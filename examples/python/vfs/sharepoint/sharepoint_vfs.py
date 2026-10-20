import asyncio
import os
import shlex
import uuid
from pathlib import Path

from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.vfs.sharepoint import SharePointConfig, SharePointVFS

load_dotenv(".env.development")

REPORT_FILE = Path(__file__).parent / "sharepoint_vfs_results.md"
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


DIFF_EXIT1_OK = {"diff different", "comm"}


async def run_test(
    ws: Workspace, name: str, cmd: str
) -> tuple[str, str, bool, str, str]:
    try:
        r = await ws.shell(cmd)
        stdout = (await r.stdout_str()) or ""
        stderr = (await r.stderr_str()) or ""
        ok = r.exit_code == 0
        if not ok and name in DIFF_EXIT1_OK and r.exit_code == 1 and stdout:
            ok = True
        return name, cmd, ok, stdout.rstrip(), stderr.rstrip()
    except Exception as e:
        return name, cmd, False, "", str(e)


async def run_section(ws, tests, section_name):
    print(f"\n=== {section_name} ===")
    results = []
    for name, cmd in tests:
        result = await run_test(ws, name, cmd)
        results.append(result)
        _, _, ok, stdout, stderr = result
        status = "✅" if ok else "❌"
        print(f"  {status} {name}")
        if stdout:
            for line in stdout.splitlines()[:3]:
                print(f"      | {line}")
            if len(stdout.splitlines()) > 3:
                print(f"      | ... ({len(stdout.splitlines())} lines)")
        if stderr:
            print(f"      ERR: {stderr[:100]}")
    return results


def escape_md(s: str) -> str:
    return s.replace("|", "\\|").replace("\n", " ↵ ").strip()[:120]


def write_report(site, drive, all_sections):
    lines = ["# SharePoint VFS Integration Test Results\n"]
    lines.append(f"**Site:** {site}  \n**Drive:** {drive}\n")
    lines.append("Tests use `ws.shell()` — Mirage VFS layer (in-process).\n")

    all_results = [r for section in all_sections for r in section[1]]
    total = len(all_results)
    passed = sum(1 for *_, ok, _, _ in all_results if ok)
    lines.append(
        f"**Total: {passed} passed, {total - passed} failed,"
        f" {total} total ({passed / total * 100:.1f}%)**\n"
    )

    for section_name, results in all_sections:
        lines.append(f"\n## {section_name}\n")
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


async def run_suite(ws: Workspace, d: str, f1: str, f2: str):
    # --- Setup ---
    setup = [
        (
            "write f1",
            f'echo "hello world\nfoo bar\nhello again\napple\nbanana"'
            f" > {shlex.quote(f1)}",
        ),
        (
            "write f2",
            f'echo "line1\nline2\nline3\nline4\nline5'
            f'\nline6\nline7\nline8\nline9\nline10" > {shlex.quote(f2)}',
        ),
    ]
    setup_results = await run_section(ws, setup, "Setup")

    # --- Read commands ---
    read_cmds = [
        ("cat", f"cat {shlex.quote(f1)}"),
        ("head", f"head {shlex.quote(f1)}"),
        ("head -n 2", f"head -n 2 {shlex.quote(f1)}"),
        ("head -c 10", f"head -c 10 {shlex.quote(f1)}"),
        ("tail", f"tail {shlex.quote(f1)}"),
        ("tail -n 2", f"tail -n 2 {shlex.quote(f1)}"),
        ("cat f2", f"cat {shlex.quote(f2)}"),
        ("head -n 5 f2", f"head -n 5 {shlex.quote(f2)}"),
        ("tail -n 3 f2", f"tail -n 3 {shlex.quote(f2)}"),
    ]
    read_results = await run_section(ws, read_cmds, "Read Commands")

    # --- Metadata ---
    meta_cmds = [
        ("ls", f"ls {shlex.quote(d)}"),
        ("ls -l", f"ls -l {shlex.quote(d)}"),
        ("ls -la", f"ls -la {shlex.quote(d)}"),
        ("ls -lh", f"ls -lh {shlex.quote(d)}"),
        ("stat f1", f"stat {shlex.quote(f1)}"),
        ("stat f2", f"stat {shlex.quote(f2)}"),
        ("file f1", f"file {shlex.quote(f1)}"),
        ("file f2", f"file {shlex.quote(f2)}"),
        ("du", f"du {shlex.quote(d)}"),
        ("du f1", f"du {shlex.quote(f1)}"),
        ("find", f"find {shlex.quote(d)}"),
        ("find -name", f'find {shlex.quote(d)} -name "*.txt"'),
        ("find -type f", f"find {shlex.quote(d)} -type f"),
        ("tree", f"tree {shlex.quote(d)}"),
        ("basename", f"basename {shlex.quote(f1)}"),
        ("dirname", f"dirname {shlex.quote(f1)}"),
        ("realpath", f"realpath {shlex.quote(f1)}"),
    ]
    meta_results = await run_section(ws, meta_cmds, "Metadata Commands")

    # --- Search ---
    search_cmds = [
        ("grep hello", f"grep hello {shlex.quote(f1)}"),
        ("grep -c hello", f"grep -c hello {shlex.quote(f1)}"),
        ("grep -n hello", f"grep -n hello {shlex.quote(f1)}"),
        ("grep -i HELLO", f"grep -i HELLO {shlex.quote(f1)}"),
        ("grep -v hello", f"grep -v hello {shlex.quote(f1)}"),
        ("grep -r hello", f"grep -r hello {shlex.quote(d)}"),
        ("grep -rl hello", f"grep -rl hello {shlex.quote(d)}"),
        ("grep -rc hello", f"grep -rc hello {shlex.quote(d)}"),
        ("rg hello", f"rg hello {shlex.quote(d)}"),
        ("rg -l hello", f"rg -l hello {shlex.quote(d)}"),
        ("rg -c hello", f"rg -c hello {shlex.quote(d)}"),
    ]
    search_results = await run_section(ws, search_cmds, "Search Commands")

    # --- Text Processing ---
    text_cmds = [
        ("wc", f"wc {shlex.quote(f1)}"),
        ("wc -l", f"wc -l {shlex.quote(f1)}"),
        ("wc -c", f"wc -c {shlex.quote(f1)}"),
        ("wc -w", f"wc -w {shlex.quote(f1)}"),
        ("sort", f"sort {shlex.quote(f1)}"),
        ("sort -r", f"sort -r {shlex.quote(f1)}"),
        ("uniq", f"uniq {shlex.quote(f1)}"),
        ("rev", f"rev {shlex.quote(f1)}"),
        ("tac", f"tac {shlex.quote(f1)}"),
        ("nl", f"nl {shlex.quote(f1)}"),
        ("cut -c1-5", f"cut -c1-5 {shlex.quote(f1)}"),
        ("cut -d' ' -f1", f"cut -d' ' -f1 {shlex.quote(f1)}"),
        ("tr a-z A-Z", f"cat {shlex.quote(f1)} | tr a-z A-Z"),
        ("fold -w 10", f"fold -w 10 {shlex.quote(f1)}"),
        ("fmt", f"fmt {shlex.quote(f1)}"),
        ("expand", f"expand {shlex.quote(f1)}"),
        ("unexpand", f"unexpand {shlex.quote(f1)}"),
        ("column", f"column {shlex.quote(f1)}"),
        ("paste", f"paste {shlex.quote(f1)} {shlex.quote(f2)}"),
        ("join", f"join {shlex.quote(f1)} {shlex.quote(f1)}"),
        ("look h", f"look h {shlex.quote(f1)}"),
        ("strings", f"strings {shlex.quote(f1)}"),
    ]
    text_results = await run_section(ws, text_cmds, "Text Processing")

    # --- Hash/Encode ---
    encode_cmds = [
        ("md5", f"md5 {shlex.quote(f1)}"),
        ("sha256sum", f"sha256sum {shlex.quote(f1)}"),
        ("base64 encode", f"base64 {shlex.quote(f1)}"),
        ("base64 decode", f"base64 {shlex.quote(f1)} | base64 -d"),
        ("xxd", f"xxd {shlex.quote(f1)}"),
        ("xxd -l 16", f"xxd -l 16 {shlex.quote(f1)}"),
    ]
    encode_results = await run_section(ws, encode_cmds, "Hash/Encode")

    # --- Write/Mutate ---
    write_cmds = [
        ("cp", f"cp {shlex.quote(f1)} {shlex.quote(f'{d}/copy.txt')}"),
        ("cat copy", f"cat {shlex.quote(f'{d}/copy.txt')}"),
        (
            "mv",
            f"mv {shlex.quote(f'{d}/copy.txt')} {shlex.quote(f'{d}/moved.txt')}",
        ),
        ("cat moved", f"cat {shlex.quote(f'{d}/moved.txt')}"),
        (
            "ln",
            f"ln {shlex.quote(f'{d}/moved.txt')} {shlex.quote(f'{d}/link.txt')}",
        ),
        ("cat link", f"cat {shlex.quote(f'{d}/link.txt')}"),
        ("rm link", f"rm {shlex.quote(f'{d}/link.txt')}"),
        ("rm moved", f"rm {shlex.quote(f'{d}/moved.txt')}"),
        ("echo append", f'echo "appended line" >> {shlex.quote(f1)}'),
        ("cat after append", f"cat {shlex.quote(f1)}"),
        ("touch new", f"touch {shlex.quote(f'{d}/empty.txt')}"),
        ("ls after touch", f"ls {shlex.quote(d)}"),
    ]
    write_results = await run_section(ws, write_cmds, "Write/Mutate Commands")

    # --- Pipes ---
    pipe_cmds = [
        ("cat|wc -l", f"cat {shlex.quote(f1)} | wc -l"),
        ("cat|grep|wc", f"cat {shlex.quote(f1)} | grep hello | wc -l"),
        ("cat|head|wc", f"cat {shlex.quote(f2)} | head -n 5 | wc -l"),
        ("cat|sort|uniq", f"cat {shlex.quote(f1)} | sort | uniq"),
        ("cat|tr|sort", f"cat {shlex.quote(f1)} | tr a-z A-Z | sort"),
        ("grep|sort|uniq", f"grep hello {shlex.quote(f1)} | sort | uniq"),
        ("find|wc -l", f"find {shlex.quote(d)} -type f | wc -l"),
        ("find|grep|head", f"find {shlex.quote(d)} | grep txt | head -3"),
        ("cat|sed", f"cat {shlex.quote(f1)} | sed 's/hello/HELLO/g'"),
        ("cat|awk", f"cat {shlex.quote(f1)} | awk '{{print NR, $0}}'"),
        ("cat|grep -c", f"cat {shlex.quote(f1)} | grep -c hello"),
        ("seq|while", 'seq 5 | while read n; do echo "num=$n"; done'),
    ]
    pipe_results = await run_section(ws, pipe_cmds, "Pipes")

    # --- Shell features ---
    shell_cmds = [
        ("variable", "X=sharepoint; echo $X"),
        ("arithmetic", "echo $((10 * 3 + 2))"),
        ("cmd subst", f"echo $(wc -l < {shlex.quote(f1)}) lines"),
        (
            "if file exists",
            f"if [ -f {shlex.quote(f1)} ]; then echo yes; else echo no; fi",
        ),
        (
            "if file missing",
            'if [ -f "/sharepoint/x/y/z" ]; then echo yes; else echo no; fi',
        ),
        ("for loop", "for i in a b c; do echo $i; done"),
        ("while read", 'echo "1\n2\n3" | while read x; do echo got_$x; done'),
        ("function def", "add() { echo $(($1 + $2)); }; add 3 4"),
        (
            "nested for",
            "for i in 1 2; do for j in x y; do echo $i$j; done; done",
        ),
        ("error suppress", "cat /nonexistent 2>/dev/null; echo ok"),
        ("string ops", 'S="hello world"; echo ${#S}'),
        (
            "multiline",
            f'cat {shlex.quote(f1)} | while read line; do echo ">>$line"; done',
        ),
    ]
    shell_results = await run_section(ws, shell_cmds, "Shell Features")

    # --- Compare ---
    compare_cmds = [
        ("diff same", f"diff {shlex.quote(f1)} {shlex.quote(f1)}"),
        ("cmp same", f"cmp {shlex.quote(f1)} {shlex.quote(f1)}"),
        ("diff different", f"diff {shlex.quote(f1)} {shlex.quote(f2)}"),
        ("comm", f"comm {shlex.quote(f1)} {shlex.quote(f2)}"),
    ]
    compare_results = await run_section(ws, compare_cmds, "Compare Commands")

    return [
        ("Setup", setup_results),
        ("Read Commands", read_results),
        ("Metadata Commands", meta_results),
        ("Search Commands", search_results),
        ("Text Processing", text_results),
        ("Hash/Encode", encode_results),
        ("Write/Mutate Commands", write_results),
        ("Pipes", pipe_results),
        ("Shell Features", shell_results),
        ("Compare Commands", compare_results),
    ]


async def main():
    print("Token loaded ✓\n")

    ws = Workspace(
        {"/sharepoint/": SharePointVFS(SharePointConfig(access_token=token))},
        mode=MountMode.WRITE,
    )

    site, drive = await _pick_site_and_drive(ws)
    base = f"/sharepoint/{site}/{drive}"
    d = f"{base}/mirage-vfs-test-{uuid.uuid4().hex[:8]}"
    f1 = f"{d}/hello.txt"
    f2 = f"{d}/data.txt"
    print(f"Site: {site}, Drive: {drive}")
    print(f"Test dir: {d}")

    await make_scratch_dir(ws, d)
    try:
        all_sections = await run_suite(ws, d, f1, f2)
    finally:
        # --- Cleanup ---
        print("\n=== Cleanup ===")
        await ws.shell(f"rm -r {shlex.quote(d)}")
        print("  done")

    write_report(site, drive, all_sections)

    all_results = [r for section in all_sections for r in section[1]]
    total = len(all_results)
    passed = sum(1 for *_, ok, _, _ in all_results if ok)
    print(f"\n✓ {passed}/{total} tests passed ({passed / total * 100:.1f}%)")
    await ws.close()


asyncio.run(main())
