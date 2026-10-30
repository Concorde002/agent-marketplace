import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  agentStateFilePath,
  FileAgentStateStore,
  MAX_SEEN_KEYS,
  MemoryAgentStateStore,
} from "../../src/agents/store.js";

async function withTempDir<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "agent-state-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("memory store round-trips cursor, seen keys and reports", async () => {
  const store = new MemoryAgentStateStore();

  assert.equal(await store.getCursor(), undefined);
  await store.setCursor("cursor-1");
  assert.equal(await store.getCursor(), "cursor-1");

  assert.equal(await store.hasSeen("event-1"), false);
  await store.markSeen("event-1");
  assert.equal(await store.hasSeen("event-1"), true);

  assert.equal(await store.getReport("order-1:paid"), undefined);
  await store.putReport("order-1:paid", "agreed and sandbox-paid");
  assert.equal(
    await store.getReport("order-1:paid"),
    "agreed and sandbox-paid",
  );
});

test("memory store bounds the seen list to the most recent keys", async () => {
  const store = new MemoryAgentStateStore();

  for (let index = 0; index < MAX_SEEN_KEYS + 10; index += 1) {
    await store.markSeen(`event-${index}`);
  }

  assert.equal(await store.hasSeen("event-0"), false);
  assert.equal(await store.hasSeen("event-9"), false);
  assert.equal(await store.hasSeen("event-10"), true);
  assert.equal(
    await store.hasSeen(`event-${MAX_SEEN_KEYS + 9}`),
    true,
  );
});

test("memory store moves repeated seen keys to the most recent position", async () => {
  const store = new MemoryAgentStateStore(3);

  await store.markSeen("a");
  await store.markSeen("b");
  await store.markSeen("a");
  await store.markSeen("c");
  assert.equal(await store.hasSeen("a"), true);
  assert.equal(await store.hasSeen("b"), true);

  await store.markSeen("d");
  assert.equal(await store.hasSeen("a"), true);
  assert.equal(await store.hasSeen("b"), false);
  assert.equal(await store.hasSeen("c"), true);
  assert.equal(await store.hasSeen("d"), true);
});

test("file store round-trips and writes the documented JSON shape", async () => {
  await withTempDir(async (directory) => {
    const filePath = agentStateFilePath(directory);
    const store = new FileAgentStateStore(filePath);

    await store.setCursor("cursor-42");
    await store.markSeen("event-1");
    await store.markSeen("event-2");
    await store.putReport("order-9:paid", "agreed and sandbox-paid");

    const reopened = new FileAgentStateStore(filePath);
    assert.equal(await reopened.getCursor(), "cursor-42");
    assert.equal(await reopened.hasSeen("event-1"), true);
    assert.equal(await reopened.hasSeen("event-2"), true);
    assert.equal(
      await reopened.getReport("order-9:paid"),
      "agreed and sandbox-paid",
    );

    const persisted = JSON.parse(await readFile(filePath, "utf8")) as {
      cursor: string;
      seen: string[];
      reports: Record<string, string>;
    };
    assert.equal(persisted.cursor, "cursor-42");
    assert.deepEqual(persisted.seen, ["event-1", "event-2"]);
    assert.deepEqual(persisted.reports, {
      "order-9:paid": "agreed and sandbox-paid",
    });
    assert.deepEqual(await readdir(directory), ["state.json"]);
  });
});

test("file store creates missing parent directories", async () => {
  await withTempDir(async (directory) => {
    const filePath = join(directory, "nested", "agent", "state.json");
    const store = new FileAgentStateStore(filePath);
    await store.setCursor("cursor-nested");
    const reopened = new FileAgentStateStore(filePath);
    assert.equal(await reopened.getCursor(), "cursor-nested");
  });
});

test("file store leaves no temporary files after repeated rewrites", async () => {
  await withTempDir(async (directory) => {
    const filePath = agentStateFilePath(directory);
    const store = new FileAgentStateStore(filePath);

    for (let index = 0; index < 20; index += 1) {
      await store.markSeen(`event-${index}`);
      await store.setCursor(`cursor-${index}`);
    }

    assert.deepEqual(await readdir(directory), ["state.json"]);
    const persisted = JSON.parse(await readFile(filePath, "utf8")) as {
      cursor: string;
    };
    assert.equal(persisted.cursor, "cursor-19");
  });
});

test("file store tolerates a missing file", async () => {
  await withTempDir(async (directory) => {
    const store = new FileAgentStateStore(agentStateFilePath(directory));
    assert.equal(await store.getCursor(), undefined);
    assert.equal(await store.hasSeen("missing"), false);
    assert.equal(await store.getReport("missing"), undefined);
  });
});

test("file store tolerates corrupt JSON and malformed shapes", async () => {
  await withTempDir(async (directory) => {
    const filePath = agentStateFilePath(directory);
    await writeFile(filePath, "{ this is not json", "utf8");

    const store = new FileAgentStateStore(filePath);
    assert.equal(await store.getCursor(), undefined);
    assert.equal(await store.hasSeen("event-1"), false);
    await store.setCursor("cursor-recovered");
    await store.markSeen("event-1");

    const reopened = new FileAgentStateStore(filePath);
    assert.equal(await reopened.getCursor(), "cursor-recovered");
    assert.equal(await reopened.hasSeen("event-1"), true);

    await writeFile(
      filePath,
      JSON.stringify({ cursor: 7, seen: "nope", reports: [] }),
      "utf8",
    );
    const malformed = new FileAgentStateStore(filePath);
    assert.equal(await malformed.getCursor(), undefined);
    await malformed.markSeen("event-2");
    assert.equal(await malformed.hasSeen("event-2"), true);
  });
});

test("file store bounds the seen list using its configured limit", async () => {
  await withTempDir(async (directory) => {
    const filePath = agentStateFilePath(directory);
    const store = new FileAgentStateStore(filePath, { maxSeenKeys: 3 });

    for (const key of ["a", "b", "c", "d"]) {
      await store.markSeen(key);
    }

    const persisted = JSON.parse(await readFile(filePath, "utf8")) as {
      seen: string[];
    };
    assert.deepEqual(persisted.seen, ["b", "c", "d"]);
  });
});

test("file store serialises concurrent writes without losing keys", async () => {
  await withTempDir(async (directory) => {
    const filePath = agentStateFilePath(directory);
    const store = new FileAgentStateStore(filePath);

    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        store.markSeen(`event-${index}`),
      ),
    );

    const reopened = new FileAgentStateStore(filePath);
    for (let index = 0; index < 25; index += 1) {
      assert.equal(await reopened.hasSeen(`event-${index}`), true);
    }
  });
});

test("store constructors reject invalid seen limits", () => {
  assert.throws(() => new MemoryAgentStateStore(0), RangeError);
  assert.throws(
    () => new FileAgentStateStore("/tmp/nope.json", { maxSeenKeys: -1 }),
    RangeError,
  );
});
