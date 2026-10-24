use std::collections::HashMap;

use serde_json::{Value as Json, json};

/// A host serving a run's requests from memory, its reads three bytes at
/// a time so records cross chunks.
#[derive(Default)]
struct Host {
    files: HashMap<String, Vec<u8>>,
    stdin: Vec<u8>,
    inputs: HashMap<u64, Vec<u8>>,
    spools: HashMap<u64, Vec<u8>>,
    writers: HashMap<String, Vec<u8>>,
    out: Vec<u8>,
    err: Vec<u8>,
}

fn text(value: &Json) -> String {
    value.as_str().unwrap_or_default().to_owned()
}

impl Host {
    fn commit(&mut self, path: Option<&str>) {
        let names: Vec<String> = match path {
            Some(path) => vec![path.to_owned()],
            None => self.writers.keys().cloned().collect(),
        };
        for name in names {
            if let Some(data) = self.writers.remove(&name) {
                self.files.entry(name).or_default().extend(data);
            }
        }
    }

    /// A command line of the few forms the tests run.
    fn shell(&mut self, command: &str, stdin: Option<Vec<u8>>) -> (Vec<u8>, i64) {
        let input = stdin.unwrap_or_else(|| std::mem::take(&mut self.stdin));
        match command {
            "cat" => (input, 0),
            "sort" => {
                let mut lines: Vec<&[u8]> = input.split_inclusive(|&c| c == b'\n').collect();
                lines.sort();
                (lines.concat(), 0)
            }
            _ if command.starts_with("echo ") => (format!("{}\n", &command[5..]).into_bytes(), 0),
            _ if command.starts_with("exit ") => (Vec::new(), command[5..].parse().unwrap_or(0)),
            _ => (Vec::new(), 127),
        }
    }

    fn serve(&mut self, header: &[u8], data: Vec<u8>) -> (Json, Vec<u8>) {
        let request: Json = serde_json::from_slice(header).expect("a JSON request");
        let fd = request["fd"].as_u64().unwrap_or(0);
        match request["op"].as_str().unwrap_or_default() {
            "read" => {
                if let Some(path) = request["path"].as_str() {
                    let source = match path {
                        "-" | "/dev/stdin" => Some(std::mem::take(&mut self.stdin)),
                        _ => {
                            self.commit(None);
                            self.files.get(path).cloned()
                        }
                    };
                    match source {
                        Some(source) => {
                            self.inputs.insert(fd, source);
                        }
                        None => return (json!({"error": "No such file or directory"}), Vec::new()),
                    }
                }
                let Some(input) = self.inputs.get_mut(&fd) else {
                    return (json!({"end": true}), Vec::new());
                };
                if input.is_empty() {
                    self.inputs.remove(&fd);
                    return (json!({"end": true}), Vec::new());
                }
                let chunk: Vec<u8> = input.drain(..input.len().min(3)).collect();
                (json!({}), chunk)
            }
            "close" => {
                self.inputs.remove(&fd);
                (json!({}), Vec::new())
            }
            "write" => {
                let path = text(&request["path"]);
                if path.starts_with("/missing/") {
                    return (json!({"error": "No such file or directory"}), Vec::new());
                }
                if request["append"] == json!(false) {
                    self.commit(None);
                    self.files.insert(path.clone(), Vec::new());
                }
                self.writers.entry(path).or_default().extend(data);
                (json!({}), Vec::new())
            }
            "flush" => {
                self.commit(request["path"].as_str());
                (json!({}), Vec::new())
            }
            "spool" => {
                self.spools.entry(fd).or_default().extend(data);
                (json!({}), Vec::new())
            }
            "emit" => {
                let spool = self.spools.remove(&fd).unwrap_or_default();
                self.out.extend(spool);
                (json!({}), Vec::new())
            }
            "run" => {
                self.commit(None);
                let stdin = request["stdin"]
                    .as_u64()
                    .map(|fd| self.spools.remove(&fd).unwrap_or_default());
                let (output, status) = self.shell(&text(&request["command"]), stdin);
                match request["stdout"].as_u64() {
                    Some(fd) => {
                        self.inputs.insert(fd, output);
                    }
                    None => self.out.extend(output),
                }
                (json!({"status": status}), Vec::new())
            }
            op => panic!("unknown request {op}"),
        }
    }
}

