/**
 * The trading page. Plain DOM, no framework: one shell rendered on login, data
 * sections re-rendered on each poll, forms rendered once per tab so typing is
 * never interrupted.
 */
import { requestMessage, type RequestAction } from "../src/ledger/requests.js";
import { api, ApiError, type AccountView, type Asset, type FeedEvent, type HoodEntry, type Status } from "./api.js";
import { standIn, type RequestSigner, type StandInAccount } from "./signer.js";
import { googleSession, renderGoogleButton, turnkeySigner } from "./google.js";
import { fmtClock, fmtEth, fmtMs, isAddress, parseEthInput, shortAddr, spotRate } from "./format.js";

const ASSET_NAMES: Record<Asset, string> = { ETH_SEPOLIA: "Sepolia ETH", ETH_BASE_SEPOLIA: "Base ETH" };
const BLOCK_SECONDS: Record<Asset, number> = { ETH_SEPOLIA: 12, ETH_BASE_SEPOLIA: 2 };
const other = (a: Asset): Asset => (a === "ETH_SEPOLIA" ? "ETH_BASE_SEPOLIA" : "ETH_SEPOLIA");

type Tab = "deposit" | "swap" | "send" | "withdraw" | "liquidity";
const TAB_NAMES: Record<Tab, string> = { deposit: "Deposit", swap: "Swap", send: "Send", withdraw: "Withdraw", liquidity: "Add liquidity" };

