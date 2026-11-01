import { esc } from "../format";

/** Transient toast message. */
export function toast(msg: string): void {
  let el = document.getElementById("fs-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "fs-toast";
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add("show");
  const anyEl = el as HTMLElement & { _t?: number };
  clearTimeout(anyEl._t);
  anyEl._t = window.setTimeout(() => el && el.classList.remove("show"), 1600);
}

/** Short buzzer + vibration for shift changes. Best-effort; never throws. */
export function beep(): void {
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    const ctx = new Ctx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g);
    g.connect(ctx.destination);
    o.type = "sine";
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    o.start();
    o.stop(ctx.currentTime + 0.36);
  } catch {
    /* audio unavailable */
  }
  if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
}

/** Trigger a client-side file download. */
export function download(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 500);
}

export interface PickOption<T> {
  label: string;
  sub?: string;
  value: T;
}

export type PickResult<T> = { cancelled: false; value: T } | { cancelled: true };

function ensureModal(): { bg: HTMLElement; title: HTMLElement; body: HTMLElement } {
  let bg = document.getElementById("fs-modal");
  if (!bg) {
    bg = document.createElement("div");
    bg.id = "fs-modal";
    bg.className = "modal-bg";
    bg.innerHTML = `<div class="modal">
      <div class="row between"><h2 id="fs-modal-title">Pick</h2>
      <button class="sm ghost" id="fs-modal-close">Close</button></div>
      <div id="fs-modal-body"></div></div>`;
    document.body.appendChild(bg);
  }
  return {
    bg,
    title: document.getElementById("fs-modal-title") as HTMLElement,
    body: document.getElementById("fs-modal-body") as HTMLElement,
  };
}

/** Modal picker. Resolves with the chosen value, or `{cancelled:true}`. */
export function openPicker<T>(
  title: string,
  options: PickOption<T>[],
): Promise<PickResult<T>> {
  const { bg, title: titleEl, body } = ensureModal();
  titleEl.textContent = title;
  body.innerHTML = "";
  const grid = document.createElement("div");
  grid.className = "pickgrid";

  return new Promise((resolve) => {
    const close = (result: PickResult<T>): void => {
      bg.classList.remove("open");
      bg.onclick = null;
      (document.getElementById("fs-modal-close") as HTMLElement).onclick = null;
      resolve(result);
    };
    options.forEach((o) => {
      const b = document.createElement("button");
      b.innerHTML =
        esc(o.label) + (o.sub ? `<span class="sub">${esc(o.sub)}</span>` : "");
      b.onclick = () => close({ cancelled: false, value: o.value });
      grid.appendChild(b);
    });
    body.appendChild(grid);
    (document.getElementById("fs-modal-close") as HTMLElement).onclick = () =>
      close({ cancelled: true });
    bg.onclick = (e) => {
      if (e.target === bg) close({ cancelled: true });
    };
    bg.classList.add("open");
  });
}

/** Read-only info modal. */
export function openInfo(title: string, html: string): void {
  const { bg, title: titleEl, body } = ensureModal();
  titleEl.textContent = title;
  body.innerHTML = html;
  const close = (): void => bg.classList.remove("open");
  (document.getElementById("fs-modal-close") as HTMLElement).onclick = close;
  bg.onclick = (e) => {
    if (e.target === bg) close();
  };
  bg.classList.add("open");
}