struct Run {
    out: String,
    err: String,
    status: i32,
    files: HashMap<String, Vec<u8>>,
}

fn run_with(program: &str, operands: &[&str], stdin: &str, files: &[(&str, &str)]) -> Run {
    let config = json!({"program": program, "operands": operands});
    let mut stream = super::open(config.to_string().as_bytes()).expect("opens");
    let mut host = Host {
        stdin: stdin.as_bytes().to_vec(),
        files: files
            .iter()
            .map(|(name, body)| (name.to_string(), body.as_bytes().to_vec()))
            .collect(),
        ..Host::default()
    };
    loop {
        while stream.busy() {
            stream.drain(&mut host.out).expect("drains");
        }
        stream.take_stderr(&mut host.err);
        let mut data = Vec::new();
        let Some(header) = stream.request(&mut data) else {
            break;
        };
        let (reply, data) = host.serve(&header, data);
        stream
            .respond(reply.to_string().as_bytes(), &data, &mut host.out)
            .expect("answers");
    }
    stream.finish(&mut host.out).expect("finishes");
    stream.take_stderr(&mut host.err);
    host.commit(None);
    Run {
        out: String::from_utf8_lossy(&host.out).into_owned(),
        err: String::from_utf8_lossy(&host.err).into_owned(),
        status: stream.status(),
        files: host.files,
    }
}

fn run(program: &str, stdin: &str) -> String {
    let run = run_with(program, &[], stdin, &[]);
    assert_eq!(run.err, "", "{program}");
    run.out
}

#[test]
fn fields_records_and_arithmetic() {
    assert_eq!(run("{print $2}", "a b c\nd e f\n"), "b\ne\n");
    assert_eq!(run("{s+=$1} END{print s}", "1\n2\n3.5\n"), "6.5\n");
    assert_eq!(run("{print NF, $NF}", "  a   b \n\n"), "2 b\n0 \n");
    assert_eq!(
        run(
            "BEGIN{print 7/2, 7%3, 2^10, 2**3, -2^2, 1e3, 0.1+0.2, 1/3, 100000*100000, 2^53+1}",
            ""
        ),
        "3.5 1 1024 8 -4 1000 0.3 0.333333 10000000000 9007199254740992\n"
    );
    assert_eq!(
        run("BEGIN{i=5; print i++, i, ++i, i--, --i}", ""),
        "5 6 7 7 5\n"
    );
    assert_eq!(run("{$2=\"X\"; print}", "a b c\n"), "a X c\n");
    assert_eq!(run("{NF=2; print}", "a b c\n"), "a b\n");
    assert_eq!(run("BEGIN{OFS=\"-\"} {$1=$1; print}", "a b\n"), "a-b\n");
    assert_eq!(
        run("{print $(NF-1), $NF-1, $(1), $NR}", "5 6 7\n1 2 3\n"),
        "6 6 5 5\n2 2 1 2\n"
    );
}

#[test]
fn values_compare_as_posix_says() {
    assert_eq!(
        run(
            "{print ($1==10), ($1<9), ($1==\"10\"), ($2<$1)}",
            "10 9\n10.0 abc\n+10 1e1\n"
        ),
        "1 0 1 1\n1 0 0 0\n1 0 0 0\n"
    );
    assert_eq!(
        run(
            "BEGIN{print x+0, \"[\" x \"]\", length(x), (x==0), (x==\"\"); if(!x)print \"falsy\"}",
            ""
        ),
        "0 [] 0 1 1\nfalsy\n"
    );
    assert_eq!(
        run(
            "{print $1+0}",
            "12abc\n.5\n1e3\n0x1A\n-7.\n+3\n  42  \n1e\n"
        ),
        "12\n0.5\n1000\n0\n-7\n3\n42\n1\n"
    );
}

