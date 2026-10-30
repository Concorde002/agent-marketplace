/**
 * Operator-only: create a read-only observer key for one demo buyer's runs.
 *
 * It needs no database credential. It prints the key once (give it to the presenter privately) and
 * the SQL the operator runs in the database SQL editor, which stores only the key's SHA-256 hash.
 * Never commit or paste the key into a chat, prompt or repository.
 */
import { createHash, randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { OBSERVER_TOKEN_PREFIX } from "./observer.js";

const USAGE = `Usage:
  observer:operator -- issue --buyer <participant id> --label <text> [--hours 8]
  observer:operator -- revoke --session <observer session id>`;

const MAX_HOURS = 7 * 24;

export function issueObserverKey(input: { buyer: string; label: string; hours: number; createdBy: string; now?: Date }) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.buyer)) throw new Error("--buyer must be a participant id");
  const label = input.label.trim();
  if (label.length < 1 || label.length > 80 || /['\\]/.test(label)) throw new Error("--label must be 1-80 characters without quotes or backslashes");
  if (!Number.isFinite(input.hours) || input.hours <= 0 || input.hours > MAX_HOURS) throw new Error(`--hours must be between 0 and ${MAX_HOURS}`);
  const token = `${OBSERVER_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const hash = createHash("sha256").update(token).digest("hex");
  const createdAt = input.now ?? new Date();
  const expiresAt = new Date(createdAt.getTime() + input.hours * 3_600_000);
  const sql = `insert into marketplace.observer_sessions (token_hash, buyer_participant_id, label, created_by, created_at, expires_at)
values ('${hash}', '${input.buyer}', '${label}', '${input.createdBy}', '${createdAt.toISOString()}', '${expiresAt.toISOString()}')
returning id, expires_at;`;
  return { token, sql, expiresAt: expiresAt.toISOString() };
}

const isEntryPoint = import.meta.url === new URL(process.argv[1] ?? "", "file://").href;
if (isEntryPoint) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { buyer: { type: "string" }, label: { type: "string" }, hours: { type: "string" }, session: { type: "string" } },
  });
  try {
    if (positionals[0] === "issue" && values.buyer && values.label) {
      const issued = issueObserverKey({ buyer: values.buyer, label: values.label, hours: Number(values.hours ?? 8), createdBy: "operator-cli" });
      console.log(`Observer key (shown once; read-only, expires ${issued.expiresAt}):\n${issued.token}\n`);
      console.log(`Run in the database SQL editor:\n${issued.sql}`);
    } else if (positionals[0] === "revoke" && values.session && /^[A-Za-z0-9-]{1,64}$/.test(values.session)) {
      console.log(`Run in the database SQL editor:\nupdate marketplace.observer_sessions set revoked_at = now() where id = '${values.session}' and revoked_at is null;`);
    } else {
      console.error(USAGE);
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "failed");
    process.exitCode = 1;
  }
}
