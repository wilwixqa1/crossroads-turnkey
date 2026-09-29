/**
 * The trading page. Plain DOM, no framework: one shell rendered on login, data
 * sections re-rendered on each poll, forms rendered once per tab so typing is
 * never interrupted.
 */
import { requestMessage, type RequestAction } from "../src/ledger/requests.js";
import { api, ApiError, type AccountView, type Asset, type BorrowAttempt, type BorrowMarket, type FeedEvent, type HoodEntry, type Status } from "./api.js";
import { standIn, type RequestSigner, type StandInAccount } from "./signer.js";
import { googleSession, renderGoogleButton, SessionExpired, turnkeySigner } from "./google.js";
import { fmtClock, fmtEth, fmtMs, fmtUnits, fmtUsd, isAddress, parseEthInput, parseUnitsInput, shortAddr, shortId, spotRate } from "./format.js";
import { renderProof, runProofCheck } from "./proof.js";

const ASSET_NAMES: Record<Asset, string> = { ETH_SEPOLIA: "Sepolia ETH", ETH_BASE_SEPOLIA: "Base ETH" };
const BLOCK_SECONDS: Record<Asset, number> = { ETH_SEPOLIA: 12, ETH_BASE_SEPOLIA: 2 };
const other = (a: Asset): Asset => (a === "ETH_SEPOLIA" ? "ETH_BASE_SEPOLIA" : "ETH_SEPOLIA");

type Tab = "deposit" | "swap" | "send" | "earn" | "withdraw" | "liquidity";
const TAB_NAMES: Record<Tab, string> = { deposit: "Deposit", swap: "Swap", send: "Send", earn: "Earn", withdraw: "Withdraw", liquidity: "Add liquidity" };

const state = {
  status: null as Status | null,
  me: null as { acct: { name: string; address: string }; signer: RequestSigner } | null,
  view: null as AccountView | null,
  hood: [] as HoodEntry[],
  tab: "deposit" as Tab,
  busy: false,
  tick: 0,
  rendered: { feed: "", hood: "", latest: "" },
  /** The action the "What just happened" card follows, and its title. */
  latest: null as { ref: string; title: string } | null,
  /** Aave's view of the vault for the Earn tab's borrow panel, read when that tab is open. */
  borrow: null as BorrowMarket | null,
  borrowError: "",
  borrowReadAt: 0,
};

const root = document.getElementById("root")!;
const $ = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T>(sel);

function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function chainName(asset: Asset): string {
  return state.status?.chains.find((c) => c.asset === asset)?.name ?? asset;
}

/** Label for Under the hood rows: "Turnkey" or "Stand-in vault". */
function vaultLabel(): string {
  return state.status?.vaultLabel ?? "Vault";
}

/** The vault as it reads mid-sentence: "Turnkey", or "the vault" for the stand-in. */
function vaultName(): string {
  return state.status?.mode === "turnkey" ? "Turnkey" : "the vault";
}

function available(asset: Asset): bigint {
  return BigInt(state.view?.balances[asset]?.available ?? "0");
}

function canAddLiquidity(): boolean {
  const lp = state.status?.liquidityProvider;
  return !lp || lp === state.me?.signer.address;
}

function assetOptions(selected?: Asset, labels: Record<Asset, string> = ASSET_NAMES): string {
  return (state.status?.assets ?? ["ETH_SEPOLIA", "ETH_BASE_SEPOLIA"])
    .map((a) => `<option value="${a}"${a === selected ? " selected" : ""}>${esc(labels[a])}</option>`)
    .join("");
}

// ---------- theme ----------

const THEME_KEY = "crossroads.theme";

