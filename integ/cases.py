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

SEED_FILES = {
    "/data/a.txt":
    "hello\nworld\nfoo\nbar\nbaz\n",
    "/data/b.txt":
    "1\n2\n3\n",
    "/data/user.json":
    '{"name": "alice", "age": 30}\n',
    "/data/users.json": ('{"users": [{"name": "alice", "age": 30}, '
                         '{"name": "bob", "age": 25}]}\n'),
    "/data/data.jsonl":
    '{"id":1}\n{"id":2}\n{"id":3}\n',
    "/data/dup.txt":
    "a\na\nb\nb\nc\n",
    "/data/csv.csv":
    "name,age\nalice,30\nbob,25\n",
    "/data/tabbed.txt":
    "a\t1\nb\t2\nc\t3\n",
    "/data/mixed.txt":
    "Hello World\nHELLO world\nhello WORLD\n",
    "/data/numbers.txt":
    "10\n2\n30\n4\n5\n",
    "/data/sorted_a.txt":
    "apple\nbanana\ncherry\n",
    "/data/sorted_b.txt":
    "banana\ndate\nelder\n",
    "/data/binary.bin":
    "\x00\x01\x02hello\xff\xfe",
    "/data/empty.txt":
    "",
    "/data/no_nl.txt":
    "no trailing newline",
    "/data/one_byte.txt":
    "x",
    "/data/sub/nested.txt":
    "nested\ncontent\n",
    "/data/sub/deep/deeper.txt":
    "deep\n",
    # Extra seeds for expanded coverage
    "/data/fields.txt":
    ("alice 30 engineer\nbob 25 designer\ncarol 40 manager\n"),
    "/data/spaced.txt":
    "  leading\ntrailing  \n  both  \n",
    "/data/sections.txt":
    ("section1\nbody1\nsection2\nbody2\nsection3\nbody3\n"),
    "/data/repeats.txt":
    "x\nx\nx\ny\ny\nz\n",
    "/data/c.txt":
    "alpha\nbeta\ngamma\ndelta\n",
    "/data/abc.csv":
    "a,1\nb,2\nc,3\nd,4\ne,5\n",
    "/data/sorted_c.txt":
    "apple\ncherry\nelder\nfig\n",
}

