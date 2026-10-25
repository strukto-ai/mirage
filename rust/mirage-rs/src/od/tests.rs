use serde_json::json;

use crate::host::Host;
use crate::open;

use super::WINDOW;

fn od(options: serde_json::Value, operands: &[&str]) -> Box<dyn crate::Stream> {
    let config = json!({"options": options, "operands": operands});
    open("od", config.to_string().as_bytes()).expect("opens")
}

#[test]
fn operands_read_as_one_input_across_chunks() {
    let mut host = Host::with(
        &[
            ("a", "hello wo"),
            ("b", &format!("rld\n{}", "A".repeat(32))),
        ],
        "",
    );
    host.directories.push("d".into());
    let mut stream = od(json!([["c", true], ["j", "2"]]), &["nope", "a", "d", "b"]);
    assert_eq!(host.drive(stream.as_mut()), 1);
    assert_eq!(
        String::from_utf8_lossy(&host.out),
        "0000002   l   l   o       w   o   r   l   d  \\n   A   A   A   A   A   A\n\
         0000022   A   A   A   A   A   A   A   A   A   A   A   A   A   A   A   A\n\
         0000042   A   A   A   A   A   A   A   A   A   A\n0000054\n"
    );
    assert_eq!(
        String::from_utf8_lossy(&host.err),
        "od: nope: No such file or directory\nod: d: Is a directory\n"
    );
}

#[test]
fn a_chunk_is_dumped_a_window_at_a_time() {
    let mut stream = od(json!([["c", true], ["output_duplicates", true]]), &[]);
    let mut data = Vec::new();
    stream.request(&mut data).expect("reads stdin");
    let chunk = vec![b'x'; 4 * WINDOW];
    let mut out = Vec::new();
    stream.respond(b"{}", &chunk, &mut out).expect("answers");
    let mut drains = 0;
    while stream.busy() {
        out.clear();
        stream.drain(&mut out).expect("drains");
        assert_eq!(out.len(), WINDOW / 16 * 72);
        drains += 1;
    }
    assert_eq!(drains, 4);
}
