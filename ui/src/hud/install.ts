export const INSTALL_CMD = "curl -fsSL https://lightpath.blackpaw.studio/install.sh | sh";
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

const codeRow = (doc: Document, cmd: string, copyable: boolean): HTMLElement => {
  const row = el(doc, "div", "code-row");
  row.append(el(doc, "code", "", cmd));
  if (copyable) {
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
    row.append(btn);
  }
  return row;
};

export const isSafari = (ua: string): boolean => /safari/i.test(ua) && !/chrome|chromium|android|crios|fxios|edg/i.test(ua);

/** Static install panel; visibility is controlled by the HUD. */
export const installPanel = (doc: Document, ua: string): HTMLElement => {
  const panel = el(doc, "section", "panel install");
  panel.hidden = true;
  const link = el(doc, "a", "agent-link", "Open the agent page");
  link.href = AGENT_PAGE;
  panel.append(
    el(doc, "h2", "", "Connect the local agent"),
    el(doc, "p", "step", "1 · Install"),
    codeRow(doc, INSTALL_CMD, true),
    el(doc, "p", "step", "2 · Run"),
    codeRow(doc, "lightpath", false),
    el(doc, "p", "hint", isSafari(ua) ? SAFARI_HINT : LNA_HINT),
    link,
  );
  return panel;
};
