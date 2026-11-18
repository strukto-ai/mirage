/** Drop toolchain metadata and debug names from a compiled Wasm binary. */
export function stripCustomSections(wasm) {
  const sections = [wasm.subarray(0, 8)]
  let at = 8
  while (at < wasm.length) {
    const start = at
    const id = wasm[at++]
    let size = 0
    for (let shift = 0; ; shift += 7) {
      const byte = wasm.readUInt8(at++)
      size += (byte & 0x7f) * 2 ** shift
      if (byte < 0x80) break
    }
    at += size
    if (id !== 0) sections.push(wasm.subarray(start, at))
  }
  return Buffer.concat(sections)
}