function currentTheme(): "light" | "dark" {
  const set = document.documentElement.dataset.theme;
  if (set === "light" || set === "dark") return set;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function setTheme(t: "light" | "dark") {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {
    /* not remembered */
  }
  labelThemeButton();
}

function labelThemeButton() {
  const btn = $("#theme");
  if (btn) btn.textContent = currentTheme() === "dark" ? "Light theme" : "Dark theme";
}

// ---------- login ----------

const googleMode = () => state.status?.login.mode === "google";

function renderLogin(message = "") {
  state.me = null;
  if (googleMode()) return renderGoogleLogin(message);
  const saved = standIn.list();
  root.innerHTML = `
    <main class="login">
      <h1>Crossroads on Turnkey</h1>
      <p class="lede">One balance across Sepolia and Base Sepolia. Trades and transfers settle instantly on the app's ledger. Only deposits and withdrawals touch a blockchain.</p>
      <form id="signup" class="login-form">
        <label for="name">Your name</label>
        <div class="inline">
          <input id="name" name="name" maxlength="40" autocomplete="off" required>
          <button type="submit" class="primary">Create account</button>
        </div>
        <p class="note">Stand-in login for laptop work: this creates a test key and keeps it in this browser. The live app signs in with Google and gives each user a Turnkey wallet.</p>
        <p class="status err" role="status">${esc(message)}</p>
      </form>
      ${
        saved.length
          ? `<section class="saved">
              <h2>Accounts in this browser</h2>
              <ul>${saved
                .map((a) => `<li><button type="button" data-login="${a.address}">Continue as ${esc(a.name)}</button> <code>${shortAddr(a.address)}</code></li>`)
                .join("")}</ul>
            </section>`
          : ""
      }
    </main>`;
  $<HTMLInputElement>("#name")?.focus();
}

function renderGoogleLogin(message = "") {
  root.innerHTML = `
    <main class="login">
      <h1>Crossroads on Turnkey</h1>
      <p class="lede">One balance across Sepolia and Base Sepolia. Trades and transfers settle instantly on the app's ledger. Only deposits and withdrawals touch a blockchain.</p>
      <div class="google" id="google-button" aria-live="polite"></div>
      <p class="note">The first time, Turnkey creates a wallet that belongs to you, opened only by your Google account. No extension, no password, no seed phrase.</p>
      <p class="status err" role="status" id="login-status">${esc(message)}</p>
    </main>`;
  const el = $<HTMLElement>("#google-button");
  const clientId = state.status?.login.googleClientId;
  if (!el || !clientId) return;
  renderGoogleButton(el, clientId, currentTheme(), (oidcToken, publicKey) => void googleSignIn(oidcToken, publicKey)).catch((err) => {
    const out = $("#login-status");
    if (out) out.textContent = (err as Error).message;
  });
}

async function googleSignIn(oidcToken: string, publicKey: string) {
  const out = $("#login-status");
  if (out) {
    out.className = "status";
    out.textContent = "Turnkey is checking your Google sign-in and opening your wallet…";
  }
  try {
    const s = await api.googleSignIn(oidcToken, publicKey);
    googleSession.save(s);
    await enter({ name: s.name, address: s.address }, turnkeySigner(s));
    state.latest = { ref: s.ref, title: s.created ? "Sign up with Google" : "Sign in with Google" };
    renderLatest();
  } catch (err) {
    renderLogin((err as Error).message);
  }
}

/** The Google sign-in ran out: forget it and go back to Continue with Google with a plain message. */
async function expireSession() {
  state.me = null;
  await googleSession.clear().catch(() => undefined);
  renderLogin(new SessionExpired().message);
}

async function login(acct: StandInAccount) {
  try {
    await api.account(acct.address);
  } catch (err) {
    // The app's saved state was reset since this browser last used the account: register it again.
    if (err instanceof ApiError && err.code === "NO_ACCOUNT") await api.signUp(acct.address, acct.name);
    else throw err;
  }
  standIn.setCurrent(acct.address);
  await enter(acct, standIn.signer(acct));
}

/** Opens the trading screen for a signed-in account, whichever way it signed in. */
async function enter(acct: { name: string; address: string }, signer: RequestSigner) {
  await api.account(acct.address);
  state.me = { acct, signer };
  state.view = null;
  state.hood = [];
  state.tab = "deposit";
  state.rendered = { feed: "", hood: "", latest: "" };
  renderShell();
  await refresh();
}

async function createAccount(name: string) {
  const acct = standIn.create(name);
  await api.signUp(acct.address, name);
  await login(acct);
}

// ---------- main screen ----------

/** One line under the header saying what is real and what is a stand-in. */
function banner(s: Status): string {
  const google = s.login.mode === "google";
  if (!s.vaultReady) return "The Turnkey vault is being set up. Deposits and withdrawals open in a minute.";
  if (s.mode === "turnkey" && google) return "Your account is your own Turnkey wallet, and the vault is Turnkey. Neither key is held by this app.";
  if (s.mode === "turnkey") return "The vault is Turnkey. The login is a stand-in: your key lives in this browser.";
  if (google) return "Your account is your own Turnkey wallet. The vault is still a stand-in inside the app.";
  return "Stand-in mode: your login key lives in this browser and the vault keys live in the app.";
}

function renderShell() {
  const s = state.status!;
  const me = state.me!;
  const tabs = (Object.keys(TAB_NAMES) as Tab[]).filter((t) => t !== "liquidity" || canAddLiquidity());
  root.innerHTML = `
    <header class="top">
      <div class="brand">Crossroads on Turnkey</div>
      <ul class="nets" aria-label="Networks">${s.chains.map((c) => `<li>${esc(c.name)}</li>`).join("")}</ul>
      <div class="who">
        <a href="/proof" target="_blank" rel="noopener">Proof</a>
        <span class="name">${esc(me.acct.name)}</span>
        <button type="button" class="link" data-copy="${me.signer.address}" title="${me.signer.address}">Copy account ID</button>
        ${googleMode() ? `<button type="button" class="link" id="signout">Sign out</button>` : `<button type="button" class="link" id="switch">Switch account</button>`}
        <button type="button" class="link" id="theme"></button>
      </div>
    </header>
    <p class="standin">${banner(s)}</p>
    <p class="offline" id="offline" hidden>Cannot reach the app. Retrying.</p>
    <div class="layout">
      <main class="trade">
        <section id="balances" aria-live="polite"></section>
        <section id="inflight" hidden></section>
        <section class="actions">
          <div class="tabs" role="tablist">
            ${tabs.map((t) => `<button type="button" role="tab" data-tab="${t}" aria-selected="${t === state.tab}">${TAB_NAMES[t]}</button>`).join("")}
          </div>
          <div id="panel" role="tabpanel"></div>
        </section>
        <section class="latest" id="latest" aria-live="polite" hidden></section>
        <section class="activity">
          <h2>Activity</h2>
          <ol id="feed" class="feed"></ol>
        </section>
      </main>
      <aside class="hood" aria-label="Under the hood">
        <h2>Under the hood</h2>
        <p class="note">What ${vaultName()}, the networks, and the ledger are doing, as it happens.</p>
        <ol id="hood"></ol>
      </aside>
    </div>`;
  labelThemeButton();
  renderPanel();
}

function renderBalances() {
  const v = state.view;
  const el = $("#balances");
  if (!v || !el || !state.status) return;
  const pool = state.status.pool;
  const rate = spotRate(pool.ETH_SEPOLIA, pool.ETH_BASE_SEPOLIA);
  el.innerHTML = `
    <h2>Balances</h2>
    <table class="bal">
      <thead><tr><th scope="col">Asset</th><th scope="col">Available</th><th scope="col">Pending</th><th scope="col">Earning on Aave</th></tr></thead>
      <tbody>
        ${state.status.assets
          .map((a) => {
            const b = v.balances[a];
            const earning = v.earning?.[a];
            return `<tr><th scope="row">${ASSET_NAMES[a]} <span class="muted">on ${esc(chainName(a))}</span></th>
              <td class="num">${fmtEth(b.available)}</td>
              <td class="num${BigInt(b.pending) > 0n ? " pending" : " muted"}">${fmtEth(b.pending)}</td>
              <td class="num${earning && BigInt(earning) > 0n ? " earning" : " muted"}">${earning === undefined ? "" : fmtEth(earning, 10)}</td></tr>`;
          })
          .join("")}
      </tbody>
    </table>
    <dl class="facts">
      <div><dt>Deposit address</dt><dd><code>${v.depositAddress}</code> <button type="button" class="link" data-copy="${v.depositAddress}">Copy</button></dd></div>
      <div><dt>Pool rate</dt><dd>${rate === null ? "No liquidity yet" : `1 Sepolia ETH buys about ${fmtEth(rate)} Base ETH`}</dd></div>
    </dl>`;
}

function renderInflight() {
  const v = state.view;
  const el = $("#inflight");
  if (!v || !el) return;
  const rows: string[] = [];
  for (const i of v.incoming) {
    rows.push(`<li><span class="tag onchain">On-chain</span>
      <span>Arriving: ${fmtEth(i.amount)} ${ASSET_NAMES[i.asset]}. ${i.confirmations} of ${i.needed} confirmations.</span>
      <a href="${esc(i.link)}" target="_blank" rel="noopener">View on explorer</a></li>`);
  }
  for (const w of v.withdrawals.filter((x) => x.status === "pending" || x.status === "sent")) {
    const where = w.status === "pending" ? `Waiting for ${vaultName()} to sign.` : `Sent. Waiting for ${state.status?.chains.find((c) => c.asset === w.asset)?.confirmations ?? "a few"} confirmations.`;
    rows.push(`<li><span class="tag onchain">On-chain</span>
      <span>Withdrawing ${fmtEth(w.amount)} ${ASSET_NAMES[w.asset]} to <code>${shortAddr(w.destination)}</code>. ${where}</span>
      ${w.link ? `<a href="${esc(w.link)}" target="_blank" rel="noopener">View on explorer</a>` : ""}</li>`);
  }
  for (const o of (v.earnOps ?? []).filter((x) => x.status !== "complete" && x.status !== "failed")) {
    const what = o.kind === "supply" ? `Supplying ${fmtEth(o.amount)} ${ASSET_NAMES[o.asset]} to Aave.` : `Taking ${fmtEth(o.amount)} ${ASSET_NAMES[o.asset]} back from Aave.`;
    const where = o.status === "pending" ? `Waiting for ${vaultName()} to sign.` : o.status === "approving" ? "Approval sent; the withdrawal from Aave follows." : "Sent. Waiting for confirmations.";
    rows.push(`<li><span class="tag onchain">On-chain</span><span>${what} ${where}</span>
      ${o.link ? `<a href="${esc(o.link)}" target="_blank" rel="noopener">View on explorer</a>` : ""}</li>`);
  }
  el.hidden = rows.length === 0;
  el.innerHTML = rows.length ? `<h2>In flight</h2><ul class="inflight">${rows.join("")}</ul>` : "";
}

function withdrawalLabel(id: unknown): string {
  const w = state.view?.withdrawals.find((x) => x.id === String(id));
  return w ? `${fmtEth(w.amount)} ${ASSET_NAMES[w.asset]}` : `#${esc(id)}`;
}

function eventText(e: FeedEvent): string {
  const d = e.detail;
  const me = state.me?.signer.address;
  const amount = () => `${fmtEth(String(d.amount))} ${ASSET_NAMES[d.asset as Asset]}`;
  switch (e.kind) {
    case "account_created":
      return "Account created";
    case "deposit":
      return `Deposit of ${amount()} credited`;
    case "transfer":
      return e.account === me
        ? `Sent ${amount()} to ${esc(e.toName ?? shortAddr(String(d.to)))}`
        : `Received ${amount()} from ${esc(e.fromName ?? shortAddr(String(e.account)))}`;
    case "swap":
      return `Swapped ${fmtEth(String(d.amountIn))} ${ASSET_NAMES[d.assetIn as Asset]} for ${fmtEth(String(d.amountOut))} ${ASSET_NAMES[d.assetOut as Asset]}`;
    case "add_liquidity":
      return `Added ${amount()} to the pool`;
    case "withdraw_requested":
      return `Withdrawal of ${amount()} requested. Funds locked.`;
    case "withdraw_sent":
      return `Withdrawal of ${withdrawalLabel(d.withdrawalId)} signed and sent`;
    case "withdraw_complete":
      return `Withdrawal of ${withdrawalLabel(d.withdrawalId)} complete. Network fee ${fmtEth(String(d.feeActual), 6)} ETH.`;
    case "withdraw_failed":
      return `Withdrawal of ${withdrawalLabel(d.withdrawalId)} stopped: ${esc(d.error)}. Funds unlocked.`;
    case "earn_requested":
      return d.direction === "supply" ? `Start earning with ${amount()} requested. Funds locked.` : `Stop earning ${amount()} requested.`;
    case "earn_sent":
      return d.direction === "supply" ? "Aave supply signed and sent" : "Aave withdrawal signed and sent";
    case "earn_complete":
      return d.direction === "supply" ? `${amount()} is earning on Aave` : `${amount()} back from Aave. Network fees ${fmtEth(String(d.fee), 6)} ETH.`;
    case "earn_failed":
      return `${d.direction === "supply" ? "Aave supply" : "Aave withdrawal"} stopped: ${esc(d.error)}. Everything is back where it was.`;
    default:
      return esc(e.kind);
  }
}

function renderFeed() {
  const el = $("#feed");
  const v = state.view;
  if (!el || !v) return;
  const key = JSON.stringify(v.events.map((e) => e.id)) + JSON.stringify(v.withdrawals.map((w) => w.status));
  if (key === state.rendered.feed) return;
  state.rendered.feed = key;
  el.innerHTML = v.events.length
    ? v.events
        .map((e) => {
          const instant = e.settlement === "instant";
          const ms = typeof e.detail.settledMs === "number" ? e.detail.settledMs : undefined;
          const how = instant
            ? ms !== undefined
              ? `Settled in <strong>${fmtMs(ms)}</strong>`
              : ""
            : e.link
              ? `<a href="${esc(e.link)}" target="_blank" rel="noopener">View on explorer</a>`
              : "";
          return `<li class="${instant ? "instant" : "onchain"}">
            <span class="tag ${instant ? "instant" : "onchain"}">${instant ? "Instant" : "On-chain"}</span>
            <span class="what">${eventText(e)}</span>
            <span class="how">${how}</span>
            <time>${fmtClock(e.at)}</time>
          </li>`;
        })
        .join("")
    : `<li class="empty">Nothing yet. Start with a deposit.</li>`;
}

/** Who did a step, in the words the Turnkey dashboard would use. */
function who(h: HoodEntry): string {
  if (h.key) return `Turnkey · ${h.key}`;
  return { turnkey: vaultLabel(), wallet: "Turnkey · your wallet", chain: "Network", ledger: "Crossroads" }[h.source];
}

/** The details under a step: timing, the Turnkey activity (click to copy the full ID), the policy decision, a link. */
function stepMeta(h: HoodEntry, withClock: boolean): string {
  const denied = h.policy && /^(Denied|No policy)/.test(h.policy);
  return `
    ${h.policy ? `<p class="policy ${denied ? "deny" : "allow"}">${esc(h.policy)}</p>` : ""}
    ${h.call ? `<p class="call">${h.source === "turnkey" && state.status?.mode === "turnkey" ? "Turnkey" : "The vault"} read the call as: ${esc(h.call)}</p>` : ""}
    <p class="meta">
      ${withClock ? `<time>${fmtClock(h.at)}</time>` : ""}
      ${h.ms !== undefined ? `<span>${fmtMs(h.ms)}</span>` : ""}
      ${h.activityId ? `<button type="button" class="link act" data-copy="${esc(h.activityId)}" title="Turnkey activity ${esc(h.activityId)}. Click to copy.">Activity ${esc(shortId(h.activityId))}</button>` : ""}
      ${h.link ? `<a href="${esc(h.link)}" target="_blank" rel="noopener">View on explorer</a>` : ""}
    </p>`;
}

function renderHood() {
  const el = $("#hood");
  if (!el) return;
  const key = JSON.stringify(state.hood.map((h) => [h.at, h.text]));
  if (key === state.rendered.hood) return;
  state.rendered.hood = key;
  el.innerHTML = state.hood.length
    ? state.hood
        .map(
          (h) => `<li class="src-${h.source}">
            <span class="src">${esc(who(h))}</span>
            <p>${esc(h.text)}</p>
            ${stepMeta(h, true)}
          </li>`,
        )
        .join("")
    : `<li class="empty">Actions you take show up here with what each system did.</li>`;
}

/** "What just happened": every step of the latest action, in order, as it happens. */
function renderLatest() {
  const el = $<HTMLElement>("#latest");
  if (!el) return;
  // The log arrives newest first; reversing keeps the order steps were recorded in (several can share a millisecond).
  const steps = state.latest ? [...state.hood].reverse().filter((h) => h.ref === state.latest!.ref) : [];
  const key = JSON.stringify([state.latest?.ref, steps.map((h) => h.at)]);
  if (key === state.rendered.latest) return;
  state.rendered.latest = key;
  el.hidden = !state.latest;
  if (!state.latest) return;
  el.innerHTML = `
    <h2>What just happened: ${esc(state.latest.title)}</h2>
    <ol class="steps">${
      steps.length
        ? steps.map((h) => `<li class="src-${h.source}"><span class="src">${esc(who(h))}</span><p>${esc(h.text)}</p>${stepMeta(h, false)}</li>`).join("")
        : `<li class="waiting"><p>Waiting for the first step…</p></li>`
    }</ol>`;
}

// ---------- action panel ----------

const earnRateText = (e: { ratePercent: number | null }) => (e.ratePercent === null ? "Reading…" : `${e.ratePercent.toFixed(2)}% a year (testnet)`);

/** The Earn tab: pooled Aave supply from the vault, with the rule that makes it safe stated plainly. */
function earnPanel(): string {
  const entry = Object.entries(state.status?.earn ?? {})[0] as [Asset, NonNullable<Status["earn"][Asset]>] | undefined;
  if (!entry) return `<p>Earning is not available here.</p>`;
  const [asset, e] = entry;
  const mine = state.view?.earning?.[asset] ?? "0";
  const cap = e.supplyCap ? fmtEth(e.supplyCap, 2) : "";
  return `
    <p>Earn interest on your ${ASSET_NAMES[asset]}. Crossroads pools it with other users' and supplies it to Aave on ${esc(e.network)} from the vault. ${state.status?.mode === "turnkey" ? "Turnkey's" : "The vault's"} policy lets the vault supply and withdraw, and never borrow, so pooled funds can never be liquidated. <a href="#borrow">Try a borrow below</a>.</p>
    <dl class="facts">
      <div><dt>You are earning on</dt><dd class="num earning" id="earn-mine">${fmtEth(mine, 10)} ${ASSET_NAMES[asset]}</dd></div>
      <div><dt>Aave's rate now</dt><dd id="earn-rate">${earnRateText(e)}</dd></div>
      <div><dt>Vault's pooled supply</dt><dd id="earn-pool">${fmtEth(e.supplied, 6)} ${ASSET_NAMES[asset]}</dd></div>
    </dl>
    <form id="f-earn-start" novalidate>
      <input type="hidden" name="asset" value="${asset}">
      <div class="fields"><label>Start earning with <input name="amount" inputmode="decimal" placeholder="0.02" autocomplete="off"></label></div>
      <p class="hint" data-hint="available"></p>
      ${cap ? `<p class="note">Up to ${cap} ETH per supply: the vault's per-transaction limit on ${esc(e.network)}.</p>` : ""}
      <button type="submit" class="primary">Start earning</button>
      <p class="status" data-status role="status"></p>
    </form>
    <form id="f-earn-stop" novalidate>
      <input type="hidden" name="asset" value="${asset}">
      <div class="fields"><label>Stop earning <input name="amount" inputmode="decimal" placeholder="0.01" autocomplete="off"></label></div>
      <div class="row"><button type="submit">Stop earning</button> <button type="button" data-earn-all="${asset}">Stop all</button></div>
      <p class="note">Taking funds back from Aave can take two signatures the first time: one to let Aave's gateway take back the vault's aWETH, one to withdraw.</p>
      <p class="status" data-status role="status"></p>
    </form>
    ${borrowSection()}`;
}

// ---------- borrow against the vault (always refused) ----------

/** The borrow panel's frame. Its figures fill in from Aave (renderBorrow) without redrawing the form. */
function borrowSection(): string {
  const vault = vaultName();
  return `
    <section class="borrow" id="borrow" aria-labelledby="borrow-h">
      <h3 id="borrow-h">Borrow against the vault</h3>
      <p>Aave counts the vault's supplied ETH as collateral and would lend against it. ${esc(vault.charAt(0).toUpperCase() + vault.slice(1))}'s policy refuses every borrow, so the pooled funds can never be liquidated. Try it: Aave is asked first, then ${esc(vault)}. Nothing is ever sent.</p>
      <div id="borrow-position" aria-live="polite"><p class="note">Reading the vault's position from Aave…</p></div>
      <form id="f-borrow" novalidate>
        <div class="fields">
          <label data-borrow-address-field hidden>Vault address <select name="address" data-borrow-address></select></label>
          <label>Amount <span class="unit-field"><input name="amount" inputmode="decimal" placeholder="10" autocomplete="off"><span class="unit" data-borrow-unit>USDC</span></span></label>
        </div>
        <div class="row"><button type="submit" class="primary" data-borrow-submit>Borrow</button> <button type="button" data-borrow-max>Max</button></div>
        <p class="status" data-status role="status"></p>
      </form>
      <ol class="steps borrow-steps" id="borrow-steps" hidden></ol>
      <p class="note" id="borrow-aave"></p>
    </section>`;
}

/** Borrow and Max work only when a vault address has something supplied to Aave. */
function syncBorrowButtons() {
  const has = !!selectedBorrowPosition();
  const button = $<HTMLButtonElement>("[data-borrow-submit]");
  const max = $<HTMLButtonElement>("[data-borrow-max]");
  if (button) button.disabled = state.busy || !has;
  if (max) max.disabled = !has;
}

function selectedBorrowPosition() {
  const b = state.borrow;
  if (!b?.positions.length) return undefined;
  const chosen = $<HTMLSelectElement>("[data-borrow-address]")?.value;
  return b.positions.find((p) => p.address === chosen) ?? b.positions[0];
}

/** Aave's figures for the chosen vault address. Keeps the chosen address and whatever is typed in Amount. */
function renderBorrow() {
  const out = $("#borrow-position");
  const select = $<HTMLSelectElement>("[data-borrow-address]");
  if (!out || !select) return;
  const b = state.borrow;
  syncBorrowButtons();
  if (!b) {
    out.innerHTML = state.borrowError ? `<p class="status err">Could not read Aave: ${esc(state.borrowError)}</p>` : `<p class="note">Reading the vault's position from Aave…</p>`;
    return;
  }
  const unit = $("[data-borrow-unit]");
  if (unit) unit.textContent = b.asset.symbol;
  const key = b.positions.map((p) => p.address).join(",");
  if (select.dataset.key !== key) {
    const was = select.value;
    select.innerHTML = b.positions.map((p) => `<option value="${esc(p.address)}">${esc(shortAddr(p.address))}</option>`).join("");
    if (b.positions.some((p) => p.address === was)) select.value = was;
    select.dataset.key = key;
  }
  // One vault address with collateral is the usual case: the figures below name it, so the picker only appears for two or more.
  const field = $<HTMLElement>("[data-borrow-address-field]");
  if (field) field.hidden = b.positions.length < 2;
  syncBorrowButtons();
  const aaveNote = $("#borrow-aave");
  if (aaveNote)
    aaveNote.innerHTML = `Aave's own pages show the same terms: <a href="${esc(b.aaveLinks.collateral)}" target="_blank" rel="noopener">ETH as collateral</a> (its lending limit) and <a href="${esc(b.aaveLinks.borrow)}" target="_blank" rel="noopener">${esc(b.asset.symbol)} borrowing</a> (its rate). They need Testnet mode on, in Aave's settings.`;
  const p = selectedBorrowPosition();
  if (!p) {
    out.innerHTML = `<p class="note">Nothing is supplied to Aave right now, so Aave would lend the vault nothing. Start earning above, then try a borrow.</p>`;
    return;
  }
  const debt = BigInt(p.debtUsd);
  out.innerHTML = `
    <dl class="facts">
      <div><dt>Vault address</dt><dd><code>${esc(p.address)}</code></dd></div>
      <div><dt>Supplied to Aave</dt><dd>${fmtEth(p.supplied, 6)} ETH, worth ${fmtUsd(p.collateralUsd)} at Aave's price</dd></div>
      <div><dt>Aave would lend up to</dt><dd><strong class="lend">${fmtUnits(p.maxBorrow, b.asset.decimals)} ${esc(b.asset.symbol)}</strong>, ${p.ltvPercent}% of that value</dd></div>
      <div><dt>Borrow rate</dt><dd>${b.ratePercent.toFixed(2)}% a year, variable (testnet)</dd></div>
      <div><dt>Debt</dt><dd>${debt === 0n ? "None" : `${fmtUsd(p.debtUsd)}${p.healthFactor ? `, health factor ${fmtUnits(p.healthFactor, 18)}` : ""}`}</dd></div>
    </dl>`;
}