CASES: list[tuple[str, str]] = [
    # ----- cat / head / tail -----
    ("cat_simple", "cat /data/a.txt"),
    ("cat_concat", "cat /data/a.txt /data/b.txt"),
    ("cat_n", "cat -n /data/a.txt"),
    ("head_default", "head /data/a.txt"),
    ("head_n1", "head -n 1 /data/a.txt"),
    ("head_n2", "head -n 2 /data/a.txt"),
    ("head_c5", "head -c 5 /data/a.txt"),
    ("tail_default", "tail /data/a.txt"),
    ("tail_n1", "tail -n 1 /data/a.txt"),
    ("tail_n2", "tail -n 2 /data/a.txt"),

    # ----- wc -----
    ("wc", "wc /data/a.txt"),
    ("wc_l", "wc -l /data/a.txt"),
    ("wc_w", "wc -w /data/a.txt"),
    ("wc_c", "wc -c /data/a.txt"),

    # ----- grep / rg -----
    ("grep_world", "grep world /data/a.txt"),
    ("grep_n", "grep -n bar /data/a.txt"),
    ("grep_v", "grep -v foo /data/a.txt"),
    ("grep_i", "grep -i HELLO /data/mixed.txt"),
    ("grep_c", "grep -c hello /data/mixed.txt"),
    ("grep_E_alt", 'grep -E "foo|bar" /data/a.txt'),
    ("rg_basic", "rg world /data/a.txt"),
    ("rg_i", "rg -i WORLD /data/mixed.txt"),

    # ----- jq -----
    ("jq_dot", 'jq "." /data/user.json'),
    ("jq_name", 'jq ".name" /data/user.json'),
    ("jq_age", 'jq ".age" /data/user.json'),
    ("jq_raw", 'jq -r ".name" /data/user.json'),
    ("jq_array_iter", 'jq ".users[].name" /data/users.json'),
    ("jq_jsonl_id", 'jq ".id" /data/data.jsonl'),

    # ----- sort / uniq / shuffle -----
    ("sort", "sort /data/a.txt"),
    ("sort_r", "sort -r /data/a.txt"),
    ("sort_n", "sort -n /data/numbers.txt"),
    ("uniq", "uniq /data/dup.txt"),
    ("uniq_c", "uniq -c /data/dup.txt"),
    ("uniq_d", "uniq -d /data/dup.txt"),

    # ----- numbering / reverse -----
    ("nl", "nl /data/a.txt"),
    ("rev", "rev /data/a.txt"),
    ("tac", "tac /data/a.txt"),

    # ----- cut / paste / column / comm -----
    ("cut_f1", "cut -f 1 -d , /data/csv.csv"),
    ("cut_f2", "cut -f 2 -d , /data/csv.csv"),
    ("cut_c2_4", "cut -c 2-4 /data/a.txt"),
    ("cut_tab", "cut -f 1 /data/tabbed.txt"),
    ("paste", "paste /data/a.txt /data/b.txt"),
    ("comm", "comm /data/sorted_a.txt /data/sorted_b.txt"),

    # ----- tr / sed / awk -----
    ("tr_upper", "cat /data/a.txt | tr a-z A-Z"),
    ("tr_delete", "cat /data/a.txt | tr -d aeiou"),
    ("sed_sub", "cat /data/a.txt | sed s/world/UNIVERSE/"),
    ("sed_global", "cat /data/mixed.txt | sed s/hello/HI/g"),
    ("awk_first_col", "cat /data/csv.csv | awk -F, '{print $1}'"),
    ("awk_nr", "awk 'NR==2' /data/a.txt"),
    ("awk_sum", "awk '{s+=$1} END{print s}' /data/numbers.txt"),

    # ----- hashes / encoding -----
    ("md5", "md5 /data/a.txt"),
    ("md5_multi", "md5 /data/a.txt /data/b.txt"),
    ("sha256sum", "sha256sum /data/a.txt"),
    ("base64", "base64 /data/a.txt"),
    ("xxd", "head -c 8 /data/a.txt | xxd"),
    ("xxd_p", "head -c 8 /data/a.txt | xxd -p"),

    # ----- path manipulation -----
    ("basename", "basename /data/a.txt"),
    ("dirname", "dirname /data/a.txt"),
    ("realpath", "realpath /data/a.txt"),

    # ----- find / file listing -----
    ("find_name", 'find /data -name "*.txt"'),
    ("find_type_f", "find /data -type f"),
    ("ls", "ls /data/"),
    ("ls_1", "ls -1 /data/"),

    # ----- formatting -----
    ("expand", "cat /data/tabbed.txt | expand"),
    ("fold", "cat /data/a.txt | fold -w 3"),
    ("strings", "strings /data/binary.bin"),

    # ----- more text -----
    ("nl_ba", "nl -b a /data/a.txt"),
    ("fmt_w20", "cat /data/a.txt | fmt -w 20"),
    ("unexpand", "cat /data/tabbed.txt | unexpand"),
    ("column_t", "column -s , -t /data/csv.csv"),
    ("look", "look hel /data/a.txt"),
    ("join", "join /data/sorted_a.txt /data/sorted_b.txt"),

    # ----- more grep -----
    ("grep_A1", "grep -A 1 world /data/a.txt"),
    ("grep_B1", "grep -B 1 foo /data/a.txt"),
    ("grep_o", "grep -o ll /data/a.txt"),
    ("grep_l", "grep -l hello /data/mixed.txt /data/a.txt"),

    # ----- file metadata -----
    ("file_text", "file /data/a.txt"),
    ("file_json", "file /data/user.json"),
    ("file_b", "file -b /data/a.txt"),
    ("stat_size", 'stat -c "%s" /data/a.txt'),
    ("stat_name", 'stat -c "%n" /data/a.txt'),

    # ----- compression round-trips -----
    ("gzip_gunzip_pipe", "cat /data/a.txt | gzip | gunzip"),
    ("gzip_zcat_pipe", "cat /data/a.txt | gzip | zcat"),
    ("base64_roundtrip", "cat /data/a.txt | base64 | base64 -d"),
    ("xxd_roundtrip", "cat /data/a.txt | xxd | xxd -r"),

    # ----- more find -----
    ("find_mindepth", "find /data -mindepth 1 -type f"),
    ("find_maxdepth", "find /data -maxdepth 1 -type f"),
    ("find_multi_name", 'find /data -name "*.txt" -o -name "*.json"'),

    # ----- multi-file ops -----
    ("wc_multi", "wc /data/a.txt /data/b.txt"),
    ("wc_l_multi", "wc -l /data/a.txt /data/b.txt"),
    ("cat_multi3", "cat /data/a.txt /data/b.txt /data/dup.txt"),
    ("md5_multi3", "md5 /data/a.txt /data/b.txt /data/dup.txt"),

    # ----- pipelines -----
    ("grep_pipe_wc", "grep world /data/a.txt | wc -l"),
    ("sort_uniq", "sort /data/dup.txt | uniq"),
    ("cat_pipe_head", "cat /data/a.txt | head -n 2"),
    ("cat_pipe_sort_pipe_uniq", "cat /data/dup.txt | sort | uniq -c"),
    ("find_pipe_wc", 'find /data -name "*.txt" | wc -l'),
    ("jq_pipe_wc", 'jq ".id" /data/data.jsonl | wc -l'),
    ("cat_tr_sort", "cat /data/a.txt | tr a-z A-Z | sort"),
    ("cat_tr_wc", "cat /data/a.txt | tr -d aeiou | wc -c"),
    ("head_pipe_tail", "head -n 3 /data/a.txt | tail -n 1"),
    ("sort_head", "sort /data/a.txt | head -n 2"),
    ("sort_tail", "sort /data/a.txt | tail -n 2"),
    ("jq_sort", 'jq ".id" /data/data.jsonl | sort -n'),
    ("find_sort_head", 'find /data -name "*.txt" | sort | head -n 2'),

    # ----- edge cases -----
    ("cat_empty", "cat /data/empty.txt"),
    ("wc_empty", "wc /data/empty.txt"),
    ("head_empty", "head /data/empty.txt"),
    ("md5_empty", "md5 /data/empty.txt"),
    ("sha256_empty", "sha256sum /data/empty.txt"),
    ("cat_no_nl", "cat /data/no_nl.txt"),
    ("wc_no_nl", "wc /data/no_nl.txt"),
    ("md5_one_byte", "md5 /data/one_byte.txt"),
    ("wc_one_byte", "wc /data/one_byte.txt"),

    # ----- sort variants -----
    ("sort_u", "sort -u /data/dup.txt"),
    ("sort_k_t", "sort -k 2 -t , /data/csv.csv"),
    ("sort_f", "sort -f /data/mixed.txt"),
    ("sort_n_r", "sort -n -r /data/numbers.txt"),

    # ----- grep deeper -----
    ("grep_w", "grep -w world /data/a.txt"),
    ("grep_count_no_match", "grep -c nothere /data/a.txt"),
    ("grep_n_v_combo", "grep -n -v foo /data/a.txt"),
    ("rg_c", "rg -c hello /data/mixed.txt"),

    # ----- find deeper -----
    ("find_d", "find /data -type d"),
    ("find_iname", 'find /data -iname "*.TXT"'),
    ("find_size_gt", "find /data -size +10c"),
    ("find_recurse", 'find /data -name "*.txt"'),
    ("find_path_pattern", 'find /data -path "*sub*"'),

    # ----- wc deeper -----
    ("wc_m", "wc -m /data/a.txt"),
    ("wc_L", "wc -L /data/a.txt"),

    # ----- comm variants -----
    ("comm_12", "comm -12 /data/sorted_a.txt /data/sorted_b.txt"),
    ("comm_23", "comm -23 /data/sorted_a.txt /data/sorted_b.txt"),
    ("comm_13", "comm -13 /data/sorted_a.txt /data/sorted_b.txt"),

    # ----- head/tail by bytes / negative -----
    ("tail_c", "tail -c 5 /data/a.txt"),

    # ----- multi-file hashes -----
    ("sha256sum_multi", "sha256sum /data/a.txt /data/b.txt"),

    # ----- nested directory -----
    ("ls_sub", "ls /data/sub/"),
    ("cat_nested", "cat /data/sub/nested.txt"),
    ("find_depth2", "find /data/sub -type f"),

    # ----- bigger pipelines -----
    ("pipe_grep_sort_uniq_wc", "grep -v c /data/dup.txt | sort | uniq | wc -l"
     ),
    ("pipe_cat_cut_sort", "cat /data/csv.csv | cut -d , -f 2 | sort -n"),
    ("pipe_jq_grep", 'jq ".id" /data/data.jsonl | grep 2'),
    ("pipe_find_grep_wc", 'find /data -name "*.txt" | grep dup | wc -l'),
    ("pipe_cat_tr_sort_uniq",
     "cat /data/dup.txt | tr a-z A-Z | sort | uniq -c"),
    ("pipe_head_pipe_tail2", "head /data/numbers.txt | tail -n 2"),
    ("pipe_tail_head", "tail /data/a.txt | head -n 1"),

    # ----- stdin chains -----
    ("md5_stdin", "echo hello | md5"),
    ("sha256_stdin", "echo hello | sha256sum"),
    ("base64_stdin", "echo hello | base64"),
    ("wc_stdin", "echo 'a b c' | wc"),

    # ----- awk advanced -----
    ("awk_nf", "awk '{print NF}' /data/fields.txt"),
    ("awk_nr_total", "awk 'END{print NR}' /data/a.txt"),
    ("awk_last_col", "awk '{print $NF}' /data/fields.txt"),
    ("awk_if", "awk '$2 > 28' /data/fields.txt"),
    ("awk_begin_end",
     "awk 'BEGIN{print \"start\"} {print} END{print \"done\"}' /data/b.txt"),
    ("awk_fs_comma", 'awk -F , \'{print $2}\' /data/csv.csv'),
    ("awk_ofs", 'awk -F , \'BEGIN{OFS=":"} {print $1, $2}\' /data/csv.csv'),
    ("awk_range", "awk 'NR>=2 && NR<=4' /data/a.txt"),

    # ----- sed advanced -----
    ("sed_d_first", "sed 1d /data/a.txt"),
    ("sed_d_last", "sed '$d' /data/a.txt"),
    ("sed_range_p", "sed -n '2,3p' /data/a.txt"),
    ("sed_print_only", "sed -n '/world/p' /data/a.txt"),
    ("sed_replace_n", "sed 's/o/O/2' /data/a.txt"),
    ("sed_delete_pattern", "sed '/foo/d' /data/a.txt"),
    ("sed_append", "sed '2a\\\nINSERTED' /data/a.txt"),

    # ----- tr advanced -----
    ("tr_squeeze", "echo aaabbbccc | tr -s a-z"),
    ("tr_complement", "cat /data/a.txt | tr -c 'a-z\\n' '*'"),
    ("tr_delete_digits", "echo abc123def | tr -d 0-9"),
    ("tr_to_newlines", "echo 'a b c' | tr ' ' '\\n'"),

    # ----- cut advanced -----
    ("cut_c1", "cut -c 1 /data/a.txt"),
    ("cut_c_range_open", "cut -c 3- /data/a.txt"),
    ("cut_d_space", "cut -d ' ' -f 2 /data/fields.txt"),
    ("cut_f1_3", "cut -d , -f 1,2 /data/csv.csv"),

    # ----- sort advanced -----
    ("sort_t_comma", "sort -t , -k 1 /data/abc.csv"),
    ("sort_k2n", "sort -t ' ' -k 2 -n /data/fields.txt"),
    ("sort_M", "echo -e 'Feb\\nJan\\nMar' | sort -M"),
    ("sort_b", "sort -b /data/spaced.txt"),

    # ----- uniq advanced -----
    ("uniq_u", "uniq -u /data/dup.txt"),
    ("uniq_repeats", "uniq /data/repeats.txt"),
    ("uniq_c_repeats", "uniq -c /data/repeats.txt"),

    # ----- grep more -----
    ("grep_F", "grep -F . /data/user.json"),
    ("grep_m1", "grep -m 1 o /data/a.txt"),
    ("grep_h", "grep -h hello /data/mixed.txt /data/a.txt"),
    ("grep_only_match_multi", "grep -o o /data/a.txt"),
    ("grep_recursive_dir", 'grep -r hello /data/sub'),
    ("grep_empty_pattern", "grep '' /data/b.txt"),

    # ----- paste advanced -----
    ("paste_s", "paste -s /data/b.txt"),
    ("paste_d_comma", "paste -d , /data/a.txt /data/b.txt"),

    # ----- file metadata more -----
    ("file_empty", "file /data/empty.txt"),
    ("file_binary", "file /data/binary.bin"),

    # ----- find more -----
    ("find_empty", "find /data -empty"),
    ("find_not_name", 'find /data -not -name "*.txt"'),
    ("find_size_lt", "find /data -size -5c"),
    ("find_depth", "find /data -depth -type f"),
    ("find_mtime", "find /data -mtime +0 -o -mtime -1"),

    # ----- xxd variants -----
    ("xxd_c4", "head -c 12 /data/a.txt | xxd -c 4"),
    ("xxd_g1", "head -c 8 /data/a.txt | xxd -g 1"),
    ("xxd_u", "head -c 8 /data/a.txt | xxd -u"),

    # ----- diff / cmp -----
    ("diff_same", "diff /data/a.txt /data/a.txt"),
    ("diff_differ", "diff /data/a.txt /data/b.txt"),
    ("diff_u", "diff -u /data/sorted_a.txt /data/sorted_b.txt"),
    ("cmp_same", "cmp /data/a.txt /data/a.txt"),
    ("cmp_differ", "cmp /data/a.txt /data/b.txt"),

    # ----- du / tree -----
    ("du_file", "du /data/a.txt"),
    ("du_dir", "du /data"),
    ("du_h", "du -h /data/a.txt"),
    ("tree", "tree /data/sub"),

    # ----- iconv -----
    ("iconv_id", "cat /data/a.txt | iconv -f utf-8 -t utf-8"),

    # ----- nl / cat variants -----
    ("cat_E", "cat -E /data/a.txt"),
    ("cat_T", "cat -T /data/tabbed.txt"),
    ("cat_A", "cat -A /data/tabbed.txt"),
    ("nl_d_pipe", "nl -d ! /data/a.txt"),
    ("nl_w3", "nl -w 3 /data/a.txt"),

    # ----- column / paste / join -----
    ("column_n", "column -t /data/fields.txt"),
    ("join_t", "join -t , /data/abc.csv /data/abc.csv"),
    ("join_o", "join /data/sorted_a.txt /data/sorted_c.txt"),

    # ----- fmt / fold / expand -----
    ("fmt_w10", "fmt -w 10 /data/c.txt"),
    ("fold_s", "fold -s -w 6 /data/a.txt"),
    ("expand_t4", "expand -t 4 /data/tabbed.txt"),
    ("unexpand_all", "echo '    hi' | unexpand -a"),

    # ----- tac / rev -----
    ("tac_nested", "tac /data/sub/nested.txt"),
    ("rev_b", "rev /data/b.txt"),

    # ----- ls variants -----
    ("ls_a", "ls -a /data/sub"),
    ("ls_R", "ls -R /data/sub"),
    ("ls_sub_deep", "ls /data/sub/deep"),

    # ----- gzip / zcat / zgrep -----
    ("zgrep_pipe", "cat /data/a.txt | gzip | zgrep world"),
    ("gzip_c_pipe", "cat /data/b.txt | gzip -c | zcat"),

    # ----- jq more -----
    ("jq_keys", 'jq "keys" /data/user.json'),
    ("jq_length", 'jq ". | length" /data/users.json'),
    ("jq_select", 'jq ".users[] | select(.age > 27)" /data/users.json'),
    ("jq_jsonl_select", 'jq "select(.id > 1)" /data/data.jsonl'),

    # ----- bigger pipelines round 2 -----
    ("pipe_awk_sort", "awk '{print $2}' /data/fields.txt | sort -n"),
    ("pipe_grep_cut", "grep -v name /data/csv.csv | cut -d , -f 1"),
    ("pipe_sed_wc", "sed 's/hello/hi/g' /data/mixed.txt | wc -l"),
    ("pipe_find_xargs_cat", 'find /data/sub -name "*.txt" | sort | head -n 1'),
    ("pipe_tr_sort_uniq_c",
     "cat /data/dup.txt | tr a-z A-Z | sort | uniq -c | sort -n"),

    # ----- stdin chains round 2 -----
    ("md5_stdin_multi", "cat /data/a.txt | md5"),
    ("sha256_stdin_multi", "cat /data/a.txt | sha256sum"),
    ("wc_stdin_l", "cat /data/a.txt | wc -l"),
    ("sort_stdin", "cat /data/dup.txt | sort"),
    ("rev_stdin", "echo hello | rev"),
    ("base64_stdin_d", "echo aGVsbG8= | base64 -d"),
]


async def run_cases(ws) -> None:
    for path, content in SEED_FILES.items():
        await ws.execute(f"mkdir -p {path.rsplit('/', 1)[0]}")
        await ws.execute(
            f"tee {path} > /dev/null",
            stdin=content.encode() if isinstance(content, str) else content)
    for name, cmd in CASES:
        result = await ws.execute(cmd)
        out = await result.stdout_str()
        print(f"=== {name} ===")
        print(out, end="" if out.endswith("\n") else "\n")
