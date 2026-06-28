import asyncio
import os
from pathlib import Path

from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.resource.sharepoint import SharePointConfig, SharePointResource

load_dotenv(".env.development")

REPORT_FILE = Path(__file__).parent / "sharepoint_vfs_results.md"
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


DIFF_EXIT1_OK = {"diff different", "comm"}


async def run_test(ws: Workspace, name: str,
                   cmd: str) -> tuple[str, str, bool, str, str]:
    try:
        r = await ws.execute(cmd)
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
    lines.append("Tests use `ws.execute()` — Mirage VFS layer (in-process).\n")

    all_results = [r for section in all_sections for r in section[1]]
    total = len(all_results)
    passed = sum(1 for *_, ok, _, _ in all_results if ok)
    lines.append(f"**Total: {passed} passed, {total - passed} failed,"
                 f" {total} total ({passed/total*100:.1f}%)**\n")

    for section_name, results in all_sections:
        lines.append(f"\n## {section_name}\n")
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
    d = f"{base}/mirage-vfs-test"
    f1 = f"{d}/hello.txt"
    f2 = f"{d}/data.txt"
    print(f"Site: {site}, Drive: {drive}")
    print(f"Test dir: {d}")

    # --- Setup ---
    setup = [
        ("mkdir", f'mkdir "{d}"'),
        ("write f1",
         f'echo "hello world\nfoo bar\nhello again\napple\nbanana" > "{f1}"'),
        ("write f2", f'echo "line1\nline2\nline3\nline4\nline5'
         f'\nline6\nline7\nline8\nline9\nline10" > "{f2}"'),
    ]
    setup_results = await run_section(ws, setup, "Setup")

    # --- Read commands ---
    read_cmds = [
        ("cat", f'cat "{f1}"'),
        ("head", f'head "{f1}"'),
        ("head -n 2", f'head -n 2 "{f1}"'),
        ("head -c 10", f'head -c 10 "{f1}"'),
        ("tail", f'tail "{f1}"'),
        ("tail -n 2", f'tail -n 2 "{f1}"'),
        ("cat f2", f'cat "{f2}"'),
        ("head -n 5 f2", f'head -n 5 "{f2}"'),
        ("tail -n 3 f2", f'tail -n 3 "{f2}"'),
    ]
    read_results = await run_section(ws, read_cmds, "Read Commands")

    # --- Metadata ---
    meta_cmds = [
        ("ls", f'ls "{d}"'),
        ("ls -l", f'ls -l "{d}"'),
        ("ls -la", f'ls -la "{d}"'),
        ("ls -lh", f'ls -lh "{d}"'),
        ("stat f1", f'stat "{f1}"'),
        ("stat f2", f'stat "{f2}"'),
        ("file f1", f'file "{f1}"'),
        ("file f2", f'file "{f2}"'),
        ("du", f'du "{d}"'),
        ("du f1", f'du "{f1}"'),
        ("find", f'find "{d}"'),
        ("find -name", f'find "{d}" -name "*.txt"'),
        ("find -type f", f'find "{d}" -type f'),
        ("tree", f'tree "{d}"'),
        ("basename", f'basename "{f1}"'),
        ("dirname", f'dirname "{f1}"'),
        ("realpath", f'realpath "{f1}"'),
    ]
    meta_results = await run_section(ws, meta_cmds, "Metadata Commands")

    # --- Search ---
    search_cmds = [
        ("grep hello", f'grep hello "{f1}"'),
        ("grep -c hello", f'grep -c hello "{f1}"'),
        ("grep -n hello", f'grep -n hello "{f1}"'),
        ("grep -i HELLO", f'grep -i HELLO "{f1}"'),
        ("grep -v hello", f'grep -v hello "{f1}"'),
        ("grep -r hello", f'grep -r hello "{d}"'),
        ("grep -rl hello", f'grep -rl hello "{d}"'),
        ("grep -rc hello", f'grep -rc hello "{d}"'),
        ("rg hello", f'rg hello "{d}"'),
        ("rg -l hello", f'rg -l hello "{d}"'),
        ("rg -c hello", f'rg -c hello "{d}"'),
    ]
    search_results = await run_section(ws, search_cmds, "Search Commands")

    # --- Text Processing ---
    text_cmds = [
        ("wc", f'wc "{f1}"'),
        ("wc -l", f'wc -l "{f1}"'),
        ("wc -c", f'wc -c "{f1}"'),
        ("wc -w", f'wc -w "{f1}"'),
        ("sort", f'sort "{f1}"'),
        ("sort -r", f'sort -r "{f1}"'),
        ("uniq", f'uniq "{f1}"'),
        ("rev", f'rev "{f1}"'),
        ("tac", f'tac "{f1}"'),
        ("nl", f'nl "{f1}"'),
        ("cut -c1-5", f'cut -c1-5 "{f1}"'),
        ("cut -d' ' -f1", f"cut -d' ' -f1 \"{f1}\""),
        ("tr a-z A-Z", f'cat "{f1}" | tr a-z A-Z'),
        ("fold -w 10", f'fold -w 10 "{f1}"'),
        ("fmt", f'fmt "{f1}"'),
        ("expand", f'expand "{f1}"'),
        ("unexpand", f'unexpand "{f1}"'),
        ("column", f'column "{f1}"'),
        ("paste", f'paste "{f1}" "{f2}"'),
        ("join", f'join "{f1}" "{f1}"'),
        ("look h", f'look h "{f1}"'),
        ("strings", f'strings "{f1}"'),
    ]
    text_results = await run_section(ws, text_cmds, "Text Processing")

    # --- Hash/Encode ---
    encode_cmds = [
        ("md5", f'md5 "{f1}"'),
        ("sha256sum", f'sha256sum "{f1}"'),
        ("base64 encode", f'base64 "{f1}"'),
        ("base64 decode", f'base64 "{f1}" | base64 -d'),
        ("xxd", f'xxd "{f1}"'),
        ("xxd -l 16", f'xxd -l 16 "{f1}"'),
    ]
    encode_results = await run_section(ws, encode_cmds, "Hash/Encode")

    # --- Write/Mutate ---
    write_cmds = [
        ("cp", f'cp "{f1}" "{d}/copy.txt"'),
        ("cat copy", f'cat "{d}/copy.txt"'),
        ("mv", f'mv "{d}/copy.txt" "{d}/moved.txt"'),
        ("cat moved", f'cat "{d}/moved.txt"'),
        ("ln", f'ln "{d}/moved.txt" "{d}/link.txt"'),
        ("cat link", f'cat "{d}/link.txt"'),
        ("rm link", f'rm "{d}/link.txt"'),
        ("rm moved", f'rm "{d}/moved.txt"'),
        ("echo append", f'echo "appended line" >> "{f1}"'),
        ("cat after append", f'cat "{f1}"'),
        ("touch new", f'touch "{d}/empty.txt"'),
        ("ls after touch", f'ls "{d}"'),
    ]
    write_results = await run_section(ws, write_cmds, "Write/Mutate Commands")

    # --- Pipes ---
    pipe_cmds = [
        ("cat|wc -l", f'cat "{f1}" | wc -l'),
        ("cat|grep|wc", f'cat "{f1}" | grep hello | wc -l'),
        ("cat|head|wc", f'cat "{f2}" | head -n 5 | wc -l'),
        ("cat|sort|uniq", f'cat "{f1}" | sort | uniq'),
        ("cat|tr|sort", f'cat "{f1}" | tr a-z A-Z | sort'),
        ("grep|sort|uniq", f'grep hello "{f1}" | sort | uniq'),
        ("find|wc -l", f'find "{d}" -type f | wc -l'),
        ("find|grep|head", f'find "{d}" | grep txt | head -3'),
        ("cat|sed", f"cat \"{f1}\" | sed 's/hello/HELLO/g'"),
        ("cat|awk", f"cat \"{f1}\" | awk '{{print NR, $0}}'"),
        ("cat|grep -c", f'cat "{f1}" | grep -c hello'),
        ("seq|while", 'seq 5 | while read n; do echo "num=$n"; done'),
    ]
    pipe_results = await run_section(ws, pipe_cmds, "Pipes")

    # --- Shell features ---
    shell_cmds = [
        ("variable", 'X=sharepoint; echo $X'),
        ("arithmetic", 'echo $((10 * 3 + 2))'),
        ("cmd subst", f'echo $(wc -l < "{f1}") lines'),
        ("if file exists",
         f'if [ -f "{f1}" ]; then echo yes; else echo no; fi'),
        ("if file missing",
         'if [ -f "/sharepoint/x/y/z" ]; then echo yes; else echo no; fi'),
        ("for loop", 'for i in a b c; do echo $i; done'),
        ("while read", 'echo "1\n2\n3" | while read x; do echo got_$x; done'),
        ("function def", 'add() { echo $(($1 + $2)); }; add 3 4'),
        ("nested for",
         'for i in 1 2; do for j in x y; do echo $i$j; done; done'),
        ("error suppress", 'cat /nonexistent 2>/dev/null; echo ok'),
        ("string ops", 'S="hello world"; echo ${#S}'),
        ("multiline",
         f'cat "{f1}" | while read line; do echo ">>$line"; done'),
    ]
    shell_results = await run_section(ws, shell_cmds, "Shell Features")

    # --- Compare ---
    compare_cmds = [
        ("diff same", f'diff "{f1}" "{f1}"'),
        ("cmp same", f'cmp "{f1}" "{f1}"'),
        ("diff different", f'diff "{f1}" "{f2}"'),
        ("comm", f'comm "{f1}" "{f2}"'),
    ]
    compare_results = await run_section(ws, compare_cmds, "Compare Commands")

    # --- Cleanup ---
    print("\n=== Cleanup ===")
    await ws.execute(f'rm -r "{d}"')
    print("  done")

    all_sections = [
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
    write_report(site, drive, all_sections)

    all_results = [r for section in all_sections for r in section[1]]
    total = len(all_results)
    passed = sum(1 for *_, ok, _, _ in all_results if ok)
    print(f"\n✓ {passed}/{total} tests passed ({passed/total*100:.1f}%)")


asyncio.run(main())
