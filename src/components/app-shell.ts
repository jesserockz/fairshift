import { store } from "../store";
import { checkTeamHash } from "./share-ui";
import type { Tab } from "./base";

const TABS: { id: Tab; label: string }[] = [
  { id: "setup", label: "Setup" },
  { id: "plan", label: "Schedule" },
  { id: "live", label: "Live" },
  { id: "history", label: "History" },
];

/** Top-level shell: header, tab bar, and the mounted views. */
export class AppShell extends HTMLElement {
  private tab: Tab = store.state.live ? "live" : "setup";

  connectedCallback(): void {
    this.render();
    this.addEventListener("fs-navigate", (e) => {
      this.tab = (e as CustomEvent<{ tab: Tab }>).detail.tab;
      this.applyTab();
    });
    store.onSaved(() => this.flashSaved());
    // Shared-team links arrive as #team=...; tabs are in-memory only, so no clash.
    window.addEventListener("hashchange", this.onHashChange);
    void checkTeamHash();
  }

  disconnectedCallback(): void {
    window.removeEventListener("hashchange", this.onHashChange);
  }

  private onHashChange = (): void => {
    void checkTeamHash();
  };

  private render(): void {
    this.innerHTML = `
    <header>
      <div class="brand">
        <div class="logo">FS</div>
        <div>
          <div class="name">FairShift</div>
          <div class="tag">Fair sub rotation &amp; game stats</div>
        </div>
        <div class="spacer"></div>
        <button class="sm ghost" id="savedInd" title="Everything is saved automatically">Saved &#10003;</button>
      </div>
      <nav class="tabs">
        ${TABS.map((t) => `<button data-tab="${t.id}">${t.label}</button>`).join("")}
      </nav>
    </header>
    <main>
      <section class="view" data-tab="setup"><fs-setup></fs-setup></section>
      <section class="view" data-tab="plan"><fs-schedule></fs-schedule></section>
      <section class="view" data-tab="live"><fs-live></fs-live></section>
      <section class="view" data-tab="history"><fs-history></fs-history></section>
    </main>`;

    this.querySelectorAll<HTMLButtonElement>("nav.tabs button").forEach((b) => {
      b.onclick = () => {
        this.tab = b.dataset.tab as Tab;
        this.applyTab();
      };
    });
    this.applyTab();
  }

  private applyTab(): void {
    this.querySelectorAll<HTMLElement>("nav.tabs button").forEach((b) =>
      b.classList.toggle("active", b.dataset.tab === this.tab),
    );
    this.querySelectorAll<HTMLElement>(".view").forEach((v) =>
      v.classList.toggle("active", v.dataset.tab === this.tab),
    );
    window.scrollTo(0, 0);
  }

  private flashSaved(): void {
    const el = this.querySelector<HTMLElement>("#savedInd");
    if (!el) return;
    el.style.color = "var(--us)";
    clearTimeout((el as HTMLElement & { _t?: number })._t);
    (el as HTMLElement & { _t?: number })._t = window.setTimeout(() => {
      el.style.color = "";
    }, 800);
  }
}

customElements.define("fair-shift-app", AppShell);