#[test]
fn formats_numbers_and_printf() {
    assert_eq!(
        run(
            "BEGIN{x=3.14159265; print x; OFMT=\"%.2f\"; print x, x\"\"; CONVFMT=\"%.3f\"; print x\"\"; a[x]=1; for(k in a)print k; print 17, 17.0, 1e6, 1e16, 123456789012}",
            ""
        ),
        "3.14159\n3.14 3.14159\n3.142\n3.142\n17 17 1000000 10000000000000000 123456789012\n"
    );
    assert_eq!(
        run(
            "BEGIN{printf \"%d|%5d|%-5d|%05d|%+d|% d\\n\", 42,42,42,42,42,42; printf \"%s|%10s|%-10s|%.2s\\n\",\"hi\",\"hi\",\"hi\",\"hello\"; printf \"%f|%.2f|%10.3f|%e|%.3e|%g|%G\\n\",3.14159,3.14159,3.14159,31415.9,31415.9,0.00001234,1e20; printf \"%x|%X|%o|%#x|%#o|%c|%c|%%\\n\",255,255,8,255,8,65,\"hello\"; printf \"%i|%5.1f|%-8.3e|\\n\", 3.99, 2.25, 12345.6789; printf \"%*d|%-*d|%.*f\\n\", 5, 42, 5, 42, 2, 3.14159; x=sprintf(\"%03d-%s\", 7, \"a\"); print x}",
            ""
        ),
        "42|   42|42   |00042|+42| 42\nhi|        hi|hi        |he\n3.141590|3.14|     3.142|3.141590e+04|3.142e+04|1.234e-05|1E+20\nff|FF|10|0xff|010|A|h|%\n3|  2.2|1.235e+04|\n   42|42   |3.14\n007-a\n"
    );
    assert_eq!(
        run(
            "BEGIN{printf \"%d %x\\n\", -1, -1; printf \"%5\"; print \"\"; printf \"%z\\n\"}",
            ""
        ),
        "-1 ffffffffffffffff\n%\n%z\n"
    );
    assert_eq!(
        run("BEGIN{print log(-1), -log(0), int(-3.9)}", ""),
        "nan inf -3\n"
    );
}

#[test]
fn strings_and_regexes() {
    assert_eq!(
        run(
            "BEGIN{s=\"hello world\"; print substr(s,1,5); print substr(s,7); print substr(s,0,3); print substr(s,-1,3); print substr(s,5,100); print \"[\" substr(s,20) \"]\"; print substr(s,2.7,2.5)}",
            ""
        ),
        "hello\nworld\nhel\nhel\no world\n[]\nel\n"
    );
    assert_eq!(
        run(
            "BEGIN{print index(\"hello\",\"ll\"), index(\"hello\",\"z\"); print match(\"foobar\",/o+/), RSTART, RLENGTH; print match(\"x\",/y/), RSTART, RLENGTH}",
            ""
        ),
        "3 0\n2 2 2\n0 0 -1\n"
    );
    assert_eq!(
        run(
            "BEGIN{n=split(\"a:b:c\",p,\":\"); print n,p[1],p[3]; n=split(\"  a  b \",q); print n,q[1],q[2]; n=split(\"a1b22c\",r,/[0-9]+/); print n,r[3]; n=split(\"\",e); print n; n=split(\"abc\",ch,\"\"); print n,ch[2]}",
            ""
        ),
        "3 a c\n2 a b\n3 c\n0\n3 b\n"
    );
    assert_eq!(
        run(
            "{n=gsub(/o/,\"0\"); print n, $0} END{s=\"aaa\"; sub(/a/,\"[&]\",s); print s; t=\"a.b.c\"; gsub(/\\./,\"\\\\&\",t); print t; u=\"hello\"; gsub(/l*/,\"-\",u); print u}",
            "foo boo\nbar\n"
        ),
        "4 f00 b00\n0 bar\n[a]aa\na&b&c\n-h-e-o-\n"
    );
    assert_eq!(
        run("{print toupper($1), tolower(\"ABC\")}", "alice x\n"),
        "ALICE abc\n"
    );
    assert_eq!(run("$0 ~ /a{2}/", "aa\na\n"), "aa\n");
    assert_eq!(run("{gsub(/\\302\\240/, \" \")}1", "A\u{a0}B\n"), "A B\n");
    assert_eq!(
        run("{print match($0, /ab|abcd/), RLENGTH}", "xabcd\n"),
        "2 4\n"
    );
}

