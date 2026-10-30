import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** Maximum number of recent event keys retained by a store. */
export const MAX_SEEN_KEYS = 500;

const STATE_FILE_NAME = "state.json";

export interface AgentStateStore {
  getCursor(): Promise<string | undefined>;
  setCursor(cursor: string): Promise<void>;
  hasSeen(key: string): Promise<boolean>;
  markSeen(key: string): Promise<void>;
  getReport(key: string): Promise<string | undefined>;
  putReport(key: string, value: string): Promise<void>;
}

export interface FileAgentStateStoreOptions {
  maxSeenKeys?: number;
}

interface PersistedState {
  cursor: string;
  seen: string[];
  reports: Record<string, string>;
}

function emptyState(): PersistedState {
  return {
    cursor: "",
    seen: [],
    reports: Object.create(null) as Record<string, string>,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeMaxSeenKeys(value: number | undefined): number {
  if (value === undefined) {
    return MAX_SEEN_KEYS;
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("maxSeenKeys must be a positive safe integer");
  }
  return value;
}

function normalizeSeenKeys(values: readonly unknown[], maxSeenKeys: number): string[] {
  const unique: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const existing = unique.indexOf(value);
    if (existing !== -1) {
      unique.splice(existing, 1);
    }
    unique.push(value);
  }
  return unique.slice(-maxSeenKeys);
}

function appendSeenKey(seen: readonly string[], key: string, maxSeenKeys: number): string[] {
  const unique: string[] = [];
  for (const value of seen) {
    if (value !== key) {
      unique.push(value);
    }
  }
  unique.push(key);
  return unique.slice(-maxSeenKeys);
}

function normalizeReports(value: unknown): Record<string, string> {
  const reports = Object.create(null) as Record<string, string>;
  if (!isRecord(value)) {
    return reports;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      reports[key] = entry;
    }
  }
  return reports;
}

function parseState(text: string, maxSeenKeys: number): PersistedState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptyState();
  }
  if (!isRecord(parsed)) {
    return emptyState();
  }
  return {
    cursor: typeof parsed.cursor === "string" ? parsed.cursor : "",
    seen: Array.isArray(parsed.seen)
      ? normalizeSeenKeys(parsed.seen, maxSeenKeys)
      : [],
    reports: normalizeReports(parsed.reports),
  };
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

/** Location used by callers that supply `AGENT_STATE_DIR`. */
export function agentStateFilePath(stateDir: string): string {
  return join(stateDir, STATE_FILE_NAME);
}

/** In-memory store for tests and short-lived processes. */
export class MemoryAgentStateStore implements AgentStateStore {
  private readonly maxSeenKeys: number;
  private state: PersistedState = emptyState();

  constructor(maxSeenKeys: number = MAX_SEEN_KEYS) {
    this.maxSeenKeys = normalizeMaxSeenKeys(maxSeenKeys);
  }

  async getCursor(): Promise<string | undefined> {
    return this.state.cursor === "" ? undefined : this.state.cursor;
  }

  async setCursor(cursor: string): Promise<void> {
    if (typeof cursor !== "string") {
      throw new TypeError("cursor must be a string");
    }
    this.state = { ...this.state, cursor };
  }

  async hasSeen(key: string): Promise<boolean> {
    return this.state.seen.includes(key);
  }

  async markSeen(key: string): Promise<void> {
    if (typeof key !== "string" || key === "") {
      throw new TypeError("seen key must be a non-empty string");
    }
    this.state = {
      ...this.state,
      seen: appendSeenKey(this.state.seen, key, this.maxSeenKeys),
    };
  }

  async getReport(key: string): Promise<string | undefined> {
    const value = this.state.reports[key];
    return typeof value === "string" ? value : undefined;
  }

  async putReport(key: string, value: string): Promise<void> {
    if (typeof key !== "string" || key === "") {
      throw new TypeError("report key must be a non-empty string");
    }
    this.state = {
      ...this.state,
      reports: { ...this.state.reports, [key]: value },
    };
  }
}

/**
 * File-backed store. Writes go to a temporary file in the same directory and
 * are atomically renamed into place. Missing or corrupt files start empty.
 */
export class FileAgentStateStore implements AgentStateStore {
  private readonly filePath: string;
  private readonly maxSeenKeys: number;
  private state: PersistedState | undefined;
  private loadPromise: Promise<PersistedState> | undefined;
  private writeQueue: Promise<void> = Promise.resolve();
  private tempSequence = 0;

  constructor(
    filePath: string,
    options: FileAgentStateStoreOptions = {},
  ) {
    if (typeof filePath !== "string" || filePath.trim() === "") {
      throw new TypeError("filePath must be a non-empty string");
    }
    this.filePath = filePath;
    this.maxSeenKeys = normalizeMaxSeenKeys(options.maxSeenKeys);
  }

  async getCursor(): Promise<string | undefined> {
    const state = await this.getState();
    return state.cursor === "" ? undefined : state.cursor;
  }

  async setCursor(cursor: string): Promise<void> {
    if (typeof cursor !== "string") {
      throw new TypeError("cursor must be a string");
    }
    await this.withLock(async () => {
      const state = await this.getState();
      const next: PersistedState = { ...state, cursor };
      await this.writeState(next);
      this.state = next;
    });
  }

  async hasSeen(key: string): Promise<boolean> {
    const state = await this.getState();
    return state.seen.includes(key);
  }

  async markSeen(key: string): Promise<void> {
    if (typeof key !== "string" || key === "") {
      throw new TypeError("seen key must be a non-empty string");
    }
    await this.withLock(async () => {
      const state = await this.getState();
      if (state.seen[state.seen.length - 1] === key) {
        return;
      }
      const next: PersistedState = {
        ...state,
        seen: appendSeenKey(state.seen, key, this.maxSeenKeys),
      };
      await this.writeState(next);
      this.state = next;
    });
  }

  async getReport(key: string): Promise<string | undefined> {
    const state = await this.getState();
    const value = state.reports[key];
    return typeof value === "string" ? value : undefined;
  }

  async putReport(key: string, value: string): Promise<void> {
    if (typeof key !== "string" || key === "") {
      throw new TypeError("report key must be a non-empty string");
    }
    await this.withLock(async () => {
      const state = await this.getState();
      const next: PersistedState = {
        ...state,
        reports: { ...state.reports, [key]: value },
      };
      await this.writeState(next);
      this.state = next;
    });
  }

  private async getState(): Promise<PersistedState> {
    if (this.state !== undefined) {
      return this.state;
    }
    this.loadPromise ??= this.readState();
    this.state = await this.loadPromise;
    return this.state;
  }

  private async readState(): Promise<PersistedState> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        return emptyState();
      }
      throw error;
    }
    return parseState(text, this.maxSeenKeys);
  }

  private async writeState(state: PersistedState): Promise<void> {
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true });
    const temporaryPath = join(
      directory,
      `.${basename(this.filePath)}.${process.pid}.${this.tempSequence}.tmp`,
    );
    this.tempSequence += 1;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, "utf8");
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private withLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
