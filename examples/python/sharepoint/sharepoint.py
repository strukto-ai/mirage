import asyncio
import os
from pathlib import Path

from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.resource.sharepoint import SharePointConfig, SharePointResource
from mirage.types import PathSpec

load_dotenv(".env.development")

REPORT_FILE = Path(__file__).parent / "test_results.md"
token = os.environ["MS_GRAPH_DRIVE_TOKEN"]


async def _pick_site_and_drive(ws: Workspace) -> tuple[str, str]:
    r = await ws.execute("ls /sharepoint/")
    sites = [
        s.strip() for s in (await r.stdout_str()).strip().splitlines()
        if s.strip()
    ]
    if not sites:
        raise RuntimeError("No SharePoint sites accessible")
    site = sites[0]
    r = await ws.execute(f'ls "/sharepoint/{site}/"')
    drives = [
        d.strip() for d in (await r.stdout_str()).strip().splitlines()
        if d.strip()
    ]
    if not drives:
        raise RuntimeError(f"No drives in site '{site}'")
    return site, drives[0]


def build_tests(base: str, test_dir: str, test_file: str):
    commands = [
        ("mkdir", f'mkdir "{test_dir}"'),
        ("touch", f'touch "{test_file}"'),
        ("echo write", f'echo "hello world\nfoo bar\nhello again'
         f'\napple\nbanana" > "{test_file}"'),
        ("ls", f'ls "{test_dir}"'),
        ("ls -l", f'ls -l "{test_dir}"'),
        ("ls -la", f'ls -la "{test_dir}"'),
        ("find", f'find "{test_dir}"'),
        ("tree", f'tree "{test_dir}"'),
        ("cat", f'cat "{test_file}"'),
        ("head", f'head "{test_file}"'),
        ("head -n 2", f'head -n 2 "{test_file}"'),
        ("tail", f'tail "{test_file}"'),
        ("tail -n 2", f'tail -n 2 "{test_file}"'),
        ("wc", f'wc "{test_file}"'),
        ("wc -l", f'wc -l "{test_file}"'),
        ("wc -c", f'wc -c "{test_file}"'),
        ("grep", f'grep hello "{test_file}"'),
        ("grep -c", f'grep -c hello "{test_file}"'),
        ("grep -n", f'grep -n hello "{test_file}"'),
        ("grep -i", f'grep -i HELLO "{test_file}"'),
        ("rg", f'rg hello "{test_dir}"'),
        ("rg -l", f'rg -l hello "{test_dir}"'),
        ("stat", f'stat "{test_file}"'),
        ("file", f'file "{test_file}"'),
        ("du", f'du "{test_dir}"'),
        ("basename", f'basename "{test_file}"'),
        ("dirname", f'dirname "{test_file}"'),
        ("realpath", f'realpath "{test_file}"'),
        ("nl", f'nl "{test_file}"'),
        ("rev", f'rev "{test_file}"'),
        ("tac", f'tac "{test_file}"'),
        ("sort", f'sort "{test_file}"'),
        ("uniq", f'uniq "{test_file}"'),
        ("cut -c1-5", f'cut -c1-5 "{test_file}"'),
        ("tr a-z A-Z", f'cat "{test_file}" | tr a-z A-Z'),
        ("fold -w 10", f'fold -w 10 "{test_file}"'),
        ("fmt", f'fmt "{test_file}"'),
        ("expand", f'expand "{test_file}"'),
        ("unexpand", f'unexpand "{test_file}"'),
        ("md5", f'md5 "{test_file}"'),
        ("sha256sum", f'sha256sum "{test_file}"'),
        ("base64", f'base64 "{test_file}"'),
        ("xxd", f'xxd "{test_file}"'),
        ("strings", f'strings "{test_file}"'),
        ("column", f'column "{test_file}"'),
        ("paste", f'paste "{test_file}" "{test_file}"'),
        ("join", f'join "{test_file}" "{test_file}"'),
        ("look", f'look h "{test_file}"'),
        ("diff (same)", f'diff "{test_file}" "{test_file}"'),
        ("cmp (same)", f'cmp "{test_file}" "{test_file}"'),
        ("cp", f'cp "{test_file}" "{test_dir}/copy.txt"'),
        ("mv", f'mv "{test_dir}/copy.txt" "{test_dir}/moved.txt"'),
        ("ln", f'ln "{test_dir}/moved.txt" "{test_dir}/link.txt"'),
        ("rm link", f'rm "{test_dir}/link.txt"'),
        ("rm moved", f'rm "{test_dir}/moved.txt"'),
        ("cat > write2", f'echo "second file" > "{test_dir}/file2.txt"'),
        ("sed -f", f"echo 's/hello/HELLO/' | tee \"{test_dir}/prog.sed\""
         f" > /dev/null && sed -f \"{test_dir}/prog.sed\" \"{test_file}\""
         f" && rm \"{test_dir}/prog.sed\""),
        ("grep -r", f'grep -r hello "{test_dir}"'),
        ("grep -rl", f'grep -rl hello "{test_dir}"'),
        ("find -name", f'find "{test_dir}" -name "*.txt"'),
        ("find -type f", f'find "{test_dir}" -type f'),
    ]

    pipe_tests = [
        ("cat|wc -l", f'cat "{test_file}" | wc -l'),
        ("cat|grep", f'cat "{test_file}" | grep hello'),
        ("cat|head", f'cat "{test_file}" | head -n 2'),
        ("grep|sort", f'grep hello "{test_file}" | sort'),
        ("grep|wc", f'grep hello "{test_file}" | wc -l'),
        ("find|wc", f'find "{test_dir}" | wc -l'),
        ("find|head", f'find "{test_dir}" | head -2'),
        ("cat|sort|uniq", f'cat "{test_file}" | sort | uniq'),
        ("cat|grep|wc", f'cat "{test_file}" | grep hello | wc -l'),
        ("cat|tr|sort|uniq", f'cat "{test_file}" | tr a-z A-Z | sort | uniq'),
        ("find|grep|wc", f'find "{test_dir}" | grep hello | wc -l'),
        ("cat|sed", f"cat \"{test_file}\" | sed 's/hello/HELLO/'"),
    ]

    shell_tests = [
        ("variable", 'X=hello; echo $X'),
        ("arithmetic", 'echo $((2 + 3))'),
        ("cmd substitution", f'echo $(cat "{test_file}" | wc -l) lines'),
        ("if-else exists",
         f'if [ -f "{test_file}" ]; then echo exists; else echo missing; fi'),
        ("if-else missing", 'if [ -f "/sharepoint/no/such/file" ];'
         ' then echo exists; else echo missing; fi'),
        ("for loop", 'for i in 1 2 3; do echo $i; done'),
        ("while read", 'seq 3 | while read n; do echo line$n; done'),
        ("functions", 'greet() { echo hi; }; greet'),
        ("nested loops",
         'for i in 1 2; do for j in a b; do echo $i$j; done; done'),
        ("error redirect", 'ls /nonexistent 2>/dev/null; echo ok'),
    ]

    return commands, pipe_tests, shell_tests


