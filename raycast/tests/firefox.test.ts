import fs from "fs";
import os from "os";
import path from "path";
import lz4js from "lz4js";

import {
  getProfileCandidates,
  findRecoveryFile,
  readSessionStore,
  extractTabUrls,
  getActiveTabUrl,
} from "../src/utils/firefox";

// ── fixture helpers ───────────────────────────────────────────────────────────

/** Encode a string as a Mozilla `jsonlz4` file: magic + LE uint32 size + LZ4 block. */
function encodeMozLz4(str: string): Buffer {
  const input = Buffer.from(str, "utf8");
  const compressed = new Uint8Array(lz4js.compressBound(input.length));
  const hashTable = new Uint32Array(1 << 16);
  const n = lz4js.compressBlock(input, compressed, 0, input.length, hashTable);

  const header = Buffer.alloc(12);
  header.write("mozLz40\0", 0, "binary");
  header.writeUInt32LE(input.length, 8);
  return Buffer.concat([header, Buffer.from(compressed.subarray(0, n))]);
}

let tmpRoot: string;

/** A throwaway Firefox dir with the given profiles.ini contents. */
function makeFirefoxDir(profilesIni: string): string {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "ff-"));
  fs.writeFileSync(path.join(dir, "profiles.ini"), profilesIni);
  return dir;
}

/** Give a profile (relative to firefoxDir) a session store containing `session`. */
function writeSession(firefoxDir: string, relProfile: string, session: unknown): void {
  const backups = path.join(firefoxDir, relProfile, "sessionstore-backups");
  fs.mkdirSync(backups, { recursive: true });
  fs.writeFileSync(
    path.join(backups, "recovery.jsonlz4"),
    encodeMozLz4(JSON.stringify(session)),
  );
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rlog-ff-test-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ── getProfileCandidates ──────────────────────────────────────────────────────

describe("getProfileCandidates", () => {
  test("Install target ranks above a Default=1 profile", () => {
    const dir = makeFirefoxDir(`
[Profile0]
Name=default
Path=Profiles/aaa.default
IsRelative=1
Default=1

[Profile1]
Name=default-release
Path=Profiles/bbb.default-release
IsRelative=1

[Install2656FF1E876E9973]
Default=Profiles/bbb.default-release
Locked=1
`);
    const candidates = getProfileCandidates(dir).map((c) => path.basename(c));
    // Install target first, then the Default=1 profile, then the rest.
    expect(candidates[0]).toBe("bbb.default-release");
    expect(candidates).toContain("aaa.default");
  });

  test("old profiles.ini with no Install section still resolves the default", () => {
    const dir = makeFirefoxDir(`
[Profile0]
Name=default
Path=Profiles/only.default
IsRelative=1
Default=1
`);
    const candidates = getProfileCandidates(dir).map((c) => path.basename(c));
    expect(candidates).toEqual(["only.default"]);
  });

  test("no Default anywhere: every profile is still offered as a fallback", () => {
    const dir = makeFirefoxDir(`
[Profile0]
Name=a
Path=Profiles/a.x
IsRelative=1

[Profile1]
Name=b
Path=Profiles/b.y
IsRelative=1
`);
    const candidates = getProfileCandidates(dir).map((c) => path.basename(c));
    expect(candidates.sort()).toEqual(["a.x", "b.y"]);
  });

  test("absolute paths (IsRelative=0) are left untouched", () => {
    const abs = path.join(tmpRoot, "abs-profile");
    const dir = makeFirefoxDir(`
[Profile0]
Name=default
Path=${abs}
IsRelative=0
Default=1
`);
    expect(getProfileCandidates(dir)).toContain(abs);
  });

  test("multiple Install sections (release + nightly) are all considered", () => {
    const dir = makeFirefoxDir(`
[Profile0]
Name=release
Path=Profiles/r.release
IsRelative=1

[Profile1]
Name=nightly
Path=Profiles/n.nightly
IsRelative=1

[Install1111]
Default=Profiles/r.release

[Install2222]
Default=Profiles/n.nightly
`);
    const candidates = getProfileCandidates(dir).map((c) => path.basename(c));
    expect(candidates).toContain("r.release");
    expect(candidates).toContain("n.nightly");
  });

  test("missing profiles.ini returns no candidates", () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, "empty-"));
    expect(getProfileCandidates(dir)).toEqual([]);
  });
});

// ── findRecoveryFile ──────────────────────────────────────────────────────────

describe("findRecoveryFile", () => {
  test("the original bug: default profile has no session, Install target does", () => {
    const dir = makeFirefoxDir(`
[Profile0]
Name=default
Path=Profiles/aaa.default
IsRelative=1
Default=1

[Profile1]
Name=default-release
Path=Profiles/bbb.default-release
IsRelative=1

[Install2656FF1E876E9973]
Default=Profiles/bbb.default-release
`);
    // Only the Install target has a session store.
    writeSession(dir, "Profiles/bbb.default-release", { windows: [] });

    const found = findRecoveryFile(dir);
    expect(found).not.toBeNull();
    expect(found).toContain("bbb.default-release");
  });

  test("no profile has a session store: returns null", () => {
    const dir = makeFirefoxDir(`
[Profile0]
Name=default
Path=Profiles/aaa.default
IsRelative=1
Default=1
`);
    expect(findRecoveryFile(dir)).toBeNull();
  });

  test("falls through to a non-default profile that has the session", () => {
    const dir = makeFirefoxDir(`
[Profile0]
Name=default
Path=Profiles/aaa.default
IsRelative=1
Default=1

[Profile1]
Name=other
Path=Profiles/ccc.other
IsRelative=1
`);
    writeSession(dir, "Profiles/ccc.other", { windows: [] });
    expect(findRecoveryFile(dir)).toContain("ccc.other");
  });
});