#[test]
fn records_follow_rs() {
    assert_eq!(
        run("BEGIN{RS=\":\"} {print NR\": \"$0}", "a:b"),
        "1: a\n2: b\n"
    );
    assert_eq!(
        run(
            "BEGIN{RS=\"\"} {print NR\": \"NF\" \"$1\"-\"$NF}",
            "\n\na b\nc\n\n\nd e\n"
        ),
        "1: 3 a-c\n2: 2 d-e\n"
    );
    assert_eq!(
        run("BEGIN{RS=\"[0-9]+\"} {print NR\": \"$0}", "a12b345c"),
        "1: a\n2: b\n3: c\n"
    );
    assert_eq!(
        run("{print NR\": [\"$0\"]\"; RS=\"2\"}", "a\nb2c2d\n"),
        "1: [a]\n2: [b]\n3: [c]\n4: [d\n]\n"
    );
}

#[test]
fn control_flow_functions_and_arrays() {
    assert_eq!(
        run(
            "BEGIN{while(i<5){i++; if(i==2)continue; if(i==4)break; print i}}",
            ""
        ),
        "1\n3\n"
    );
    assert_eq!(run("BEGIN{do{print i++}while(i<3)}", ""), "0\n1\n2\n");
    assert_eq!(
        run(
            "function fact(n){return n<=1?1:n*fact(n-1)} function greet(who,  tmp){tmp=\"hi \"who; return tmp} BEGIN{print fact(10), greet(\"bob\"), tmp==\"\"}",
            ""
        ),
        "3628800 hi bob 1\n"
    );
    assert_eq!(
        run(
            "function fill(arr,n,  i){for(i=1;i<=n;i++)arr[i]=i*i} function sum(arr,  k,t){for(k in arr)t+=arr[k]; return t} BEGIN{fill(sq,4); print sum(sq), length(sq)}",
            ""
        ),
        "30 4\n"
    );
    assert_eq!(
        run(
            "BEGIN{a[1,2]=3; for(k in a){split(k,p,SUBSEP); print p[1], p[2], a[k]}; if((1,2) in a)print \"in\"}",
            ""
        ),
        "1 2 3\nin\n"
    );
    assert_eq!(run("!seen[$1]++", "a\nb\na\n"), "a\nb\n");
    assert_eq!(run("NR==2,NR==3 {print $1}", "a\nb\nc\nd\n"), "b\nc\n");
    let deep = run_with("function f(n){return f(n+1)} BEGIN{f(1)}", &[], "", &[]);
    assert_eq!(deep.err, "awk: function f nested deeper than 100 calls\n");
    assert_eq!(deep.status, 2);
}

