// Read-only observer. Everything shown comes from the observer API; nothing is simulated, cached
// as success, or advanced by a timer. The observer key lives only in this tab's memory.

const POLL_MS = 3000;
const MAX_BACKOFF_MS = 15000;
const SLOW_MS = 5000;

const PHASES = {
  request_created: { label: "Request created", tone: "neutral" },
  retrieving_sources: { label: "Collecting public sources", tone: "neutral" },
  awaiting_assessment: { label: "Awaiting the buyer agent's assessment", tone: "neutral" },
  discovery_failed: { label: "Source collection failed", tone: "bad" },
  ranked: { label: "Ranking frozen", tone: "neutral" },
  resolved: { label: "Representatives looked up", tone: "neutral" },
  quote_requested: { label: "Awaiting the supplier's offer", tone: "neutral" },
  negotiating: { label: "Negotiating", tone: "neutral" },
  agreed: { label: "Agreed — payment not started", tone: "wait" },
  payment_pending: { label: "Agreed — payment pending", tone: "wait" },
  payment_requires_action: { label: "Agreed — payment needs action", tone: "wait" },
  paid: { label: "Agreed and sandbox-paid", tone: "ok" },
  payment_failed: { label: "Agreed — payment failed", tone: "bad" },
  closed_without_agreement: { label: "Closed without agreement", tone: "neutral" },
};

const state = {
  api: "",
  key: "",
  runId: "",
  runs: [],
  newestSeenId: "",
  view: null,
  skewMs: 0,
  openedAt: Date.now(),
  lastOkAt: 0,
  failingSince: 0,
  paused: false,
  timer: 0,
  backoff: POLL_MS,
  inflight: false,
};

const $ = (id) => document.getElementById(id);

// ---------- DOM helpers (text only, never HTML from data) ----------
function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (name === "class") node.className = value;
    else if (name === "dataset") Object.assign(node.dataset, value);
    else node.setAttribute(name, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}
function link(url, text) {
  return /^https?:\/\//i.test(url ?? "")
    ? h("a", { href: url, target: "_blank", rel: "noopener noreferrer", class: "wrap-link" }, text ?? url)
    : h("span", { class: "wrap" }, text ?? url ?? "");
}
function badge(text, tone) { return h("span", { class: `badge${tone ? ` badge-${tone}` : ""}` }, text); }
function set(id, ...children) { const node = $(id); node.replaceChildren(...children.flat().filter((c) => c !== null && c !== undefined && c !== false)); return node; }

// ---------- formatting ----------
function serverNow() { return Date.now() + state.skewMs; }
function time(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  const sameDay = date.toDateString() === new Date(serverNow()).toDateString();
  const t = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return sameDay ? t : `${date.toLocaleDateString([], { day: "numeric", month: "short" })} ${t}`;
}
function duration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
function ago(iso) { return iso ? `${duration(serverNow() - Date.parse(iso))} ago` : "never"; }
function day(iso) { return iso ? new Date(iso).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" }) : "—"; }
function money(value) {
  if (!value) return "—";
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency: value.currency }).format(value.amountMinor / 100); }
  catch { return `${(value.amountMinor / 100).toFixed(2)} ${value.currency}`; }
}
function short(id) { return id ? `${String(id).slice(0, 8)}…` : "—"; }
function opLabel(op) { return op; }

// ---------- connection ----------
function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  return { api: params.get("api") ?? "", key: params.get("key") ?? "", run: params.get("run") ?? "" };
}
function writeHash() {
  // The key is never written back: it stays in memory only.
  const params = new URLSearchParams();
  if (state.api) params.set("api", state.api);
  if (state.runId) params.set("run", state.runId);
  history.replaceState(null, "", `${location.pathname}${location.search}#${params}`);
}
function normalizeApi(value) {
  const url = new URL(value.trim());
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("Use an https address.");
  return url.origin;
}

class ApiError extends Error {
  constructor(status, code) { super(code || `HTTP ${status}`); this.status = status; this.code = code; }
}