// ── readSessionStore ──────────────────────────────────────────────────────────

describe("readSessionStore", () => {
  test("decodes a valid jsonlz4 session round-trip", () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, "rs-"));
    const session = { windows: [{ tabs: [{ index: 1, entries: [{ url: "https://a.test" }] }] }] };
    const file = path.join(dir, "recovery.jsonlz4");
    fs.writeFileSync(file, encodeMozLz4(JSON.stringify(session)));

    expect(readSessionStore(file)).toEqual(session);
  });

  test("rejects a file with a bad magic header", () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, "rs-"));
    const file = path.join(dir, "recovery.jsonlz4");
    fs.writeFileSync(file, Buffer.from("not-a-mozlz4-file-at-all"));

    expect(readSessionStore(file)).toBeNull();
  });

  test("handles a large realistic payload", () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, "rs-"));
    const tabs = Array.from({ length: 500 }, (_, i) => ({
      index: 1,
      entries: [{ url: `https://example.com/page-${i}` }],
    }));
    const session = { windows: [{ tabs }] };
    const file = path.join(dir, "recovery.jsonlz4");
    fs.writeFileSync(file, encodeMozLz4(JSON.stringify(session)));

    const decoded = readSessionStore(file);
    expect(decoded?.windows[0].tabs).toHaveLength(500);
  });
});

// ── extractTabUrls ────────────────────────────────────────────────────────────

describe("extractTabUrls", () => {
  test("returns the active-entry URL of every tab", () => {
    const session = {
      windows: [
        {
          tabs: [
            { index: 1, entries: [{ url: "https://one.test" }] },
            { index: 1, entries: [{ url: "https://two.test" }] },
          ],
        },
      ],
    };
    expect(extractTabUrls(session)).toEqual(["https://one.test", "https://two.test"]);
  });

  test("uses tab.index to pick the active entry from history", () => {
    const session = {
      windows: [
        {
          tabs: [
            {
              index: 2, // 1-based → second entry is active
              entries: [{ url: "https://old.test" }, { url: "https://current.test" }],
            },
          ],
        },
      ],
    };
    expect(extractTabUrls(session)).toEqual(["https://current.test"]);
  });

  test("skips private-browsing windows entirely", () => {
    const session = {
      windows: [
        { isPrivate: true, tabs: [{ index: 1, entries: [{ url: "https://secret.test" }] }] },
        { tabs: [{ index: 1, entries: [{ url: "https://public.test" }] }] },
      ],
    };
    expect(extractTabUrls(session)).toEqual(["https://public.test"]);
  });

  test("does not crash on tabs with no entries", () => {
    const session = {
      windows: [
        {
          tabs: [
            { index: 1, entries: [] },
            { index: 1, entries: [{ url: "https://ok.test" }] },
          ],
        },
      ],
    };
    expect(extractTabUrls(session)).toEqual(["https://ok.test"]);
  });

  test("empty session yields no URLs", () => {
    expect(extractTabUrls({ windows: [] })).toEqual([]);
  });
});

// ── getActiveTabUrl ───────────────────────────────────────────────────────────

describe("getActiveTabUrl", () => {
  test("selectedWindow picks the focused window, not just windows[0]", () => {
    const session = {
      selectedWindow: 2, // 1-based → second window is focused
      windows: [
        { selected: 1, tabs: [{ index: 1, entries: [{ url: "https://bg.test" }] }] },
        { selected: 1, tabs: [{ index: 1, entries: [{ url: "https://focused.test" }] }] },
      ],
    };
    expect(getActiveTabUrl(session)).toBe("https://focused.test");
  });

  test("window.selected picks the active tab within the window", () => {
    const session = {
      selectedWindow: 1,
      windows: [
        {
          selected: 2, // 1-based → second tab is active
          tabs: [
            { index: 1, entries: [{ url: "https://first.test" }] },
            { index: 1, entries: [{ url: "https://active.test" }] },
          ],
        },
      ],
    };
    expect(getActiveTabUrl(session)).toBe("https://active.test");
  });

  test("falls back to the first window when selectedWindow is absent", () => {
    const session = {
      windows: [{ selected: 1, tabs: [{ index: 1, entries: [{ url: "https://only.test" }] }] }],
    };
    expect(getActiveTabUrl(session)).toBe("https://only.test");
  });

  test("returns null when the focused window is private", () => {
    const session = {
      selectedWindow: 1,
      windows: [
        { isPrivate: true, selected: 1, tabs: [{ index: 1, entries: [{ url: "https://secret.test" }] }] },
      ],
    };
    expect(getActiveTabUrl(session)).toBeNull();
  });

  test("returns null on an empty session", () => {
    expect(getActiveTabUrl({ windows: [] })).toBeNull();
  });
});
