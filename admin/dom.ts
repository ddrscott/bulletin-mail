/**
 * Minimal `h(tag, props, children)` helper. Returns a real Element. No virtual
 * DOM — admin views imperatively replace innerHTML / call rerender(). Fine for
 * V1 scale (one tenant, dozens of groups, hundreds of members).
 */

type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown> & {
  class?: string;
  onclick?: (ev: MouseEvent) => void;
  onsubmit?: (ev: SubmitEvent) => void;
  oninput?: (ev: Event) => void;
  onchange?: (ev: Event) => void;
};

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.setAttribute("class", String(v));
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k.startsWith("on") && typeof v === "function") {
        el.addEventListener(k.slice(2), v as EventListener);
      } else if (k === "value" && el instanceof HTMLInputElement) {
        el.value = String(v);
      } else {
        el.setAttribute(k, String(v));
      }
    }
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) appendChildren(parent, child);
    else if (child instanceof Node) parent.appendChild(child);
    else parent.appendChild(document.createTextNode(String(child)));
  }
}

export function mount(parent: HTMLElement, node: Node): void {
  parent.replaceChildren(node);
}

/**
 * Build a Gravatar `<img>` for an email. The src is set asynchronously
 * because SHA-256 (Web Crypto) is async. The element renders immediately
 * with a transparent placeholder; once the hash resolves, src is updated.
 */
export function gravatarImg(email: string, size = 32): HTMLImageElement {
  const img = document.createElement("img");
  img.className = "avatar";
  img.width = size;
  img.height = size;
  img.alt = "";
  img.loading = "lazy";
  img.decoding = "async";
  void (async () => {
    const enc = new TextEncoder();
    const buf = await crypto.subtle.digest("SHA-256", enc.encode(email.trim().toLowerCase()));
    const bytes = new Uint8Array(buf);
    let hash = "";
    for (let i = 0; i < bytes.length; i++) hash += bytes[i]!.toString(16).padStart(2, "0");
    img.src = `https://gravatar.com/avatar/${hash}?d=identicon&s=${size * 2}`;
  })();
  return img;
}

export function fmtDate(ms: number | null): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, sameYear
    ? { month: "short", day: "numeric" }
    : { year: "numeric", month: "short", day: "numeric" });
}
