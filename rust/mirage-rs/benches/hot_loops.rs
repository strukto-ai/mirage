use serde_json::json;
use std::time::Instant;
fn main() {
    let input = b"1234567,theta,3.14159,four words in row\n".repeat(1_000_000);
    let cases = [
        (
            "wc-w",
            "wc",
            json!({"lines":false,"words":true,"bytes":false,"chars":false,"max_line_length":false}),
        ),
        (
            "wc-L",
            "wc",
            json!({"lines":false,"words":false,"bytes":false,"chars":false,"max_line_length":true}),
        ),
        (
            "cut-f",
            "cut",
            json!({"list":"2","mode":"fields","delimiter":[44],"complement":false,"only_delimited":false,"whitespace":null,"no_partial":false,"output_delimiter":null,"zero_terminated":false}),
        ),
        (
            "cut-c",
            "cut",
            json!({"list":"1-10","mode":"characters","delimiter":[9],"complement":false,"only_delimited":false,"whitespace":null,"no_partial":false,"output_delimiter":null,"zero_terminated":false}),
        ),
        (
            "fold",
            "fold",
            json!({"width":20,"spaces":false,"count":"columns"}),
        ),
        (
            "grep-c",
            "grep",
            json!({"patterns":["theta"],"syntax":"basic","utf8":true,"count":true}),
        ),
        ("rg-c", "rg", json!({"pattern":"theta","count_only":true})),
        ("rg-print", "rg", json!({"pattern":"theta"})),
        (
            "uniq",
            "uniq",
            json!({"count":false,"repeated":false,"unique":false,"skip_fields":0,"skip_chars":0,"check_chars":null,"ignore_case":false,"all_repeated":null,"group":null,"zero_terminated":false}),
        ),
        (
            "seq",
            "seq",
            json!({"operands":["1000000"],"separator":"\n"}),
        ),
    ];
    for (name, kind, config) in cases {
        if std::env::args()
            .skip(1)
            .find(|arg| !arg.starts_with("--"))
            .is_some_and(|filter| !name.contains(&filter))
        {
            continue;
        }
        let mut best = f64::INFINITY;
        let mut total = 0;
        for _ in 0..3 {
            let start = Instant::now();
            let mut s = mirage_rs::open(kind, config.to_string().as_bytes()).unwrap();
            let mut out = Vec::new();
            total = 0;
            if kind == "rg" {
                s.begin(br#"{"name":"bench","binary_mode":"text"}"#)
                    .unwrap();
            }
            if kind == "grep" {
                s.begin(br#"{"label":"bench"}"#).unwrap();
            }
            if kind != "seq" {
                for chunk in input.chunks(16384) {
                    s.feed(chunk, &mut out).unwrap();
                    total += out.len();
                    out.clear();
                    while s.busy() {
                        s.drain(&mut out).unwrap();
                        total += out.len();
                        out.clear();
                    }
                }
            }
            s.finish(&mut out).unwrap();
            total += out.len();
            out.clear();
            while s.busy() {
                s.drain(&mut out).unwrap();
                total += out.len();
                out.clear();
            }
            best = best.min(start.elapsed().as_secs_f64() * 1000.);
        }
        println!("{name}: {best:.2} ms, {total} bytes");
    }
}
