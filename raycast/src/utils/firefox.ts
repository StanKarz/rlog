import fs from "fs";
import path from "path";
import os from "os";
import ini from "ini";
import lz4js from "lz4js";

interface FirefoxTab {
  entries: { url: string; title?: string }[];
  index: number; // 1-based index of active entry
}

interface FirefoxWindow {
  tabs: FirefoxTab[];
  selected?: number; // 1-based index of the active tab in this window
  isPrivate?: boolean;
}

interface FirefoxSession {
  windows: FirefoxWindow[];
  selectedWindow?: number; // 1-based index of the focused window
}

/**
 * Resolve candidate profile directories from profiles.ini, best guess first.
 *
 * `[Install<hash>]` sections point at the profile Firefox is actually using and are
 * the most reliable signal, so they take precedence over `Profile*.Default=1` — a
 * profile can be flagged default yet never have been launched, in which case it has
 * no session store at all.
 */
export function getProfileCandidates(firefoxDir: string): string[] {
  const profilesIniPath = path.join(firefoxDir, "profiles.ini");

  if (!fs.existsSync(profilesIniPath)) {
    console.log("Firefox profiles.ini not found");
    return [];
  }

  const profilesData = ini.parse(fs.readFileSync(profilesIniPath, "utf-8"));
  const resolve = (p: string, isRelative: unknown) =>
    isRelative === "1" || isRelative === 1 ? path.join(firefoxDir, p) : p;

  const preferred: string[] = [];
  const fallback: string[] = [];

  for (const key in profilesData) {
    const section = profilesData[key];

    if (key.startsWith("Install") && section.Default) {
      const resolved = path.isAbsolute(section.Default)
        ? section.Default
        : path.join(firefoxDir, section.Default);
      preferred.unshift(resolved);
    } else if (key.startsWith("Profile") && section.Path) {
      const resolved = resolve(section.Path, section.IsRelative);
      if (section.Default === "1" || section.Default === 1) {
        preferred.push(resolved);
      } else {
        fallback.push(resolved);
      }
    }
  }

  return [...preferred, ...fallback];
}

/** Locate the newest session store among the candidate profiles. */
export function findRecoveryFile(firefoxDir: string): string | null {
  for (const candidate of getProfileCandidates(firefoxDir)) {
    if (!candidate || !fs.existsSync(candidate)) continue;

    const recoveryPath = path.join(
      candidate,
      "sessionstore-backups",
      "recovery.jsonlz4",
    );
    if (fs.existsSync(recoveryPath)) return recoveryPath;
  }

  return null;
}

/**
 * Decode a Mozilla `jsonlz4` file.
 *
 * The layout is an 8-byte `mozLz40\0` magic, a little-endian uint32 giving the
 * decompressed size, then a raw LZ4 *block*. It is not an LZ4 *frame*, so it has to
 * be decoded with `decompressBlock` into a correctly sized buffer rather than with
 * the frame-level `decompress`.
 */
export function readSessionStore(recoveryPath: string): FirefoxSession | null {
  const fileBuffer = fs.readFileSync(recoveryPath);

  if (fileBuffer.subarray(0, 8).toString("utf8") !== "mozLz40\0") {
    console.log("Invalid magic header in recovery.jsonlz4");
    return null;
  }

  const decompressedSize = fileBuffer.readUInt32LE(8);
  const compressed = fileBuffer.subarray(12);
  const decompressed = new Uint8Array(decompressedSize);

  lz4js.decompressBlock(compressed, decompressed, 0, compressed.length, 0);

  return JSON.parse(Buffer.from(decompressed).toString("utf8"));
}

/**
 * Collect the current URL of every open tab in a session.
 *
 * Private-browsing windows are skipped defensively. Firefox does not persist
 * private windows to the session store in the first place, so in practice they
 * never reach here — but a fork or future version that did must not leak private
 * URLs into a public reading log. Closed tabs and closed windows (`_closedTabs`,
 * `_closedWindows`) are ignored: only live `window.tabs` are read.
 */
export function extractTabUrls(session: FirefoxSession): string[] {
  const urls: string[] = [];

  for (const window of session.windows) {
    if (window.isPrivate) continue;

    for (const tab of window.tabs) {
      // tab.entries is history for that tab; tab.index is the current position (1-based).
      const activeEntryIndex = (tab.index || 1) - 1;
      const entry = tab.entries?.[activeEntryIndex];
      if (entry?.url) {
        urls.push(entry.url);
      }
    }
  }

  return urls;
}

export function getFirefoxTabs(): string[] {
  try {
    const firefoxDir = path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Firefox",
    );

    const recoveryPath = findRecoveryFile(firefoxDir);
    if (!recoveryPath) {
      console.log("recovery.jsonlz4 not found in any Firefox profile");
      return [];
    }

    const session = readSessionStore(recoveryPath);
    if (!session) return [];

    return extractTabUrls(session);
  } catch (e) {
    console.error("Error reading Firefox session:", e);
    return [];
  }
}

/**
 * The URL of the currently-focused tab within a session.
 *
 * `selectedWindow` (1-based) identifies the focused window; `window.selected`
 * (1-based) the active tab within it. Falls back to the first window if
 * `selectedWindow` is absent. Private windows are never returned.
 */
export function getActiveTabUrl(session: FirefoxSession): string | null {
  const windowIndex = (session.selectedWindow || 1) - 1;
  const window = session.windows[windowIndex] ?? session.windows[0];
  if (!window || window.isPrivate) return null;

  const tab = window.tabs[(window.selected || 1) - 1];
  const entry = tab?.entries?.[(tab.index || 1) - 1];
  return entry?.url ?? null;
}

/**
 * The active tab's URL, read from the on-disk session store.
 *
 * Firefox exposes no AppleScript API for reading the active tab, so the session
 * store is the only way to get it without a browser add-on. It is flushed to disk
 * periodically (~every 15s and on navigation), so a tab opened in the last few
 * seconds may not appear yet — this is the best available for Firefox.
 */
export function getFirefoxActiveUrl(): string | null {
  try {
    const firefoxDir = path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Firefox",
    );

    const recoveryPath = findRecoveryFile(firefoxDir);
    if (!recoveryPath) return null;

    const session = readSessionStore(recoveryPath);
    if (!session) return null;

    return getActiveTabUrl(session);
  } catch (e) {
    console.error("Error reading Firefox active tab:", e);
    return null;
  }
}