async function loadBorrow() {
  state.borrowReadAt = Date.now();
  try {
    state.borrow = await api.borrow();
    state.borrowError = "";
  } catch (err) {
    state.borrowError = (err as Error).message;
  }
  renderBorrow();
}

/** Aave's answer, then the vault's, as numbered steps under the form. */
function renderBorrowSteps(r: BorrowAttempt) {
  const el = $<HTMLOListElement>("#borrow-steps");
  if (!el) return;
  const aave = `<li class="src-chain"><span class="src">Aave · ${esc(state.borrow?.network ?? "")}</span><p>${esc(r.aave.message)}</p><p class="meta"><span>${fmtMs(r.aave.ms)}</span></p></li>`;
  const v = r.vault;
  const key = v?.by === "Turnkey" ? "Turnkey · vault signer" : "Stand-in vault";
  const asked = v
    ? `<li class="src-turnkey"><span class="src">${esc(key)}</span><p>The vault's signer asked ${esc(v.by)} to sign that same transaction.</p><p class="call">The call: ${esc(v.call)}</p></li>`
    : "";
  const answer = v
    ? `<li class="src-turnkey ${v.outcome === "refused" ? "refused" : "unexpected"}"><span class="src">${esc(v.by)}</span><p>${esc(v.message)}</p>
        ${v.policy ? `<p class="policy ${v.outcome === "refused" ? "deny" : "allow"}">${esc(v.policy)}</p>` : ""}
        <p class="meta"><span>${fmtMs(v.ms)}</span>${v.activityId ? `<button type="button" class="link act" data-copy="${esc(v.activityId)}" title="Turnkey activity ${esc(v.activityId)}. Click to copy.">Activity ${esc(shortId(v.activityId))}</button>` : ""}</p></li>`
    : "";
  el.innerHTML = aave + asked + answer;
  el.hidden = false;
}