#[test]
fn exit_and_errors() {
    let exited = run_with(
        "NR==2{exit 3} {print $1} END{print \"end\"}",
        &[],
        "a\nb\nc\n",
        &[],
    );
    assert_eq!((exited.out.as_str(), exited.status), ("a\nend\n", 3));
    let begin = run_with(
        "BEGIN{print \"b\"; exit 1} {print} END{print \"e\"}",
        &[],
        "x\n",
        &[],
    );
    assert_eq!((begin.out.as_str(), begin.status), ("b\ne\n", 1));
    let fatal = run_with(
        "BEGIN{print \"pre\"; print 1/0; print \"post\"}",
        &[],
        "",
        &[],
    );
    assert_eq!(
        (fatal.out.as_str(), fatal.err.as_str(), fatal.status),
        ("pre\n", "awk: division by zero\n", 2)
    );
    let syntax = run_with("{print $(}", &[], "a\n", &[]);
    assert_eq!(
        (syntax.err.as_str(), syntax.status),
        ("awk: syntax error at '}': expected an expression\n", 2)
    );
    let regex = run_with("/[/", &[], "a\n", &[]);
    assert_eq!(
        regex.err,
        "awk: syntax error in regular expression [ at source line 1\n"
    );
    let short = run_with("BEGIN{printf \"%s %s\\n\", \"only\"}", &[], "", &[]);
    assert_eq!(
        short.err,
        "awk: not enough arguments to satisfy format string '%s %s\n'\n"
    );
    let next = run_with("BEGIN{next}", &[], "", &[]);
    assert_eq!(next.err, "awk: next used in a BEGIN action\n");
    for program in [
        "{$5000000=\"x\"}",
        "{NF=5000000}",
        "BEGIN{printf \"%2000000000d\", 1}",
    ] {
        let huge = run_with(program, &[], "a\n", &[]);
        assert_eq!(
            (huge.err.as_str(), huge.status),
            ("awk: out of memory\n", 2),
            "{program}"
        );
    }
    assert_eq!(
        run("BEGIN{printf \"%.2000000000s|\\n\", \"ab\"}", ""),
        "ab|\n"
    );
    let arity = run_with("BEGIN{print substr(\"abc\", 1, 1, 1)}", &[], "", &[]);
    assert_eq!(
        arity.err,
        "awk: too many arguments in call to substr: 4 (maximum 3)\n"
    );
}

#[test]
fn operands_argv_and_getline() {
    let files = [("/b", "1\n2\n"), ("/n", "10\n20\n")];
    let crossed = run_with(
        "FNR==1{getline; print FILENAME, $0, NR, FNR}",
        &["/b", "/n"],
        "",
        &files,
    );
    assert_eq!(crossed.out, "/b 2 2 2\n/n 20 4 2\n");
    let assigned = run_with(
        "{getline; print x, $0, FILENAME}",
        &["/b", "x=5", "/n"],
        "",
        &files,
    );
    assert_eq!(assigned.out, " 2 /b\n5 20 /n\n");
    let argv = run_with(
        "BEGIN{ARGV[1]=\"/n\"} {print FILENAME, $0}",
        &["/b"],
        "",
        &files,
    );
    assert_eq!(argv.out, "/n 10\n/n 20\n");
    let missing = run_with("{getline; print}", &["/b", "/nope"], "", &files);
    assert_eq!(
        (missing.out.as_str(), missing.err.as_str(), missing.status),
        (
            "2\n",
            "awk: cannot open \"/nope\" (No such file or directory)\n",
            2
        )
    );
    let file = run_with(
        "BEGIN{getline a < \"/b\"; getline b < \"/b\"; close(\"/b\"); getline c < \"/b\"; r = (getline d < \"/x\"); print a, b, c, r, close(\"/b\"), close(\"/x\")}",
        &[],
        "",
        &files,
    );
    assert_eq!(file.out, "1 2 1 -1 0 -1\n");
    assert_eq!(
        run(
            "NR==1{getline a < \"-\"; print \"a=\" a} {print}",
            "p\nq\nr\n"
        ),
        "a=\np\nq\nr\n"
    );
    assert_eq!(
        run(
            "BEGIN{getline; print \"B\", $0, NR} {print \"M\", $0, NR}",
            "a\nb\n"
        ),
        "B a 1\nM b 2\n"
    );
    assert_eq!(run("{r=getline; print r, $0, NR}", "a\n"), "0 a 1\n");
}