async function get(path) {
  const started = Date.now();
  const slow = setTimeout(() => setConn("slow", "Waiting for the API…"), SLOW_MS);
  try {
    const response = await fetch(`${state.api}/v1/observer/${path}`, { headers: { authorization: `Bearer ${state.key}` }, cache: "no-store" });
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    if (!response.ok) throw new ApiError(response.status, body && body.code);
    const generatedAt = body && body.generatedAt ? Date.parse(body.generatedAt) : NaN;
    if (Number.isFinite(generatedAt)) state.skewMs = generatedAt - (started + Date.now()) / 2;
    return body;
  } finally {
    clearTimeout(slow);
  }
}

function setConn(kind, text) {
  $("conn").dataset.state = kind;
  set("conn-text", text);
}

function showConnect(message) {
  stopPolling();
  state.key = "";
  $("workspace").hidden = true;
  $("pause").hidden = true;
  $("connect").hidden = false;
  $("api-input").value = state.api;
  const error = $("connect-error");
  error.hidden = !message;
  error.textContent = message ?? "";
  setConn("idle", "Not connected");
}

async function connect() {
  setConn("slow", "Connecting…");
  try {
    const list = await get("runs");
    $("connect").hidden = true;
    $("workspace").hidden = false;
    $("pause").hidden = false;
    applyRuns(list);
    if (!state.runId || !state.runs.some((r) => r.id === state.runId)) {
      // A run named in the link is kept even if it is older than the list window.
      if (!state.runId) state.runId = state.runs[0]?.id ?? "";
    }
    state.newestSeenId = state.runs[0]?.id ?? "";
    writeHash();
    await refresh();
    schedule(POLL_MS);
  } catch (error) {
    handleFailure(error, true);
  }
}

function handleFailure(error, initial = false) {
  if (error instanceof ApiError && error.status === 401) {
    const expired = error.code === "OBSERVER_SESSION_EXPIRED";
    showConnect(expired ? "This observer key has expired. Ask the operator for a new observer link." : "This observer key was not accepted. Ask the operator for a new observer link.");
    return;
  }
  if (initial) {
    showConnect(error instanceof ApiError ? `The API answered ${error.status} (${error.code ?? "error"}).` : "The API could not be reached. Check the address and that the observer API is deployed.");
    return;
  }
  if (!state.failingSince) state.failingSince = Date.now();
  setConn("error", "Disconnected");
  const stale = $("stale");
  stale.hidden = false;
  stale.className = "notice notice-bad";
  stale.textContent = state.lastOkAt
    ? `Disconnected since ${new Date(state.failingSince).toLocaleTimeString()}. Showing data received at ${new Date(state.lastOkAt).toLocaleTimeString()}; it is not live until the connection returns.`
    : "Disconnected. No data has been received yet.";
  state.backoff = Math.min(state.backoff * 2, MAX_BACKOFF_MS);
  schedule(state.backoff);
}

// ---------- polling ----------
function schedule(ms) {
  clearTimeout(state.timer);
  if (state.paused || !state.key) return;
  state.timer = setTimeout(tick, ms);
}
function stopPolling() { clearTimeout(state.timer); state.timer = 0; }

async function tick() {
  if (state.inflight || state.paused) return;
  state.inflight = true;
  try {
    const list = await get("runs");
    applyRuns(list);
    await refresh();
    state.backoff = POLL_MS;
    schedule(POLL_MS);
  } catch (error) {
    handleFailure(error);
  } finally {
    state.inflight = false;
  }
}

