export const Run = ({ children }) => {
  const copy = (event) => {
    if (!event.target.closest('[data-testid="copy-code-button"]')) return
    const code = event.currentTarget.querySelector("pre")
    if (!code || !navigator.clipboard) return
    const text = code.textContent.replace(/\n+$/, "")
    setTimeout(() => navigator.clipboard.writeText(`run <<'SH'\n${text}\nSH\n`), 0)
  }
  return <div onClick={copy}>{children}</div>
}
