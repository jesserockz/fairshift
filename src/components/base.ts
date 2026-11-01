import { store } from "../store";

export type Tab = "setup" | "plan" | "live" | "history";

/** Base custom element: re-renders on store changes and can request navigation. */
export abstract class View extends HTMLElement {
  private unsub?: () => void;

  connectedCallback(): void {
    this.unsub = store.subscribe(() => this.rerender());
    this.render();
  }

  disconnectedCallback(): void {
    this.unsub?.();
  }

  /**
   * Re-render on store changes while keeping the caret in a focused field.
   * Without this, an input that writes to the store on every keystroke would
   * be torn out and recreated mid-type, losing focus after each letter.
   */
  private rerender(): void {
    const active = document.activeElement;
    const focused =
      active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
    const restore =
      focused && active.id && this.contains(active)
        ? { id: active.id, start: active.selectionStart, end: active.selectionEnd }
        : null;

    this.render();

    if (restore) {
      const el = this.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        "#" + CSS.escape(restore.id),
      );
      if (el) {
        el.focus();
        try {
          el.setSelectionRange(restore.start, restore.end);
        } catch {
          /* not a text field that supports selection */
        }
      }
    }
  }

  protected navigate(tab: Tab): void {
    this.dispatchEvent(
      new CustomEvent("fs-navigate", {
        detail: { tab },
        bubbles: true,
        composed: true,
      }),
    );
  }

  abstract render(): void;
}