async function refresh() {
  if (!state.runId) {
    state.view = null;
    markOk();
    render();
    return;
  }
  try {
    state.view = await get(`runs/${encodeURIComponent(state.runId)}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      state.view = null;
      markOk();
      renderMissing();
      return;
    }
    throw error;
  }
  markOk();
  render();
}

function markOk() {
  state.lastOkAt = Date.now();
  state.failingSince = 0;
  if (!state.paused) {
    setConn("live", `Live · updated ${new Date(state.lastOkAt).toLocaleTimeString()}`);
    $("stale").hidden = true;
  }
}

function applyRuns(list) {
  state.runs = Array.isArray(list?.runs) ? list.runs : [];
  if (list?.session) {
    $("env-badge").hidden = true; // environment is shown from the run view
  }
  renderRunSelect();
  const newest = state.runs[0];
  const banner = $("new-run");
  if (newest && state.newestSeenId && newest.id !== state.newestSeenId && newest.id !== state.runId) {
    banner.hidden = false;
    set("new-run-text", `A new run started at ${time(newest.createdAt)}. You are still viewing the run you selected.`);
    $("new-run-open").onclick = () => { state.newestSeenId = newest.id; selectRun(newest.id); };
  } else {
    banner.hidden = true;
  }
}

function runKind(run) {
  if (!run) return "";
  const newest = state.runs[0];
  // "Before this page opened" is about when the run finished, not when it started.
  const before = run.terminal && Date.parse(run.lastActivityAt ?? run.createdAt) < state.openedAt;
  if (newest && run.id === newest.id) {
    if (!run.terminal) return { text: "Current run · not finished", tone: "info" };
    return { text: before ? "Most recent run · finished before this page opened" : "Most recent run · finished", tone: before ? "outline" : "ok" };
  }
  return { text: `Earlier run · started ${time(run.createdAt)}${run.terminal ? " · finished" : " · not finished"}`, tone: "outline" };
}

function renderRunSelect() {
  const select = $("run-select");
  const options = state.runs.map((run, index) => {
    const label = `${index === 0 ? "Most recent" : "Earlier"} · ${time(run.createdAt)} · ${phaseInfo(run.phase, state.view?.environment === "hosted").label} · ${short(run.id)}`;
    return h("option", { value: run.id, selected: run.id === state.runId }, label);
  });
  if (state.runId && !state.runs.some((run) => run.id === state.runId)) {
    options.push(h("option", { value: state.runId, selected: true }, `Selected run ${short(state.runId)} (outside the recent list)`));
  }
  select.replaceChildren(...options);
  select.disabled = options.length === 0;
  $("empty").hidden = state.runs.length > 0 || Boolean(state.runId);
  const run = state.runs.find((r) => r.id === state.runId);
  const kind = runKind(run);
  const kindBadge = $("run-kind");
  kindBadge.hidden = !kind;
  if (kind) { kindBadge.className = `badge badge-${kind.tone}`; kindBadge.textContent = kind.text; }
}

function selectRun(id) {
  state.runId = id;
  state.view = null;
  writeHash();
  renderRunSelect();
  $("new-run").hidden = true;
  void (async () => { try { await refresh(); } catch (error) { handleFailure(error); } })();
}

// ---------- rendering ----------
function renderMissing() {
  $("run").hidden = true;
  const stale = $("stale");
  stale.hidden = false;
  stale.className = "notice notice-warn";
  stale.textContent = "This run is not visible to this observer key. Pick another run.";
}

function render() {
  const view = state.view;
  $("run").hidden = !view;
  if (!view) return;
  const env = $("env-badge");
  env.hidden = false;
  const hosted = view.environment === "hosted";
  env.className = `badge ${hosted ? "badge-info" : "badge-wait"}`;
  env.textContent = hosted ? "Hosted platform" : `Not hosted · ${view.environment}`;

  const refusal = latestRefusal(view);
  const phase = refusal
    ? { label: `Refused by the platform · ${refusal.errorCode}`, tone: "bad" }
    : phaseInfo(view.run.phase, hosted);
  set("phase", phase.label);
  $("phase-orb").dataset.tone = phase.tone;
  const need = view.run.need;
  set("need", `${view.run.buyer.company ?? "Buyer"} needs ${need.quantity} ${need.unit} of ${need.description} — ${need.category}, delivered to ${need.destination} by ${day(need.deliverBy)}.`,
    need.buyerNoticeNumber ? ` Bound to public buyer notice ${need.buyerNoticeNumber}.` : "");
  set("started", time(view.run.createdAt));
  set("last-activity", view.run.lastActivityAt ? `${time(view.run.lastActivityAt)} (${ago(view.run.lastActivityAt)})` : "No agent action recorded");
  set("run-id", view.run.id);
  renderElapsed();
  renderSteps(view);
  renderLane("buyer", view);
  renderLane("supplier", view);
  renderOutcome(view);
  renderEvidence(view);
  renderRanking(view);
}

function renderElapsed() {
  const run = state.view?.run;
  if (!run) return;
  if (run.terminal && run.endedAt) set("elapsed", `${duration(Date.parse(run.endedAt) - Date.parse(run.createdAt))} total`);
  else set("elapsed", `${duration(serverNow() - Date.parse(run.createdAt))} so far`);
}

/** Outside the hosted platform the provider is stubbed, so "sandbox-paid" would overstate it. */
function phaseInfo(phase, hosted) {
  const info = PHASES[phase] ?? { label: phase, tone: "neutral" };
  return phase === "paid" && !hosted ? { ...info, label: "Agreed and paid (stubbed provider)" } : info;
}

const COMMERCIAL = new Set(["request_quote", "submit_offer", "accept_offer"]);
const REFUSALS = new Set(["POLICY_REFUSAL", "QUALIFYING_CANDIDATE_REQUIRED", "QUOTE_REQUEST_REQUIRED", "MANDATE_UNAVAILABLE"]);

/** The platform refused the latest commercial step and nothing was agreed after it. */
function latestRefusal(view) {
  if (view.order) return null;
  const last = view.traces.filter((t) => COMMERCIAL.has(t.operation)).at(-1);
  return last && !last.ok && REFUSALS.has(last.errorCode) ? last : null;
}

function eligibleConnected(view) { return view.resolution.some((r) => r.connected && r.eligible === "yes"); }

function renderSteps(view) {
  const d = view.discovery;
  const failedDiscovery = d && d.status === "failed";
  const paid = view.run.phase === "paid";
  const payFailed = view.run.phase === "payment_failed";
  const steps = [
    ["Sources", d?.collection ? "done" : failedDiscovery ? "failed" : d ? "current" : "todo"],
    ["Assessment", d?.ranking ? "done" : d?.collection && !failedDiscovery ? "current" : "todo"],
    ["Ranking", d?.ranking ? "done" : "todo"],
    ["Representatives", view.resolution.length ? "done" : d?.ranking ? "current" : "todo"],
    ["Quote", view.quotes.length ? "done" : view.resolution.length && eligibleConnected(view) ? "current" : "todo"],
    ["Agreement", view.order ? "done" : latestRefusal(view) ? "failed" : view.offers.length ? "current" : "todo"],
    ["Payment", paid ? "done" : payFailed ? "failed" : view.order ? "current" : "todo"],
  ];
  set("steps", steps.map(([label, s]) => h("li", { class: "step", dataset: { state: s } }, label,
    h("span", { class: "sr-only", hidden: true }, ` (${s})`))));
}

function nextAwaited(role, view) {
  const p = view.run.phase;
  const current = view.offers.filter((o) => o.status === "current").at(-1);
  if (p === "negotiating" && current) {
    const waitingOn = current.author === "buyer" ? "supplier" : "buyer";
    return waitingOn === role ? `Respond to revision ${current.revision}` : `Waiting for the ${waitingOn} to answer revision ${current.revision}`;
  }
  if (role === "buyer") {
    return {
      request_created: "Start discovery",
      retrieving_sources: "Waiting for the platform to collect sources",
      awaiting_assessment: "Read the sources and submit an assessment",
      ranked: "Look up connected representatives",
      resolved: eligibleConnected(view) ? "Request a quote" : "Nothing: no ranked company is eligible and connected",
      quote_requested: "Waiting for the supplier's offer",
      agreed: "Settle the sandbox payment",
      payment_pending: "Waiting for the payment provider",
      payment_requires_action: "Payment needs action outside the agent",
    }[p] ?? "Nothing — this run has finished";
  }
  return {
    quote_requested: "Answer the quote request",
    agreed: "Waiting for the buyer's payment",
    payment_pending: "Waiting for payment confirmation",
  }[p] ?? (view.quotes.length ? "Nothing — this run has finished" : "Not contacted for this run");
}

function renderLane(role, view) {
  const lane = $(`lane-${role}`);
  const client = view.clients.find((c) => c.role === role);
  const traces = view.traces.filter((t) => t.lane === role);
  const last = traces.at(-1);
  const head = h("div", { class: "lane-head" },
    h("div", {}, h("div", { class: "lane-role" }, role === "buyer" ? "Buyer agent" : "Supplier agent"),
      h("div", { class: "h2" }, client?.configuredName ?? (role === "supplier" ? "No supplier yet" : "Buyer")),
      client ? h("div", { class: "label-sm" }, "Configured company name") : null),
    client ? h("div", { class: "client" },
      client.observed.length
        ? client.observed.map((o) => h("div", { class: "client-row" },
          badge(`${o.channel.toUpperCase()} · ${o.clientName}${o.clientVersion ? ` ${o.clientVersion}` : ""}`, o.channel === "mcp" ? "info" : "outline"),
          h("span", { class: "muted" }, `seen ${ago(o.lastSeenAt)}`)))
        : h("span", { class: "muted" }, "No client connection observed"),
      h("span", { class: "label-sm" }, "Observed: reported by the client itself")) : null);

  if (!client) {
    lane.replaceChildren(head, h("p", { class: "lane-empty" }, "No supplier has been contacted for this run. This lane fills in only when a supplier's own client receives or answers a request."));
    return;
  }
  const latest = last
    ? h("div", { class: "latest" },
      h("div", { class: "label-sm" }, "Latest verified action"),
      h("div", { class: "latest-op" }, opLabel(last.operation)),
      h("div", { class: "client-row" },
        last.ok ? badge("OK", "ok") : badge(last.errorCode ?? `HTTP ${last.status}`, "bad"),
        h("span", { class: "mono muted" }, `${time(last.startedAt)} → ${time(last.finishedAt)} · ${duration(Date.parse(last.finishedAt) - Date.parse(last.startedAt))}`),
        badge(last.channel.toUpperCase(), "outline")))
    : h("div", { class: "latest" }, h("div", { class: "label-sm" }, "Latest verified action"), h("span", { class: "muted" }, "None recorded for this run yet"));
  const next = h("div", { class: "next" }, h("span", { class: "label-sm" }, "Next awaited"), h("span", {}, nextAwaited(role, view)));
  const list = h("ol", { class: "trace", "aria-label": `${role} actions` }, traces.map((t) => h("li", {},
    h("span", { class: "t-time" }, time(t.finishedAt)),
    h("span", { class: "t-op" }, opLabel(t.operation)),
    t.ok ? h("span", { class: "t-ok" }, "ok") : h("span", { class: "t-err" }, t.errorCode ?? `HTTP ${t.status}`))));
  lane.replaceChildren(...[head, latest, next, traces.length ? list : null].filter(Boolean));
  list.scrollTop = list.scrollHeight;
}

function outcomeStatus(view) {
  const p = view.run.phase;
  if (p === "paid") return ["Paid (sandbox)", "ok"];
  if (p === "payment_failed") return ["Payment failed", "bad"];
  if (p === "payment_pending" || p === "payment_requires_action") return ["Agreed · payment pending", "wait"];
  if (p === "agreed") return ["Agreed · payment not started", "wait"];
  const refusal = latestRefusal(view);
  if (refusal) return [`Refused · ${refusal.operation} returned ${refusal.errorCode}`, "bad"];
  if (p === "negotiating") return ["Offer on the table", "info"];
  if (p === "quote_requested") return ["Awaiting supplier", "info"];
  if (p === "closed_without_agreement") return ["No agreement", "neutral"];
  if (p === "resolved" && !eligibleConnected(view)) return ["No quote · external leads only", "neutral"];
  if (p === "discovery_failed") return ["No quote · source collection failed", "bad"];
  return ["No quote yet", "neutral"];
}

function renderOutcome(view) {
  const [text, tone] = outcomeStatus(view);
  const head = h("div", { class: "outcome-head" }, h("h2", { class: "h2" }, "Quote, agreement and payment"), badge(text, tone === "neutral" ? "" : tone));
  const quotes = view.quotes.length
    ? h("p", { class: "muted" }, view.quotes.map((q) => `Quote requested from ${q.supplierCompany} at ${time(q.requestedAt)}.`).join(" "))
    : view.run.phase === "resolved" && !eligibleConnected(view)
      ? h("p", { class: "muted" }, "No quote was requested: no ranked company is both fully eligible and connected to a demo account. Ranked companies stay external leads; no offer is invented for them.")
      : h("p", { class: "muted" }, "No quote requested yet.");
  const offers = view.offers.length ? h("div", { class: "table-scroll" }, h("table", { class: "offers-table" },
    h("thead", {}, h("tr", {}, ["Rev", "From", "Delivered total", "Delivery by", "Status", "Accepted by"].map((c) => h("th", {}, c)))),
    h("tbody", {}, view.offers.map((o) => h("tr", {},
      h("td", { "data-label": "Revision", class: "num" }, String(o.revision)),
      h("td", { "data-label": "From" }, o.author === "buyer" ? "Buyer" : o.supplierCompany),
      h("td", { "data-label": "Delivered total", class: "num" }, money(o.deliveredTotal)),
      h("td", { "data-label": "Delivery by", class: "num" }, day(o.deliveryAt)),
      h("td", { "data-label": "Status" }, badge(o.status, o.status === "accepted" ? "ok" : o.status === "current" ? "info" : "outline")),
      h("td", { "data-label": "Accepted by" }, o.acceptances.length ? o.acceptances.map((a) => `${a.by} ${time(a.at)}`).join(", ") : "—")))))) : null;

  const order = view.order;
  const hosted = view.environment === "hosted";
  let receipt;
  if (order) {
    const pay = order.payment;
    const payTone = pay.status === "succeeded" ? "ok" : pay.status === "failed" ? "bad" : "wait";
    receipt = h("div", { class: "receipt" },
      h("div", { class: "subhead" }, "Order"),
      h("dl", {},
        h("div", {}, h("dt", {}, "Order ID"), h("dd", { class: "mono wrap" }, order.id)),
        h("div", {}, h("dt", {}, "Agreed at"), h("dd", { class: "mono" }, time(order.agreedAt))),
        h("div", {}, h("dt", {}, "Demo document"), h("dd", { class: "mono wrap" }, order.demoDocumentId ?? "—")),
        h("div", {}, h("dt", {}, "Payment"), h("dd", {}, badge(pay.status === "succeeded" ? (hosted ? "Paid · Stripe sandbox" : "Paid · stubbed provider") : pay.status.replace(/_/g, " "), payTone))),
        pay.amount ? h("div", {}, h("dt", {}, "Amount"), h("dd", { class: "num" }, money(pay.amount))) : null,
        pay.receiptReference ? h("div", {}, h("dt", {}, "Provider receipt reference"), h("dd", { class: "mono wrap" }, pay.receiptReference)) : null,
        !pay.receiptReference && pay.providerPaymentId ? h("div", {}, h("dt", {}, "Provider payment ID (not a receipt)"), h("dd", { class: "mono wrap" }, pay.providerPaymentId)) : null,
        pay.failureCode ? h("div", {}, h("dt", {}, "Failure"), h("dd", { class: "mono" }, pay.failureCode)) : null,
        pay.updatedAt ? h("div", {}, h("dt", {}, "Payment updated"), h("dd", { class: "mono" }, time(pay.updatedAt))) : null),
      h("p", { class: "caveat" }, hosted
        ? "Stripe sandbox: no real money moves. Company representation and offer terms are simulated."
        : `Payment provider is stubbed in this ${view.environment} environment. This is not a Stripe result.`));
  } else {
    receipt = h("div", { class: "receipt" }, h("div", { class: "subhead" }, "Order"), h("p", { class: "muted" }, "No order exists for this run."));
  }
  set("outcome", head, h("div", { class: "outcome-grid" }, h("div", {}, quotes, offers), receipt));
}

function renderEvidence(view) {
  const c = view.discovery?.collection;
  if (!view.discovery) {
    set("evidence-summary", "· not started");
    set("evidence-body", h("p", { class: "muted" }, "Discovery has not started for this run."));
    return;
  }
  if (!c) {
    const failed = view.discovery.status === "failed";
    set("evidence-summary", failed ? "· failed" : "· collecting");
    set("evidence-body", h("p", { class: failed ? "error-text" : "muted" }, failed ? `Collection failed: ${view.discovery.error ?? "no detail recorded"}` : `Collection started ${time(view.discovery.startedAt)}. No sources recorded yet.`));
    return;
  }
  set("evidence-summary", `· ${c.returnedCount} retrieved · ${c.failedCount} failed · ${c.notices.length} buyer notice${c.notices.length === 1 ? "" : "s"} · ${time(c.completedAt)}`);
  set("evidence-body",
    h("p", { class: "caveat" }, "Procurement notices and supplier pages are public history and self-description. They are not proof of current stock, capacity, price or certification."),
    h("div", {}, h("div", { class: "label-sm" }, "Supplier search query"), h("div", { class: "mono wrap" }, c.supplierQuery || "—")),
    h("div", {}, h("div", { class: "label-sm" }, "CPV codes"), c.cpvCodes && c.cpvCodes.length
      ? h("div", { class: "client-row" }, c.cpvCodes.map((code) => badge(code, "outline")))
      : h("div", { class: "muted" }, "Not recorded by the current discovery pipeline")),
    h("div", {}, h("p", { class: "subhead" }, "Buyer notices"),
      c.notices.length ? c.notices.map((n) => h("div", { class: "source" },
        h("div", { class: "client-row" }, badge("TED"), link(n.noticeUrl, n.publicationNumber),
          n.publicationNumber === c.selectedBuyerNoticeNumber ? badge("Bound to this run", "info") : null),
        h("div", {}, n.title || "Untitled notice"),
        h("div", { class: "label-sm" }, [n.buyerName, n.publishedOn ? `published ${n.publishedOn}` : null, n.retrievedAt ? `retrieved ${time(n.retrievedAt)}` : null].filter(Boolean).join(" · ")),
        n.responseHash ? h("details", {}, h("summary", {}, "Hash"), h("div", { class: "mono wrap" }, `${n.provider || "provider"} response ${n.responseHash}`)) : null)) : h("p", { class: "muted" }, "None returned.")),
    h("div", {}, h("p", { class: "subhead" }, "Retrieved sources"),
      c.sources.length ? c.sources.map((s) => h("div", { class: "source" },
        h("div", { class: "client-row" }, badge(s.provider || "provider"), h("span", { class: "mono muted" }, `retrieved ${time(s.retrievedAt)} · ${s.characters.toLocaleString()} characters`)),
        link(s.url),
        h("details", {}, h("summary", {}, "Hashes"),
          h("div", { class: "mono wrap" }, `content ${s.contentHash}`),
          h("div", { class: "mono wrap" }, `provider response ${s.providerResponseHash || "—"}`)))) : h("p", { class: "muted" }, "No source was retrieved.")),
    c.sourceErrors.length ? h("div", {}, h("p", { class: "subhead" }, "Source failures"),
      c.sourceErrors.map((e) => h("div", { class: "source" }, link(e.url), h("span", { class: "error-text" }, e.message)))) : null);
}

function renderRanking(view) {
  const ranking = view.discovery?.ranking;
  if (!ranking) {
    set("ranking-summary", "· not ranked yet");
    set("ranking-body", h("p", { class: "muted" }, view.discovery?.collection
      ? "Waiting for the buyer agent's own assessment. Nothing is ranked until it is submitted."
      : "Ranking follows source collection and the buyer agent's assessment."));
    return;
  }
  set("ranking-summary", `· frozen · ${ranking.candidates.length} candidate${ranking.candidates.length === 1 ? "" : "s"}`);
  const eligTone = (e) => (e === "yes" ? "ok" : e === "conditional" ? "wait" : "bad");
  const table = h("div", { class: "table-scroll" }, h("table", { class: "rank-table" },
    h("thead", {}, h("tr", {}, ["Rank", "Company", "Eligible", "Reason and evidence"].map((c) => h("th", {}, c)))),
    h("tbody", {}, ranking.candidates.map((c) => h("tr", {},
      h("td", { class: "num" }, `#${c.rank}`),
      h("td", {}, h("div", {}, c.company), h("div", { class: "label-sm wrap" }, c.officialDomain)),
      h("td", {}, badge(c.eligible, eligTone(c.eligible))),
      h("td", {}, h("div", {}, c.explanation),
        h("div", { class: "claims" }, c.claims.map((cl) => h("div", { class: "claim" },
          h("span", {}, h("span", { class: "mono" }, cl.requirementKey), ": ", badge(cl.outcome, cl.outcome === "match" ? "ok" : cl.outcome === "mismatch" ? "bad" : "wait")),
          cl.evidence ? h("span", {}, h("q", {}, cl.evidence.quotation), " — ", link(cl.evidence.url, "source")) : h("span", { class: "muted" }, "No supporting quotation"))))))))));
  const lookup = h("div", {},
    h("p", { class: "subhead" }, "Representative lookup, after ranking"),
    h("p", { class: "caveat" }, "Runs only after the ranking is frozen. Whether a company has a demo account never changes its rank."),
    view.resolution.length ? h("div", { class: "table-scroll" }, h("table", { class: "lookup-table" }, h("tbody", {}, view.resolution.map((r) => h("tr", {},
      h("td", { class: "num" }, `#${r.rank}`),
      h("td", {}, r.company),
      h("td", {}, r.connected ? badge(`Connected demo account: ${r.representative}`, "info") : badge("Unresolved · external lead", "outline")),
      h("td", { class: "mono muted" }, time(r.resolvedAt)))))))
      : h("p", { class: "muted" }, "Not looked up yet."));
  set("ranking-body", table, lookup);
}