async function onBorrow(form: HTMLFormElement) {
  const out = form.querySelector("[data-status]");
  const b = state.borrow;
  const p = selectedBorrowPosition();
  if (!b || !p) return say(out, "Nothing is supplied to Aave yet. Start earning first.", "err");
  let amount: bigint;
  try {
    amount = parseUnitsInput((form.elements.namedItem("amount") as HTMLInputElement).value, b.asset.decimals);
  } catch (err) {
    return say(out, (err as Error).message, "err");
  }
  if (state.busy) return;
  setBusy(true);
  say(out, `Asking Aave, then ${vaultName()}…`);
  try {
    const r = await api.tryBorrow(p.address, amount);
    renderBorrowSteps(r);
    const shown = `${fmtUnits(amount, b.asset.decimals)} ${b.asset.symbol}`;
    if (!r.aave.ok) say(out, `Aave itself would not lend ${shown}, so this shows nothing about ${vaultName()}. Try a smaller amount.`, "err");
    else if (r.vault?.outcome === "refused") say(out, `Aave would lend ${shown}. ${r.vault.by} refused to sign the borrow.`, "ok");
    else if (r.vault?.outcome === "allowed") say(out, `${r.vault.by} signed a borrow. This should never happen. Nothing was sent.`, "err");
    else say(out, r.vault?.message ?? "The attempt could not finish.", "err");
  } catch (err) {
    say(out, (err as Error).message, "err");
  } finally {
    setBusy(false);
    renderBorrow();
  }
}

