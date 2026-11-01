import { store } from "../store";
import { esc } from "../format";
import {
  ShareError,
  buildShareLink,
  decodeTeam,
  qrSvg,
  teamPayloadFromHash,
} from "../share";
import type { Team } from "../types";
import { openInfo, openPicker, toast } from "./ui";

/** Copy the link, or select the read-only box so it can be copied by hand. */
async function copyLink(link: string, box: HTMLInputElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(link);
    toast("Link copied");
  } catch {
    box.focus();
    box.select();
    toast("Copy the selected link");
  }
}

/** Modal with a QR code and the share link for a team. */
export async function openShareModal(team: Team): Promise<void> {
  let link: string;
  try {
    link = await buildShareLink(team, location.origin + location.pathname);
  } catch (e) {
    toast((e as ShareError).message);
    return;
  }
  const svg = qrSvg(link);
  openInfo(
    "Share team",
    `<div class="qr">${svg ?? "<p>Too long for a QR code - use the link instead.</p>"}</div>
    <input type="text" id="shareLink" readonly value="${esc(link)}" />
    <div class="row" style="margin-top:8px">
      <button class="primary" id="btnCopyLink">Copy link</button>
      ${"share" in navigator ? `<button id="btnNativeShare">Share...</button>` : ""}
    </div>
    <div class="hint">The link contains the players' names, so only share it with people you trust.</div>`,
  );
  const box = document.getElementById("shareLink") as HTMLInputElement;
  document.getElementById("btnCopyLink")!.onclick = () => void copyLink(link, box);
  const native = document.getElementById("btnNativeShare");
  if (native) {
    native.onclick = async () => {
      try {
        await navigator.share({ title: "FairShift team: " + team.name, url: link });
      } catch {
        /* share sheet dismissed */
      }
    };
  }
}

/** Drop the fragment so a refresh does not re-prompt and names leave the address bar. */
function clearHash(): void {
  history.replaceState(null, "", location.pathname + location.search);
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** If the URL fragment holds a shared team, offer to add it. Always clears the fragment. */
export async function checkTeamHash(): Promise<void> {
  const payload = teamPayloadFromHash(location.hash);
  if (payload === null) return;
  clearHash();
  try {
    const shared = await decodeTeam(payload);
    const res = await openPicker(
      `Add team ${shared.name}? ${plural(shared.players.length, "player")}, ${plural(shared.positions.length, "position")}`,
      [
        { label: "Add", value: true },
        { label: "Cancel", value: false },
      ],
    );
    if (res.cancelled || !res.value) return;
    const added = store.addSharedTeam(shared);
    toast("Added team " + added.name);
  } catch (e) {
    toast((e as ShareError).message);
  }
}
