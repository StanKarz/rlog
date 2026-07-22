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
}

interface FirefoxSession {
  windows: FirefoxWindow[];
}

/**
 * Resolve candidate profile directories from profiles.ini, best guess first.
 *
 * `[Install<hash>]` sections point at the profile Firefox is actually using and are
 * the most reliable signal, so they take precedence over `Profile*.Default=1` — a
 * profile can be flagged default yet never have been launched, in which case it has
 * no session store at all.
 */
function getProfileCandidates(firefoxDir: string): string[] {
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
function findRecoveryFile(firefoxDir: string): string | null {
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
function readSessionStore(recoveryPath: string): FirefoxSession | null {
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

    const urls: string[] = [];

    // Extract URLs from all windows and tabs
    for (const window of session.windows) {
      for (const tab of window.tabs) {
        // tab.entries is history for that tab. tab.index is the current position (1-based)
        const activeEntryIndex = (tab.index || 1) - 1;
        if (tab.entries && tab.entries[activeEntryIndex]) {
          const url = tab.entries[activeEntryIndex].url;
          if (url) {
            urls.push(url);
          }
        }
      }
    }

    return urls;
  } catch (e) {
    console.error("Error reading Firefox session:", e);
    return [];
  }
}
