/** Downloads (once), verifies and runs the agent with no install; Ctrl-C stops it. */
export const RUN_CMD = "curl -fsSL https://lightpath.blackpaw.studio/run | sh";
export const RUN_NOTE = "Downloads a small helper and starts it. Ctrl-C to stop.";
export const AGENT_PAGE = "http://127.0.0.1:47800/";
export const LNA_HINT = "If your browser blocked local network access, allow it or open the agent page.";
export const SAFARI_HINT = "Safari blocks this connection from the hosted page: use the agent page.";

const el = <K extends keyof HTMLElementTagNameMap>(
  doc: Document, tag: K, cls: string, text?: string,
): HTMLElementTagNameMap[K] => {
  const e = doc.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const codeRow = (doc: Document, cmd: string): HTMLElement => {
  const row = el(doc, "div", "code-row");
  const btn = el(doc, "button", "copy", "Copy");
  btn.type = "button";
  btn.addEventListener("click", () => {
    void navigator.clipboard?.writeText(cmd).then(
      () => {
        btn.textContent = "Copied";
        setTimeout(() => { btn.textContent = "Copy"; }, 1600);
      },
      () => { btn.textContent = "Copy failed"; },
    );
  });
  row.append(el(doc, "code", "", cmd), btn);
  return row;
};

export const isSafari = (ua: string): boolean => /safari/i.test(ua) && !/chrome|chromium|android|crios|fxios|edg/i.test(ua);

/** Any iOS browser is WebKit underneath, so it gets the Safari hint. */
const needsSafariHint = (ua: string): boolean => isSafari(ua) || /iphone|ipad/i.test(ua);

/** Static install panel; visibility is controlled by the HUD. */
export const installPanel = (doc: Document, ua: string): HTMLElement => {
  const panel = el(doc, "section", "panel install");
  panel.hidden = true;
  const agentLink = el(doc, "a", "agent-link", "Open the agent page");
  agentLink.href = AGENT_PAGE;
  const installLink = el(doc, "a", "install-link", "Install permanently");
  installLink.setAttribute("href", "/install.sh");
  const links = el(doc, "div", "install-links");
  links.append(agentLink, installLink);
  panel.append(
    el(doc, "h2", "", "Connect the local agent"),
    codeRow(doc, RUN_CMD),
    el(doc, "p", "note", RUN_NOTE),
    el(doc, "p", "hint", needsSafariHint(ua) ? SAFARI_HINT : LNA_HINT),
    links,
  );
  return panel;
};
