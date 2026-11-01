/**
 * Progressive-web-app glue: registers the service worker (production, served
 * over http/https only) and shows a small "new version - reload" bar when an
 * updated worker is waiting. Excluded from coverage (browser/SW runtime).
 */

function showReloadBar(registration: ServiceWorkerRegistration): void {
  if (document.getElementById("fs-update-bar")) return;
  const bar = document.createElement("div");
  bar.id = "fs-update-bar";
  bar.className = "update-bar";
  bar.innerHTML = `
    <span>New version available.</span>
    <button id="fs-update-reload">Reload</button>
    <button id="fs-update-dismiss" class="x" aria-label="Dismiss">&times;</button>`;
  document.body.appendChild(bar);

  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });

  (bar.querySelector("#fs-update-reload") as HTMLButtonElement).onclick = () => {
    const waiting = registration.waiting;
    if (waiting) waiting.postMessage({ type: "SKIP_WAITING" });
    else location.reload();
  };
  (bar.querySelector("#fs-update-dismiss") as HTMLButtonElement).onclick = () =>
    bar.remove();
}

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (!("serviceWorker" in navigator)) return;
  if (location.protocol !== "http:" && location.protocol !== "https:") return;

  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register(import.meta.env.BASE_URL + "sw.js")
      .then((registration) => {
        // A worker already waiting (from a previous visit) means an update is ready.
        if (registration.waiting && navigator.serviceWorker.controller) {
          showReloadBar(registration);
        }
        registration.addEventListener("updatefound", () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            if (installing.state === "installed" && navigator.serviceWorker.controller) {
              showReloadBar(registration);
            }
          });
        });
      })
      .catch(() => {
        /* registration failed; app still works online */
      });
  });
}
