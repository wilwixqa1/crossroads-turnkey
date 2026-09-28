/**
 * The proof page: who can sign for the vault, read live from Turnkey, and live checks that ask for forbidden things.
 * Anyone can open it; no sign-in needed.
 */
import { fmtClock, fmtEth, fmtMs, shortId } from "./format.js";

interface PolicyView {
  name: string;
  effect: string;
  condition: string;
  notes: string;
}

type Part<T> = T | { error: string } | null;

interface ProofData {
  vaultLabel: string;
  vaultDescription: string;
  appKeys: { source: "rofl" | "file"; vaultAdmin: string; vaultSigner: string; signup: string } | null;
  code: Part<{ roflAppId: string | null; explorer: string | null; committed: { enclaveIds: string[]; image: string | null; appId: string | null; manifestLink: string; composeLink: string } | null }>;
  vault: Part<{
    organizationId: string;
    users: { name: string; id: string; root: boolean; credentials: string[]; email: boolean; phone: boolean }[];
    rootQuorum: { threshold: number; members: string[] };
    policies: PolicyView[];
    contractInterfaces: { label: string; address: string }[];
  }>;
  signup: Part<{ organizationId: string; user: { name: string; id: string } | null; policies: PolicyView[] }>;
  solvency: Part<Record<string, { onChain: string; owed: string; ok: boolean; earning?: string }>>;
  history: Part<{ id: string; status: string; at: number; chainId?: number; to?: string; value?: string; txHash?: string; link?: string }[]>;
  policyProblem: string | null;
  checks: { id: string; title: string; what: string }[];
}

interface CheckResult {
  id: string;
  outcome: "refused" | "allowed" | "error";
  by?: string;
  key: string;
  message: string;
  activityId?: string;
  where?: "vault" | "your organization";
  policy?: string;
  ms: number;
}

const CHAIN_NAMES: Record<number, string> = { 11155111: "Sepolia", 84532: "Base Sepolia", 1: "Ethereum mainnet" };
const ASSET_NAMES: Record<string, string> = { ETH_SEPOLIA: "Sepolia ETH", ETH_BASE_SEPOLIA: "Base ETH" };

function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function failed<T>(p: Part<T>): p is { error: string } {
  return !!p && typeof p === "object" && "error" in (p as object);
}

function unavailable(p: { error: string }): string {
  return `<p class="status err">Could not read this just now: ${esc(p.error)}</p>`;
}

const activity = (id?: string) => (id ? `<button type="button" class="link act" data-copy="${esc(id)}" title="Turnkey activity ${esc(id)}. Click to copy.">Activity ${esc(shortId(id))}</button>` : "");

function policyList(policies: PolicyView[]): string {
  return `<ul class="policies">${policies
    .map(
      (p) => `<li class="${p.effect === "EFFECT_DENY" ? "deny" : "allow"}">
        <span class="tag ${p.effect === "EFFECT_DENY" ? "deny" : "allow"}">${p.effect === "EFFECT_DENY" ? "Deny" : "Allow"}</span>
        <strong>${esc(p.name)}</strong>
        ${p.notes ? `<p class="note">${esc(p.notes)}</p>` : ""}
        <details><summary>Exact rule Turnkey checks</summary><code>${esc(p.condition)}</code></details>
      </li>`,
    )
    .join("")}</ul>`;
}

function codeSection(d: ProofData): string {
  const c = d.code;
  if (failed(c)) return unavailable(c);
  if (!c?.roflAppId) return `<p>This copy is running on a laptop, not in ROFL, so there is no attested app to show.</p>`;
  const m = c.committed;
  return `
    <dl class="facts">
      <div><dt>ROFL app ID</dt><dd><code>${esc(c.roflAppId)}</code> ${c.explorer ? `<a href="${esc(c.explorer)}" target="_blank" rel="noopener">View on the Oasis explorer</a>` : ""}</dd></div>
      ${m ? `<div><dt>Code it may run</dt><dd>${m.enclaveIds.map((e) => `<code>${esc(e.slice(0, 16))}…</code>`).join(" ")} <a href="${esc(m.manifestLink)}" target="_blank" rel="noopener">Registered manifest</a></dd></div>
      <div><dt>Container image</dt><dd><code>${esc((m.image ?? "").replace(/^.*@/, "").slice(0, 23))}…</code> <a href="${esc(m.composeLink)}" target="_blank" rel="noopener">Pinned in the repo</a></dd></div>` : ""}
      <div><dt>Where its keys come from</dt><dd>${d.appKeys?.source === "rofl" ? "ROFL's key service, which hands this app its keys only inside an enclave running the registered code." : "Files on this laptop (test setup)."}</dd></div>
    </dl>`;
}