function renderPanel() {
  const el = $("#panel");
  const v = state.view;
  if (!el) return;
  const addr = v?.depositAddress ?? "…";
  const confText = (a: Asset) => {
    const n = state.status?.chains.find((c) => c.asset === a)?.confirmations ?? 0;
    return `${esc(chainName(a))} deposits count after ${n} confirmations, about ${n * BLOCK_SECONDS[a]} seconds.`;
  };
  const others = standIn.list().filter((a) => a.address !== state.me?.signer.address);
  const lastDest = (() => {
    try {
      return localStorage.getItem("crossroads.lastDestination") ?? "";
    } catch {
      return "";
    }
  })();
  const vault = vaultName();

  const panels: Record<Tab, string> = {
    deposit: `
      <p>Send test ETH to your deposit address from any wallet, such as MetaMask or an exchange. The same address works on both networks.</p>
      <p class="bigaddr"><code>${addr}</code> <button type="button" data-copy="${addr}">Copy address</button></p>
      <ul class="plain">${(state.status?.assets ?? []).map((a) => `<li>${confText(a)}</li>`).join("")}</ul>
      <p class="note">Arriving deposits show under In flight while their confirmations count up.</p>`,
    swap: `
      <form id="f-swap" novalidate>
        <div class="fields">
          <label>From <select name="assetIn">${assetOptions("ETH_SEPOLIA")}</select></label>
          <label>Amount <input name="amount" inputmode="decimal" placeholder="0.01" autocomplete="off"></label>
        </div>
        <p class="hint" data-hint="available"></p>
        <p class="quote" id="quote">Enter an amount to see what you get.</p>
        <button type="submit" class="primary">Swap</button>
        <p class="status" data-status role="status"></p>
      </form>`,
    send: `
      <form id="f-send" novalidate>
        <label>To (their account ID or Crossroads deposit address) <input name="to" placeholder="0x…" autocomplete="off" spellcheck="false" class="mono"></label>
        <p class="hint" data-hint="recipient"></p>
        ${others.length ? `<p class="picks">Accounts in this browser: ${others.map((o) => `<button type="button" class="chip" data-pick="${o.address}">${esc(o.name)}</button>`).join(" ")}</p>` : ""}
        <div class="fields">
          <label>Asset <select name="asset">${assetOptions("ETH_SEPOLIA")}</select></label>
          <label>Amount <input name="amount" inputmode="decimal" placeholder="0.01" autocomplete="off"></label>
        </div>
        <p class="hint" data-hint="available"></p>
        <button type="submit" class="primary">Send</button>
        <p class="status" data-status role="status"></p>
      </form>`,
    earn: earnPanel(),
    withdraw: `
      <form id="f-withdraw" novalidate>
        <div class="fields">
          <label>Network <select name="asset">${assetOptions("ETH_SEPOLIA", { ETH_SEPOLIA: chainName("ETH_SEPOLIA"), ETH_BASE_SEPOLIA: chainName("ETH_BASE_SEPOLIA") })}</select></label>
          <label>Amount <input name="amount" inputmode="decimal" placeholder="0.01" autocomplete="off"></label>
        </div>
        <label>To address <input name="destination" value="${esc(lastDest)}" placeholder="0x… such as your MetaMask address" autocomplete="off" spellcheck="false" class="mono"></label>
        <p class="hint" data-hint="available"></p>
        <p class="note">The app locks the amount plus a network fee reserve before anything is signed. The unused part of the fee comes back when the withdrawal confirms.</p>
        <p class="note" data-hint="cap"></p>
        <button type="submit" class="primary">Withdraw</button>
        <p class="status" data-status role="status"></p>
      </form>`,
    liquidity: `
      <form id="f-liquidity" novalidate>
        <p>Move part of your own balance into the swap pool. The pool's two balances set the swap price.</p>
        <div class="fields">
          <label>Asset <select name="asset">${assetOptions("ETH_SEPOLIA")}</select></label>
          <label>Amount <input name="amount" inputmode="decimal" placeholder="0.02" autocomplete="off"></label>
        </div>
        <p class="hint" data-hint="available"></p>
        <button type="submit" class="primary">Add to pool</button>
        <p class="status" data-status role="status"></p>
      </form>`,
  };
  el.innerHTML = panels[state.tab];
  for (const b of root.querySelectorAll<HTMLButtonElement>("[data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === state.tab));
  renderHints();
  if (state.tab === "earn") {
    renderBorrow();
    void loadBorrow();
  }
}

/** Each network's per-withdrawal limit, as the vault's policy sets it. */
function capText(asset: Asset): string {
  const cap = state.status?.withdrawalCaps?.[asset];
  if (!cap) return "";
  return `Withdrawals on ${chainName(asset)} are limited to ${fmtEth(cap, 2)} ETH each by ${vaultName()}'s own policy. This app has no limit of its own.`;
}

function renderHints() {
  const form = $<HTMLFormElement>("#panel form");
  if (form) {
    const sel = form.querySelector<HTMLSelectElement>("select[name=asset], select[name=assetIn]");
    const hint = form.querySelector("[data-hint=available]");
    if (sel && hint) hint.textContent = `Available: ${fmtEth(available(sel.value as Asset))} ${ASSET_NAMES[sel.value as Asset]}`;
    const cap = form.querySelector("[data-hint=cap]");
    if (sel && cap) cap.textContent = capText(sel.value as Asset);
  }
  // The Earn tab's own number ticks with the vault's aWETH, without redrawing the forms.
  const mine = $("#earn-mine");
  const earnAsset = Object.keys(state.status?.earn ?? {})[0] as Asset | undefined;
  if (mine && earnAsset) mine.textContent = `${fmtEth(state.view?.earning?.[earnAsset] ?? "0", 10)} ${ASSET_NAMES[earnAsset]}`;
  const e = earnAsset ? state.status?.earn[earnAsset] : undefined;
  const rate = $("#earn-rate");
  if (rate && e) rate.textContent = earnRateText(e);
  const pool = $("#earn-pool");
  if (pool && e && earnAsset) pool.textContent = `${fmtEth(e.supplied, 6)} ${ASSET_NAMES[earnAsset]}`;
  const start = $<HTMLFormElement>("#f-earn-start");
  const hint = start?.querySelector("[data-hint=available]");
  if (hint && earnAsset) hint.textContent = `Available: ${fmtEth(available(earnAsset))} ${ASSET_NAMES[earnAsset]}`;
}

let quoteTimer: number | undefined;
function scheduleQuote() {
  window.clearTimeout(quoteTimer);
  quoteTimer = window.setTimeout(async () => {
    const form = $<HTMLFormElement>("#f-swap");
    const out = $("#quote");
    if (!form || !out) return;
    const assetIn = (form.elements.namedItem("assetIn") as HTMLSelectElement).value as Asset;
    const raw = (form.elements.namedItem("amount") as HTMLInputElement).value;
    if (!raw.trim()) {
      out.textContent = "Enter an amount to see what you get.";
      return;
    }
    try {
      const amount = parseEthInput(raw);
      const { amountOut } = await api.quote(assetIn, other(assetIn), amount);
      out.innerHTML = `You get about <strong>${fmtEth(amountOut)} ${ASSET_NAMES[other(assetIn)]}</strong>. The swap stops if the price moves more than 1% before it settles.`;
    } catch (err) {
      out.textContent =
        err instanceof ApiError && err.code === "NO_LIQUIDITY"
          ? "The pool has no liquidity yet. The liquidity provider adds it from the Add liquidity tab."
          : (err as Error).message;
    }
  }, 250);
}

function say(el: Element | null, text: string, tone: "ok" | "err" | "" = "") {
  if (!el) return;
  el.textContent = text;
  el.className = `status ${tone}`;
}

function setBusy(busy: boolean) {
  state.busy = busy;
  for (const b of root.querySelectorAll<HTMLButtonElement>("#panel button.primary")) b.disabled = busy;
  syncBorrowButtons();
  renderHints();
}

/** Sign one request with the user's wallet and hand it to the app. */
async function submit(action: RequestAction, params: Record<string, string>, out: Element | null, done: (res: Record<string, unknown> & { settledMs?: number }) => string) {
  if (state.busy || !state.me) return false;
  const signer = state.me.signer;
  setBusy(true);
  try {
    // Always read the next sequence number fresh: a failed request still uses one up.
    const { nextSeq } = await api.account(signer.address);
    say(out, `Signing request #${nextSeq} with ${signer.description}…`);
    const signature = await signer.signMessage(requestMessage(signer.address, nextSeq, action, params));
    // NEXT PERSON: must match the ref the app builds in handleRequest (req:<lowercase account>:<seq>), or this card never fills in.
    state.latest = { ref: `req:${signer.address}:${nextSeq}`, title: ACTION_TITLES[action] };
    renderLatest();
    const trace = signer.lastActivity ? { activityId: signer.lastActivity.id, signMs: signer.lastActivity.ms } : undefined;
    const res = await api.request({ account: signer.address, seq: nextSeq, action, params, signature, trace });
    say(out, done(res), "ok");
    return true;
  } catch (err) {
    if (err instanceof SessionExpired) {
      await expireSession();
      return false;
    }
    say(out, (err as Error).message, "err");
    return false;
  } finally {
    setBusy(false);
    void refresh();
  }
}

const ACTION_TITLES: Record<RequestAction, string> = { transfer: "Send", swap: "Swap", withdraw: "Withdraw", add_liquidity: "Add liquidity", earn_start: "Start earning", earn_stop: "Stop earning" };

const settled = (res: { settledMs?: number }) => (res.settledMs !== undefined ? ` Settled in ${fmtMs(res.settledMs)}, no blockchain involved.` : "");

async function onSubmit(form: HTMLFormElement) {
  const out = form.querySelector("[data-status]");
  const field = (n: string) => (form.elements.namedItem(n) as HTMLInputElement | HTMLSelectElement | null)?.value.trim() ?? "";
  let amount: bigint;
  try {
    amount = parseEthInput(field("amount"));
  } catch (err) {
    say(out, (err as Error).message, "err");
    return;
  }
  const clearAmount = () => ((form.elements.namedItem("amount") as HTMLInputElement).value = "");
  const shown = (a: Asset) => `${fmtEth(amount)} ${ASSET_NAMES[a]}`;

  if (form.id === "f-swap") {
    const assetIn = field("assetIn") as Asset;
    let minOut = 0n;
    try {
      minOut = (BigInt((await api.quote(assetIn, other(assetIn), amount)).amountOut) * 99n) / 100n;
    } catch (err) {
      say(out, (err as Error).message, "err");
      return;
    }
    const ok = await submit("swap", { asset: assetIn, assetOut: other(assetIn), amount: amount.toString(), minOut: minOut.toString() }, out, (res) =>
      `Swapped ${shown(assetIn)} for ${fmtEth(String(res.amountOut))} ${ASSET_NAMES[other(assetIn)]}.${settled(res)}`,
    );
    if (ok) {
      clearAmount();
      scheduleQuote();
    }
  } else if (form.id === "f-send") {
    const asset = field("asset") as Asset;
    // Check the recipient before the wallet signs anything: a wrong address must not cost a Turnkey signature.
    const who = await findRecipient(field("to"));
    if ("error" in who) return say(out, who.error, "err");
    if (await submit("transfer", { to: who.account, asset, amount: amount.toString() }, out, (res) => `Sent ${shown(asset)} to ${who.name}.${settled(res)}`)) clearAmount();
  } else if (form.id === "f-withdraw") {
    const asset = field("asset") as Asset;
    const destination = field("destination");
    if (!isAddress(destination)) return say(out, "Enter the address to withdraw to: 0x followed by 40 characters.", "err");
    // Check the address before the wallet signs: a withdrawal cannot reach a contract or smart account.
    try {
      const d = await api.destination(destination, asset);
      if (!d.plain) return say(out, d.message ?? "That address cannot receive a plain transfer.", "err");
    } catch (err) {
      return say(out, `Could not check that address: ${(err as Error).message}`, "err");
    }
    try {
      localStorage.setItem("crossroads.lastDestination", destination);
    } catch {
      /* not remembered */
    }
    const ok = await submit("withdraw", { asset, amount: amount.toString(), destination }, out, (res) =>
      `Withdrawal of ${shown(asset)} requested and funds locked, including a ${fmtEth(String(res.feeReserved), 6)} ETH fee reserve. Follow it under In flight.`,
    );
    if (ok) clearAmount();
  } else if (form.id === "f-earn-start") {
    const asset = field("asset") as Asset;
    if (await submit("earn_start", { asset, amount: amount.toString() }, out, () => `${shown(asset)} locked to supply to Aave. Follow it under In flight.`)) clearAmount();
  } else if (form.id === "f-earn-stop") {
    const asset = field("asset") as Asset;
    if (await submit("earn_stop", { asset, amount: amount.toString() }, out, () => `Taking ${shown(asset)} back from Aave. Follow it under In flight.`)) clearAmount();
  } else if (form.id === "f-liquidity") {
    const asset = field("asset") as Asset;
    if (await submit("add_liquidity", { asset, amount: amount.toString() }, out, (res) => `Added ${shown(asset)} to the pool.${settled(res)}`)) clearAmount();
  }
}

/** A Send recipient, checked with the app before anything is signed. */
async function findRecipient(raw: string): Promise<{ account: string; name: string } | { error: string }> {
  const q = raw.trim();
  if (!isAddress(q)) return { error: "Enter their account ID or Crossroads deposit address: 0x followed by 40 characters." };
  try {
    const r = await api.recipient(q);
    if (r.account === state.me?.signer.address) return { error: "That is your own account. To move funds to your own wallet, use Withdraw." };
    return { account: r.account, name: r.name };
  } catch (err) {
    return { error: err instanceof ApiError && err.code === "NOT_AN_ACCOUNT" ? err.message : `Could not check that address: ${(err as Error).message}` };
  }
}

let recipientTimer: number | undefined;
/** Shows "Sending to <name>" under the To field as soon as a full address is typed. */
function scheduleRecipient() {
  window.clearTimeout(recipientTimer);
  recipientTimer = window.setTimeout(async () => {
    const input = $<HTMLInputElement>("#f-send input[name=to]");
    const hint = $("#f-send [data-hint=recipient]");
    if (!input || !hint) return;
    const raw = input.value;
    if (!raw.trim()) return void (hint.textContent = "");
    if (!isAddress(raw)) return void (hint.textContent = "");
    const who = await findRecipient(raw);
    if (input.value !== raw) return; // the field changed while checking
    hint.textContent = "error" in who ? who.error : `Sending to ${who.name}`;
    hint.className = `hint ${"error" in who ? "err" : "ok"}`;
  }, 250);
}

// ---------- data loop ----------

async function refresh() {
  if (!state.me) return;
  if (state.me.signer.expired?.()) return expireSession();
  const id = state.me.signer.address;
  try {
    const [view, hood] = await Promise.all([api.account(id), api.hood(id)]);
    if (state.tick++ % 3 === 0) state.status = await api.status();
    state.view = view;
    state.hood = hood;
    const offline = $("#offline");
    if (offline) offline.hidden = true;
    const addrShown = $(".bigaddr code");
    if (addrShown && addrShown.textContent !== view.depositAddress) renderPanel();
    renderBalances();
    renderInflight();
    renderFeed();
    renderHood();
    renderLatest();
    renderHints();
    if (state.tab === "earn" && Date.now() - state.borrowReadAt > 15_000) void loadBorrow();
  } catch (err) {
    if (err instanceof ApiError && err.code === "NO_ACCOUNT") return renderLogin("This account is not on the app any more. Choose it again to register it.");
    const offline = $("#offline");
    if (offline) offline.hidden = false;
  }
}

// ---------- events ----------

root.addEventListener("click", async (ev) => {
  const t = (ev.target as Element).closest<HTMLElement>("button, [data-copy]");
  if (!t) return;
  if (t.dataset.copy) {
    const text = t.dataset.copy;
    const was = t.textContent;
    try {
      await navigator.clipboard.writeText(text);
      t.textContent = "Copied";
    } catch {
      t.textContent = "Copy failed";
    }
    setTimeout(() => (t.textContent = was), 1500);
    return;
  }
  if (t.dataset.earnAll) {
    const out = $("#f-earn-stop [data-status]");
    void submit("earn_stop", { asset: t.dataset.earnAll, amount: "all" }, out, () => "Taking everything you have earning back from Aave. Follow it under In flight.");
    return;
  }
  if (t.dataset.borrowMax !== undefined) {
    const p = selectedBorrowPosition();
    const input = $<HTMLInputElement>("#f-borrow input[name=amount]");
    if (p && input && state.borrow) input.value = fmtUnits(p.maxBorrow, state.borrow.asset.decimals);
    return;
  }
  if (t.dataset.check) {
    void runProofCheck(root, t.dataset.check, t as HTMLButtonElement);
    return;
  }
  if (t.dataset.tab) {
    state.tab = t.dataset.tab as Tab;
    renderPanel();
    return;
  }
  if (t.dataset.pick) {
    const input = $<HTMLInputElement>("#f-send input[name=to]");
    if (input) input.value = t.dataset.pick;
    scheduleRecipient();
    return;
  }
  if (t.dataset.login) {
    const acct = standIn.list().find((a) => a.address === t.dataset.login);
    if (acct) login(acct).catch((err) => renderLogin((err as Error).message));
    return;
  }
  if (t.id === "switch") {
    standIn.setCurrent(null);
    renderLogin();
  } else if (t.id === "signout") {
    void googleSession.clear().finally(() => renderLogin());
  } else if (t.id === "theme") {
    setTheme(currentTheme() === "dark" ? "light" : "dark");
  }
});

root.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const form = ev.target as HTMLFormElement;
  if (form.id === "signup") {
    const name = (form.elements.namedItem("name") as HTMLInputElement).value.trim();
    if (!name) return;
    createAccount(name).catch((err) => renderLogin((err as Error).message));
    return;
  }
  if (form.id === "f-borrow") return void onBorrow(form);
  void onSubmit(form);
});