// ---------- wiring ----------
$("connect-form").addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    state.api = normalizeApi($("api-input").value);
  } catch (error) {
    showConnect(error instanceof Error ? error.message : "Invalid address.");
    return;
  }
  state.key = $("key-input").value.trim();
  $("key-input").value = "";
  writeHash();
  void connect();
});
$("run-select").addEventListener("change", (event) => selectRun(event.target.value));
$("pause").addEventListener("click", () => {
  state.paused = !state.paused;
  $("pause").textContent = state.paused ? "Resume" : "Pause";
  if (state.paused) {
    stopPolling();
    setConn("paused", "Paused · not refreshing");
    const stale = $("stale");
    stale.hidden = false;
    stale.className = "notice notice-warn";
    stale.textContent = `Refreshing is paused. Showing data received at ${new Date(state.lastOkAt).toLocaleTimeString()}. Pausing this page does not pause the agents or the payment.`;
  } else {
    void tick();
  }
});
setInterval(() => { if (state.view && !state.paused) renderElapsed(); }, 1000);

// Pasting a new observer link into an open tab changes only the hash; treat it as a new connection.
window.addEventListener("hashchange", () => {
  const next = readHash();
  if (!next.key) return;
  try { state.api = normalizeApi(next.api || state.api); } catch { showConnect("Use an https address."); return; }
  state.key = next.key.trim();
  state.runId = next.run;
  state.newestSeenId = "";
  writeHash();
  void connect();
});

(function start() {
  const fromLink = readHash();
  state.runId = fromLink.run;
  try { state.api = fromLink.api ? normalizeApi(fromLink.api) : ""; } catch { state.api = ""; }
  state.key = fromLink.key.trim();
  writeHash(); // strips the key from the address bar and history entry
  if (state.api && state.key) void connect();
  else showConnect(fromLink.api && !fromLink.key ? "Reopen the full observer link from the operator: the key is not kept after a reload." : undefined);
})();