function vaultSection(d: ProofData): string {
  const v = d.vault;
  if (failed(v)) return unavailable(v);
  if (!v) return `<p>${esc(d.vaultDescription)}</p>`;
  return `
    <p>The vault is Turnkey sub-organization <code>${esc(v.organizationId)}</code>. Its only root user is the app's admin key, and root changes need <strong>${v.rootQuorum.threshold} of ${v.rootQuorum.members.length}</strong> (${esc(v.rootQuorum.members.join(", "))}).</p>
    <table class="bal">
      <thead><tr><th scope="col">User</th><th scope="col">Role</th><th scope="col">How it signs in</th></tr></thead>
      <tbody>${v.users
        .map((u) => `<tr><th scope="row">${esc(u.name)}</th><td>${u.root ? "Root" : "Policies only"}</td><td>${esc(u.credentials.join(", ") || "nothing")}${u.email || u.phone ? " (has email or phone)" : ""}</td></tr>`)
        .join("")}</tbody>
    </table>
    <p class="note">No user has an email, a phone or a passkey, so there is nothing for account recovery to reach. Will's own organization can read the vault but cannot sign with it.</p>
    <h3>The signer's policies</h3>
    ${d.policyProblem ? `<p class="status err">${esc(d.policyProblem)}</p>` : ""}
    ${policyList(v.policies)}
    ${v.contractInterfaces.length ? `<p class="note">Turnkey reads these contracts' calls, so the policies above can name the function and its arguments: ${v.contractInterfaces.map((i) => esc(i.label)).join(", ")}.</p>` : ""}`;
}

function signupSection(d: ProofData): string {
  const s = d.signup;
  if (failed(s)) return unavailable(s);
  if (!s?.user) return `<p class="note">Google sign-in is off here.</p>`;
  return `<p>In Will's own organization, the app has one user, <strong>${esc(s.user.name)}</strong>, with one job: create each user's wallet and start Google logins.</p>${policyList(s.policies)}`;
}

function solvencySection(d: ProofData): string {
  const s = d.solvency;
  if (failed(s)) return unavailable(s);
  if (!s) return "";
  return `
    <table class="bal">
      <thead><tr><th scope="col">Asset</th><th scope="col">Held by the vault on-chain</th><th scope="col">Owed to users</th><th scope="col"></th></tr></thead>
      <tbody>${Object.entries(s)
        .map(
          ([a, v]) => `<tr><th scope="row">${esc(ASSET_NAMES[a] ?? a)}</th><td class="num">${fmtEth(v.onChain)}${v.earning && BigInt(v.earning) > 0n ? `<br><span class="note">of which ${fmtEth(v.earning)} supplied to Aave</span>` : ""}</td><td class="num">${fmtEth(v.owed)}</td>
          <td>${v.ok ? `<span class="tag allow">Covered</span>` : `<span class="tag deny">Short</span>`}</td></tr>`,
        )
        .join("")}</tbody>
    </table>
    <p class="note">On-chain funds must always cover every balance on the ledger, so anyone can always withdraw what they own.</p>`;
}