root.addEventListener("input", (ev) => {
  const el = ev.target as Element;
  if (el.closest("#f-swap")) scheduleQuote();
  if (el.matches("#f-send input[name=to]")) scheduleRecipient();
  renderHints();
});
root.addEventListener("change", (ev) => {
  if ((ev.target as Element).closest("#f-swap")) scheduleQuote();
  if ((ev.target as Element).matches("[data-borrow-address]")) renderBorrow();
  renderHints();
});

// ---------- start ----------

async function boot() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
  } catch {
    /* default theme */
  }
  if (location.pathname === "/proof") return renderProof(root);
  try {
    state.status = await api.status();
  } catch {
    root.innerHTML = `<main class="login"><h1>Crossroads on Turnkey</h1><p class="status err">Cannot reach the app. Retrying in a few seconds.</p></main>`;
    setTimeout(boot, 3000);
    return;
  }
  const session = googleMode() ? googleSession.current() : null;
  const current = googleMode() ? null : standIn.current();
  if (session)
    await enter({ name: session.name, address: session.address }, turnkeySigner(session)).catch(async () => {
      // The app started fresh since this browser signed in: signing in again recreates the account.
      await googleSession.clear();
      renderLogin("Please continue with Google again.");
    });
  else if (current) await login(current).catch((err) => renderLogin((err as Error).message));
  else renderLogin();
  setInterval(() => void refresh(), 2000);
}

void boot();