const state = {
  status: null as Status | null,
  me: null as { acct: { name: string; address: string }; signer: RequestSigner } | null,
  view: null as AccountView | null,
  hood: [] as HoodEntry[],
  tab: "deposit" as Tab,
  busy: false,
  tick: 0,
  rendered: { feed: "", hood: "" },
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
  } catch (err) {
    renderLogin((err as Error).message);
  }
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
  state.rendered = { feed: "", hood: "" };
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
      <thead><tr><th scope="col">Asset</th><th scope="col">Available</th><th scope="col">Pending</th></tr></thead>
      <tbody>
        ${state.status.assets
          .map((a) => {
            const b = v.balances[a];
            return `<tr><th scope="row">${ASSET_NAMES[a]} <span class="muted">on ${esc(chainName(a))}</span></th>
              <td class="num">${fmtEth(b.available)}</td>
              <td class="num${BigInt(b.pending) > 0n ? " pending" : " muted"}">${fmtEth(b.pending)}</td></tr>`;
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

function renderHood() {
  const el = $("#hood");
  if (!el) return;
  const key = JSON.stringify(state.hood.map((h) => [h.at, h.text]));
  if (key === state.rendered.hood) return;
  state.rendered.hood = key;
  const label = { turnkey: vaultLabel(), wallet: "Turnkey: your wallet", chain: "Network", ledger: "Ledger" };
  el.innerHTML = state.hood.length
    ? state.hood
        .map(
          (h) => `<li class="src-${h.source}">
            <span class="src">${esc(label[h.source])}</span>
            <p>${esc(h.text)}</p>
            <p class="meta">
              <time>${fmtClock(h.at)}</time>
              ${h.ms !== undefined ? `<span>${fmtMs(h.ms)}</span>` : ""}
              ${h.link ? `<a href="${esc(h.link)}" target="_blank" rel="noopener">View on explorer</a>` : ""}
            </p>
          </li>`,
        )
        .join("")
    : `<li class="empty">Actions you take show up here with what each system did.</li>`;
}

// ---------- action panel ----------

function renderPanel() {
  const el = $("#panel");
  const v = state.view;
  if (!el) return;
  const addr = v?.depositAddress ?? "…";
  const confText = (a: Asset) => {
    const n = state.status?.chains.find((c) => c.asset === a)?.confirmations ?? 0;
    return `${esc(chainName(a))} deposits count after ${n} confirmations, about ${n * BLOCK_SECONDS[a]} seconds.`;
  };
  const cap = fmtEth(state.status?.withdrawalCap ?? "0", 2);
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
        <label>To (their account ID) <input name="to" placeholder="0x…" autocomplete="off" spellcheck="false" class="mono"></label>
        ${others.length ? `<p class="picks">Accounts in this browser: ${others.map((o) => `<button type="button" class="chip" data-pick="${o.address}">${esc(o.name)}</button>`).join(" ")}</p>` : ""}
        <div class="fields">
          <label>Asset <select name="asset">${assetOptions("ETH_SEPOLIA")}</select></label>
          <label>Amount <input name="amount" inputmode="decimal" placeholder="0.01" autocomplete="off"></label>
        </div>
        <p class="hint" data-hint="available"></p>
        <button type="submit" class="primary">Send</button>
        <p class="status" data-status role="status"></p>
      </form>`,
    withdraw: `
      <form id="f-withdraw" novalidate>
        <div class="fields">
          <label>Network <select name="asset">${assetOptions("ETH_SEPOLIA", { ETH_SEPOLIA: chainName("ETH_SEPOLIA"), ETH_BASE_SEPOLIA: chainName("ETH_BASE_SEPOLIA") })}</select></label>
          <label>Amount <input name="amount" inputmode="decimal" placeholder="0.01" autocomplete="off"></label>
        </div>
        <label>To address <input name="destination" value="${esc(lastDest)}" placeholder="0x… such as your MetaMask address" autocomplete="off" spellcheck="false" class="mono"></label>
        <p class="hint" data-hint="available"></p>
        <p class="note">The app locks the amount plus a network fee reserve before anything is signed. The unused part of the fee comes back when the withdrawal confirms.</p>
        <p class="note">Withdrawals are limited to ${cap} ETH each by ${vault}'s own policy. This app has no limit of its own.</p>
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
}

function renderHints() {
  const form = $<HTMLFormElement>("#panel form");
  if (form) {
    const sel = form.querySelector<HTMLSelectElement>("select[name=asset], select[name=assetIn]");
    const hint = form.querySelector("[data-hint=available]");
    if (sel && hint) hint.textContent = `Available: ${fmtEth(available(sel.value as Asset))} ${ASSET_NAMES[sel.value as Asset]}`;
  }
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
    const res = await api.request({ account: signer.address, seq: nextSeq, action, params, signature });
    say(out, done(res), "ok");
    return true;
  } catch (err) {
    say(out, (err as Error).message, "err");
    return false;
  } finally {
    setBusy(false);
    void refresh();
  }
}

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
    const to = field("to").toLowerCase();
    const asset = field("asset") as Asset;
    if (!isAddress(to)) return say(out, "Enter the recipient's account ID: 0x followed by 40 characters.", "err");
    const name = standIn.list().find((a) => a.address === to)?.name ?? shortAddr(to);
    if (await submit("transfer", { to, asset, amount: amount.toString() }, out, (res) => `Sent ${shown(asset)} to ${name}.${settled(res)}`)) clearAmount();
  } else if (form.id === "f-withdraw") {
    const asset = field("asset") as Asset;
    const destination = field("destination");
    if (!isAddress(destination)) return say(out, "Enter the address to withdraw to: 0x followed by 40 characters.", "err");
    try {
      localStorage.setItem("crossroads.lastDestination", destination);
    } catch {
      /* not remembered */
    }
    const ok = await submit("withdraw", { asset, amount: amount.toString(), destination }, out, (res) =>
      `Withdrawal of ${shown(asset)} requested and funds locked, including a ${fmtEth(String(res.feeReserved), 6)} ETH fee reserve. Follow it under In flight.`,
    );
    if (ok) clearAmount();
  } else if (form.id === "f-liquidity") {
    const asset = field("asset") as Asset;
    if (await submit("add_liquidity", { asset, amount: amount.toString() }, out, (res) => `Added ${shown(asset)} to the pool.${settled(res)}`)) clearAmount();
  }
}

// ---------- data loop ----------

async function refresh() {
  if (!state.me) return;
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
    renderHints();
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
  if (t.dataset.tab) {
    state.tab = t.dataset.tab as Tab;
    renderPanel();
    return;
  }
  if (t.dataset.pick) {
    const input = $<HTMLInputElement>("#f-send input[name=to]");
    if (input) input.value = t.dataset.pick;
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
  void onSubmit(form);
});

root.addEventListener("input", (ev) => {
  const el = ev.target as Element;
  if (el.closest("#f-swap")) scheduleQuote();
  renderHints();
});
root.addEventListener("change", (ev) => {
  if ((ev.target as Element).closest("#f-swap")) scheduleQuote();
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
