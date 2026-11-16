export const ProcessTable = ({ command, rows }) => {
  const logos = {
    in_process: "/images/pydantic-logo.svg",
    e2b: "/images/e2b-logo.svg",
    ssh: "/images/ssh-logo.svg",
    cloudflare_container: "/images/cloudflare-logo.svg",
  }
  const logo = (machine, image) => {
    if (image) return <img src={image} alt="" className="h-3.5 w-3.5" />
    if (machine === "mirage") {
      return (
        <>
          <img src="/images/mirage-icon-light.svg" alt="" className="pt-light-only h-3.5 w-3.5" />
          <img src="/images/mirage-icon-dark.svg" alt="" className="pt-dark-only h-3.5 w-3.5" />
        </>
      )
    }
    const src = logos[machine.split(":")[0]]
    return src ? <img src={src} alt="" className="h-3.5 w-3.5" /> : null
  }
  const cell = "flex items-center whitespace-nowrap py-1.5 pr-5"
  const short = (cmd) =>
    cmd
      .split(" ")
      .map((word) => (word.includes("/") ? `…/${word.split("/").pop()}` : word))
      .join(" ")

  return (
    <div className="process-table not-prose my-5 overflow-hidden rounded-2xl border font-mono text-xs">
      <style>{`
        .process-table {
          --pt-surface: #faf8f2; --pt-edge: #cec6b3; --pt-edge-soft: #e2dccd;
          --pt-ink: #0a0a0a; --pt-muted: #5b5647; --pt-chip: #efeadf;
          background: var(--pt-surface); border-color: var(--pt-edge); color: var(--pt-ink);
        }
        html.dark .process-table {
          --pt-surface: #1a1a1d; --pt-edge: #3f3f46; --pt-edge-soft: #2a2a2f;
          --pt-ink: #ffffff; --pt-muted: #a1a1aa; --pt-chip: #26262b;
        }
        .process-table .pt-muted { color: var(--pt-muted); }
        .process-table .pt-chip { background: var(--pt-chip); }
        .process-table .pt-rule { border-top: 1px solid var(--pt-edge-soft); }
        .process-table img { margin: 0; display: inline; }
        .process-table .pt-dark-only { display: none; }
        html.dark .process-table .pt-dark-only { display: inline; }
        html.dark .process-table .pt-light-only { display: none; }
      `}</style>
      <div className="flex items-center gap-2 border-b px-4 py-2.5" style={{ borderColor: "var(--pt-edge)" }}>
        <span className="pt-muted">$</span>
        <span>{command}</span>
      </div>
      <div className="overflow-x-auto px-4 py-2">
        <div className="grid" style={{ gridTemplateColumns: "max-content max-content minmax(max-content, 1fr)" }}>
          <div className={`${cell} pt-muted justify-end`}>PID</div>
          <div className={`${cell} pt-muted`}>MACHINE</div>
          <div className={`${cell} pt-muted`}>CMD</div>
          {rows.map(([pid, machine, cmd, image]) => [
            <div key={`${pid}-pid`} className={`${cell} pt-rule pt-muted justify-end tabular-nums`}>
              {pid}
            </div>,
            <div key={`${pid}-machine`} className={`${cell} pt-rule`}>
              <span className="pt-chip inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5">
                {logo(machine, image)}
                {machine}
              </span>
            </div>,
            <div key={`${pid}-cmd`} className={`${cell} pt-rule`} title={cmd}>
              {short(cmd)}
            </div>,
          ])}
        </div>
      </div>
    </div>
  )
}