#[test]
fn commands_pipes_and_files() {
    assert_eq!(run("BEGIN{\"echo hi\" | getline x; print x}", ""), "hi\n");
    assert_eq!(
        run(
            "BEGIN{print \"b\" | \"sort\"; print \"a\" | \"sort\"; print \"x\"}",
            ""
        ),
        "a\nb\nx\n"
    );
    assert_eq!(
        run(
            "BEGIN{print \"1\" | \"cat\"; print \"0\"; close(\"cat\"); print \"2\"}",
            ""
        ),
        "1\n0\n2\n"
    );
    assert_eq!(
        run("BEGIN{print \"c\" | \"cat\"; print \"s\" | \"sort\"}", ""),
        "s\nc\n"
    );
    assert_eq!(
        run(
            "BEGIN{print \"to-cat\" | \"cat\"; system(\"echo sys\"); print \"end\"}",
            ""
        ),
        "sys\nto-cat\nend\n"
    );
    assert_eq!(
        run(
            "BEGIN{print \"a\"; r=system(\"exit 4\"); print \"c\", r}",
            ""
        ),
        "a\nc 4\n"
    );
    assert_eq!(
        run(
            "BEGIN{print \"1\" | \"cat\"; print \"0\"; system(\"\")}",
            ""
        ),
        "0\n1\n"
    );
    assert_eq!(
        run(
            "BEGIN{\"echo 1\" | getline a; r = (\"echo 1\" | getline b); print a, r, \"[\" b \"]\", close(\"echo 1\"), close(\"echo 1\")}",
            ""
        ),
        "1 0 [] 0 -1\n"
    );
    assert_eq!(
        run("{print | \"sort\"} END{print \"end\"}", "3\n1\n2\n"),
        "1\n2\n3\nend\n"
    );
    let wrote = run_with(
        "BEGIN{print \"x\" > \"/w\"; getline l < \"/w\"; print \"l=\" l; print \"y\" > \"/v\"; close(\"/v\"); getline m < \"/v\"; print \"m=\" m}",
        &[],
        "",
        &[],
    );
    assert_eq!(wrote.out, "l=\nm=y\n");
    assert_eq!(wrote.files["/w"], b"x\n");
    let modes = run_with(
        "BEGIN { print \"a\" >> \"/o\"; print \"b\" > \"/o\"; close(\"/o\"); print \"c\" >> \"/o\" }",
        &[],
        "",
        &[("/o", "old\n")],
    );
    assert_eq!(modes.files["/o"], b"old\na\nb\nc\n");
    let failed = run_with("BEGIN {print \"changed\" > \"/missing/out\"}", &[], "", &[]);
    assert_eq!(
        (failed.err.as_str(), failed.status),
        (
            "awk: cannot open \"/missing/out\" for output (No such file or directory)\n",
            2
        )
    );
    let kept = run_with(
        "BEGIN { print \"before\" > \"/o\"; print 1/0 }",
        &[],
        "",
        &[],
    );
    assert_eq!(kept.files["/o"], b"before\n");
    assert_eq!(kept.err, "awk: division by zero\n");
}

#[test]
fn a_long_run_yields_between_steps() {
    let config = json!({"program": "BEGIN{for(i=0;i<1000000;i++) s+=i; print s}"});
    let mut stream = super::open(config.to_string().as_bytes()).expect("opens");
    let mut out = Vec::new();
    let mut calls = 0;
    while stream.busy() {
        stream.drain(&mut out).expect("drains");
        calls += 1;
    }
    assert!(calls > 10, "{calls}");
    assert_eq!(out, b"499999500000\n");
}