async def run_test(ws: Workspace, name: str,
                   cmd: str) -> tuple[str, str, bool, str, str]:
    try:
        r = await ws.execute(cmd)
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
    lines.append(f"**Total: {passed} passed, {failed} failed,"
                 f" {total} total ({pct:.1f}%)**\n")

    for section, results in [("Individual Commands", cmd_results),
                             ("Piping", pipe_results),
                             ("Shell Features", shell_results)]:
        lines.append(f"\n## {section}\n")
        lines.append("| # | Test | Command | Status | Output |")
        lines.append("|---|------|---------|--------|--------|")
        for i, (name, cmd, ok, stdout, stderr) in enumerate(results, 1):
            status = "✅" if ok else "❌"
            detail = escape_md(stdout) if ok else escape_md(stderr or stdout)
            lines.append(f"| {i} | {escape_md(name)} "
                         f"| `{escape_md(cmd)}` "
                         f"| {status} | {detail} |")
        sec_passed = sum(1 for *_, ok, _, _ in results if ok)
        lines.append(f"\n**{sec_passed}/{len(results)} passed**\n")

    with open(REPORT_FILE, "w") as f:
        f.write("\n".join(lines) + "\n")
    print(f"\nReport: {REPORT_FILE}")


async def main():
    print("Token loaded ✓\n")

    ws = Workspace(
        {
            "/sharepoint/":
            SharePointResource(SharePointConfig(access_token=token))
        },
        mode=MountMode.WRITE,
    )

    site, drive = await _pick_site_and_drive(ws)
    base = f"/sharepoint/{site}/{drive}"
    test_dir = f"{base}/mirage-sp-test"
    test_file = f"{test_dir}/hello.txt"
    print(f"Site: {site}, Drive: {drive}")
    print(f"Test dir: {test_dir}\n")

    commands, pipe_tests, shell_tests = build_tests(base, test_dir, test_file)

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
    meta_res = await ws.execute(f'chmod 640 "{test_file}"'
                                f' && chown 500:dev "{test_file}"'
                                f' && touch -t 202601021530 "{test_file}"')
    print(f"  chmod/chown/touch exit={meta_res.exit_code}")
    meta_st, _ = await ws.dispatch("stat",
                                   PathSpec.from_str_path(f"{test_file}"))
    print(f"  dispatch stat: mode={oct(meta_st.mode)[2:]} uid={meta_st.uid} "
          f"gid={meta_st.gid} mtime={meta_st.modified}")

    # Cleanup
    print("\n=== Cleanup ===")
    await ws.execute(f'rm -r "{test_dir}"')
    print("  done")

    write_report(site, drive, cmd_results, pipe_results, shell_results)

    all_results = cmd_results + pipe_results + shell_results
    total = len(all_results)
    passed = sum(1 for *_, ok, _, _ in all_results if ok)
    print(f"\n✓ {passed}/{total} tests passed ({passed/total*100:.1f}%)")


asyncio.run(main())