function historySection(d: ProofData): string {
  const h = d.history;
  if (failed(h)) return unavailable(h);
  if (!h) return `<p class="note">Signing history comes from Turnkey; the stand-in vault keeps none.</p>`;
  if (!h.length) return `<p class="note">The vault has not signed anything yet.</p>`;
  const status = (s: string) => (s === "ACTIVITY_STATUS_COMPLETED" ? `<span class="tag allow">Signed</span>` : s === "ACTIVITY_STATUS_REJECTED" ? `<span class="tag deny">Refused</span>` : `<span class="tag">${esc(s.replace("ACTIVITY_STATUS_", "").toLowerCase())}</span>`);
  return `<ol class="history">${h
    .map(
      (x) => `<li>${status(x.status)}
        <span>${x.value !== undefined ? `${fmtEth(x.value, 4)} ETH` : "A transaction"} on ${esc(CHAIN_NAMES[x.chainId ?? 0] ?? `chain ${x.chainId}`)}${x.to ? ` to <code>${esc(x.to.slice(0, 8))}…</code>` : ""}</span>
        <time>${fmtClock(x.at)}</time> ${activity(x.id)}
        ${x.link && x.status === "ACTIVITY_STATUS_COMPLETED" ? `<a href="${esc(x.link)}" target="_blank" rel="noopener">Explorer</a>` : ""}</li>`,
    )
    .join("")}</ol>`;
}

function checkResult(r: CheckResult): string {
  const tone = r.outcome === "refused" ? "ok" : "err";
  const head = r.outcome === "refused" ? `Refused by ${esc(r.by)}` : r.outcome === "allowed" ? `NOT refused. This should never happen.` : "The check could not run";
  return `<p class="status ${tone}"><strong>${head}</strong> <span class="muted">(${fmtMs(r.ms)})</span></p>
    ${r.policy ? `<p class="policy ${r.outcome === "refused" ? "deny" : "allow"}">${esc(r.policy)}</p>` : ""}
    <p class="note">${esc(r.message)}</p>
    ${r.activityId ? `<p class="meta">${activity(r.activityId)} <span class="note">in ${r.where === "your organization" ? "Will's organization's" : "the vault's"} Activities</span></p>` : ""}`;
}

function checksSection(d: ProofData): string {
  return `<ol class="checks">${d.checks
    .map(
      (c) => `<li>
        <div><h3>${esc(c.title)}</h3><p class="note">${esc(c.what)}</p></div>
        <button type="button" data-check="${esc(c.id)}">Try it</button>
        <div class="result" id="check-${esc(c.id)}"></div>
      </li>`,
    )
    .join("")}</ol>
    <p class="note">Nothing here is ever tried with the vault's admin key: it is the root user, so it would succeed.</p>`;
}

export async function renderProof(root: HTMLElement) {
  root.innerHTML = `<main class="proof"><p class="note">Reading the vault from Turnkey…</p></main>`;
  let d: ProofData;
  try {
    const res = await fetch("/api/proof");
    d = (await res.json()) as ProofData;
  } catch (err) {
    root.innerHTML = `<main class="proof"><p class="status err">Could not reach the app: ${esc((err as Error).message)}</p></main>`;
    return;
  }
  root.innerHTML = `
    <header class="top"><div class="brand">Crossroads on Turnkey · Proof</div><div class="who"><a href="/">Back to trading</a></div></header>
    <main class="proof">
      <h1>No person can sign with the vault's keys</h1>
      <p class="lede">Everything below is read live from Turnkey and the blockchains, not typed in. The checks at the end ask for forbidden things and show who refused them.</p>
      <section class="card"><h2>1. The code that holds the keys</h2>${codeSection(d)}</section>
      <section class="card"><h2>2. Who controls the vault</h2>${vaultSection(d)}</section>
      <section class="card"><h2>3. The app's reach in Will's organization</h2>${signupSection(d)}</section>
      <section class="card"><h2>4. Solvency</h2>${solvencySection(d)}</section>
      <section class="card"><h2>5. What the vault has signed</h2>${historySection(d)}</section>
      <section class="card"><h2>6. Live checks</h2>${checksSection(d)}</section>
    </main>`;
}

/** Runs one live check and draws its result under its button. */
export async function runProofCheck(root: HTMLElement, id: string, button: HTMLButtonElement) {
  const out = root.querySelector(`#check-${id}`);
  if (!out) return;
  button.disabled = true;
  out.innerHTML = `<p class="note">Asking…</p>`;
  try {
    const res = await fetch(`/api/proof/checks/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const body = await res.json();
    out.innerHTML = res.ok ? checkResult(body as CheckResult) : `<p class="status err">${esc(body.error ?? "The check failed")}</p>`;
  } catch (err) {
    out.innerHTML = `<p class="status err">${esc((err as Error).message)}</p>`;
  } finally {
    button.disabled = false;
  }
}
