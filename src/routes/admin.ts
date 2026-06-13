import type { Express, Request, Response } from "express";
import { z } from "zod";
import { adminAuth, sendError } from "../middleware";
import {
  getIdentityBadges,
  getUidByProfileUsername,
  isKnownIdentityBadge,
  KNOWN_IDENTITY_BADGES,
  setIdentityBadge,
} from "../social";
import { getStore, hashApiKey, isShardListable, reconcileOfflineShards } from "../store";
import { newShardApiKey } from "./shards";

// Admin API + a small self-contained portal page. Everything under
// /admin/api/* requires the coordinator's ADMIN_API_KEY (Bearer or X-Admin-Key).

export function setupAdminRoutes(app: Express) {
  app.get("/admin", (_req: Request, res: Response) => {
    res.type("html").send(PORTAL_HTML);
  });

  // Full shard records (minus key hashes) — includes pending/disabled/stale.
  app.get("/admin/api/shards", adminAuth, async (_req: Request, res: Response) => {
    try {
      const shards = await reconcileOfflineShards(await getStore().listShards());
      res.json({
        ok: true,
        data: {
          shards: shards
            .sort((a, b) => b.createdAt - a.createdAt)
            .map(({ apiKeyHash: _hash, ...rest }) => ({ ...rest, listable: isShardListable(rest as never) })),
        },
      });
    } catch (error) {
      console.error("[admin/shards]", error);
      sendError(res, 500, "INTERNAL", "Failed to list shards.");
    }
  });

  app.post("/admin/api/shards/:id/verify", adminAuth, (req, res) => setFlags(req, res, { verified: true }));
  app.post("/admin/api/shards/:id/unverify", adminAuth, (req, res) => setFlags(req, res, { verified: false }));
  app.post("/admin/api/shards/:id/disable", adminAuth, (req, res) => setFlags(req, res, { status: "disabled" as const }));
  app.post("/admin/api/shards/:id/enable", adminAuth, (req, res) => setFlags(req, res, { status: "active" as const }));
  app.post("/admin/api/shards/:id/urls", adminAuth, updateUrls);

  // Rotate a shard's API key (e.g. after a leak). Old key dies immediately;
  // the new key is returned once for the admin to hand to the shard owner.
  app.post("/admin/api/shards/:id/rotate-key", adminAuth, async (req: Request, res: Response) => {
    try {
      const store = getStore();
      const shard = await store.getShard(req.params.id);
      if (!shard) return sendError(res, 404, "NOT_FOUND", "No such shard.");
      const apiKey = newShardApiKey();
      await store.rotateShardKey(shard.id, shard.apiKeyHash, hashApiKey(apiKey));
      res.json({ ok: true, data: { shardId: shard.id, apiKey } });
    } catch (error) {
      console.error("[admin/rotate-key]", error);
      sendError(res, 500, "INTERNAL", "Key rotation failed.");
    }
  });

  // Phase 10: read a user's central identity badges (by game username).
  app.get("/admin/api/identity-badges", adminAuth, async (req: Request, res: Response) => {
    try {
      const username = typeof req.query.username === "string" ? req.query.username.trim() : "";
      if (!username) return sendError(res, 400, "INVALID_QUERY", "Provide ?username=.");
      const uid = await getUidByProfileUsername(username);
      if (!uid) return sendError(res, 404, "NO_PROFILE", `No central profile found for "${username}".`);
      const badges = await getIdentityBadges(uid);
      res.json({ ok: true, data: { username, uid, badges, known: KNOWN_IDENTITY_BADGES } });
    } catch (error) {
      console.error("[admin/identity-badges:get]", error);
      sendError(res, 500, "INTERNAL", "Failed to read identity badges.");
    }
  });

  // Grant or revoke a single identity badge for a user.
  app.post("/admin/api/identity-badges", adminAuth, async (req: Request, res: Response) => {
    try {
      const parsed = IdentityBadgeSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return sendError(res, 400, "INVALID_BODY", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      }
      const { username, badge, granted } = parsed.data;
      if (!isKnownIdentityBadge(badge)) {
        return sendError(res, 400, "UNKNOWN_BADGE", `Unknown identity badge. Allowed: ${KNOWN_IDENTITY_BADGES.join(", ")}.`);
      }
      const uid = await getUidByProfileUsername(username);
      if (!uid) return sendError(res, 404, "NO_PROFILE", `No central profile found for "${username}".`);

      await setIdentityBadge(uid, badge, granted);
      res.json({ ok: true, data: { username, uid, badges: await getIdentityBadges(uid) } });
    } catch (error) {
      console.error("[admin/identity-badges:post]", error);
      sendError(res, 500, "INTERNAL", "Failed to update identity badge.");
    }
  });
}

const IdentityBadgeSchema = z.object({
  username: z.string().min(1).max(64),
  badge: z.string().min(1).max(40),
  granted: z.boolean(),
});

const UrlUpdateSchema = z.object({
  publicHttpUrl: z.string().url().max(200).refine((url) => hasProtocol(url, ["http:", "https:"]), {
    message: "Must use http or https.",
  }),
  publicWsUrl: z
    .string()
    .url()
    .max(200)
    .refine((url) => hasProtocol(url, ["ws:", "wss:"]), { message: "Must use ws or wss." })
    .optional(),
});

function hasProtocol(url: string, protocols: string[]): boolean {
  try {
    return protocols.includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

async function setFlags(
  req: Request,
  res: Response,
  patch: { verified?: boolean; status?: "active" | "disabled" }
) {
  try {
    const store = getStore();
    const shard = await store.getShard(req.params.id);
    if (!shard) return sendError(res, 404, "NOT_FOUND", "No such shard.");
    await store.updateShard(shard.id, patch);
    res.json({ ok: true, data: { shardId: shard.id, ...patch } });
  } catch (error) {
    console.error("[admin/setFlags]", error);
    sendError(res, 500, "INTERNAL", "Update failed.");
  }
}

async function updateUrls(req: Request, res: Response) {
  try {
    const parsed = UrlUpdateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return sendError(res, 400, "INVALID_BODY", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    }

    const store = getStore();
    const shard = await store.getShard(req.params.id);
    if (!shard) return sendError(res, 404, "NOT_FOUND", "No such shard.");

    const publicHttpUrl = parsed.data.publicHttpUrl;
    const publicWsUrl = parsed.data.publicWsUrl ?? publicHttpUrl.replace(/^http/, "ws");
    await store.updateShard(shard.id, { publicHttpUrl, publicWsUrl });
    res.json({ ok: true, data: { shardId: shard.id, publicHttpUrl, publicWsUrl } });
  } catch (error) {
    console.error("[admin/updateUrls]", error);
    sendError(res, 500, "INTERNAL", "URL update failed.");
  }
}

const PORTAL_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Missile Wars — Coordinator Admin</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: system-ui, sans-serif; background: #0d1117; color: #e6edf3; margin: 0; padding: 2rem; }
  h1 { font-size: 1.3rem; }
  .bar { display: flex; gap: .5rem; margin-bottom: 1.5rem; flex-wrap: wrap; }
  input { background: #161b22; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; padding: .5rem .75rem; min-width: 280px; }
  label { display: block; color: #8b949e; font-size: .8rem; margin-bottom: .35rem; }
  button { background: #21262d; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; padding: .45rem .8rem; cursor: pointer; }
  button:hover { border-color: #8b949e; }
  button.primary { background: #238636; border-color: #238636; }
  button.ghost { background: transparent; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: .5rem .75rem; border-bottom: 1px solid #21262d; font-size: .9rem; vertical-align: top; }
  .pill { display: inline-block; padding: .1rem .5rem; border-radius: 999px; font-size: .75rem; border: 1px solid #30363d; }
  .pill.active { color: #3fb950; border-color: #3fb950; }
  .pill.pending { color: #d29922; border-color: #d29922; }
  .pill.offline { color: #8b949e; border-color: #8b949e; }
  .pill.disabled { color: #f85149; border-color: #f85149; }
  .pill.verified { color: #58a6ff; border-color: #58a6ff; }
  .muted { color: #8b949e; font-size: .8rem; }
  #msg, #badgeMsg { margin: .75rem 0; min-height: 1.2rem; font-size: .9rem; }
  #msg.err, #badgeMsg.err { color: #f85149; }
  #msg.ok, #badgeMsg.ok { color: #3fb950; }
  td .actions { display: flex; gap: .35rem; flex-wrap: wrap; }
  .modal-backdrop { position: fixed; inset: 0; display: grid; place-items: center; background: rgb(1 4 9 / .76); padding: 1rem; }
  .modal-backdrop[hidden] { display: none !important; }
  .modal { width: min(560px, 100%); background: #0d1117; border: 1px solid #30363d; border-radius: 8px; padding: 1rem; box-shadow: 0 20px 48px rgb(1 4 9 / .45); }
  .modal h2 { margin: 0 0 .25rem; font-size: 1rem; }
  .modal .field { margin-top: .85rem; }
  .modal input { box-sizing: border-box; width: 100%; min-width: 0; }
  .modal .actions { display: flex; justify-content: flex-end; gap: .5rem; margin-top: 1rem; }
</style>
</head>
<body>
<h1>Missile Wars — Coordinator Admin</h1>
<div class="bar">
  <input id="key" type="password" placeholder="Admin API key">
  <button class="primary" id="load">Load shards</button>
</div>
<div id="msg"></div>
<table id="tbl" hidden>
  <thead><tr><th>Shard</th><th>Owner</th><th>Region</th><th>URLs</th><th>Status</th><th>Players</th><th>Activity</th><th>Meta</th><th>Actions</th></tr></thead>
  <tbody></tbody>
</table>
<div id="urlEditor" class="modal-backdrop" hidden>
  <form id="urlForm" class="modal">
    <h2>Edit server address</h2>
    <div id="urlShardName" class="muted"></div>
    <input id="urlShardId" type="hidden">
    <div class="field">
      <label for="publicHttpUrl">Public HTTP URL</label>
      <input id="publicHttpUrl" type="url" placeholder="https://example.com" required>
    </div>
    <div class="field">
      <label for="publicWsUrl">Public WebSocket URL</label>
      <input id="publicWsUrl" type="url" placeholder="wss://example.com" required>
    </div>
    <div class="actions">
      <button type="button" class="ghost" id="cancelUrlEdit">Cancel</button>
      <button type="submit" class="primary">Save URLs</button>
    </div>
  </form>
</div>
<h1 style="font-size:1.05rem;margin-top:2.25rem;">Identity badges</h1>
<div class="muted" style="margin-bottom:.6rem;">Account-level badges (staff / early access / founder / debug). Stored centrally in Firebase so they follow the player across shards. League badges stay per-shard and are not managed here.</div>
<div class="bar">
  <input id="badgeUser" placeholder="Game username">
  <button id="badgeLoad">Load badges</button>
</div>
<div id="badgeMsg"></div>
<div id="badgePanel" hidden><div id="badgeRow" class="actions"></div></div>
<script>
const $ = (s) => document.querySelector(s);
const keyInput = $('#key');
keyInput.value = localStorage.getItem('mwAdminKey') || '';

function msg(text, cls) { const el = $('#msg'); el.textContent = text; el.className = cls || ''; }

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'X-Admin-Key': keyInput.value, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) throw new Error((body.error && body.error.message) || ('HTTP ' + res.status));
  return body.data;
}

function ago(ts) {
  if (!ts) return '—';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 90) return s + 's ago';
  if (s < 5400) return Math.round(s / 60) + 'm ago';
  return Math.round(s / 3600) + 'h ago';
}

function when(ts) {
  return ts ? new Date(ts).toLocaleString() : '-';
}

async function load() {
  localStorage.setItem('mwAdminKey', keyInput.value);
  msg('Loading…');
  try {
    const { shards } = await api('/admin/api/shards');
    const tbody = $('#tbl tbody');
    tbody.innerHTML = '';
    for (const s of shards) {
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td><strong>' + esc(s.name) + '</strong><div class="muted">' + s.id + '</div>' +
          (s.description ? '<div class="muted">' + esc(s.description) + '</div>' : '') + '</td>' +
        '<td>' + esc(s.ownerContact || 'missing') + '</td>' +
        '<td>' + esc(s.region || '') + '</td>' +
        '<td class="muted">' + esc(s.publicHttpUrl) + '<br>' + esc(s.publicWsUrl || '') + '</td>' +
        '<td><span class="pill ' + s.status + '">' + s.status + '</span> ' +
          (s.verified ? '<span class="pill verified">verified</span>' : '') +
          (s.listable ? '<div class="muted">discoverable</div>' : '<div class="muted">hidden from discovery</div>') + '</td>' +
        '<td>' + (s.playerCount ?? 0) + ' / ' + (s.totalPlayerCount ?? '?') + '<div class="muted">online / total</div></td>' +
        '<td>' + ago(s.lastHeartbeatAt) + '<div class="muted">' + when(s.lastHeartbeatAt) + '</div>' +
          (s.version ? '<div class="muted">version ' + esc(s.version) + '</div>' : '') +
          (s.gitSha ? '<div class="muted">git ' + esc(s.gitSha) + '</div>' : '') + '</td>' +
        '<td><div class="muted">created ' + when(s.createdAt) + '</div>' +
          '<div class="muted">updated ' + when(s.updatedAt) + '</div>' +
          ((s.lat !== undefined && s.lon !== undefined) ? '<div class="muted">coords ' + esc(s.lat) + ', ' + esc(s.lon) + '</div>' : '') + '</td>' +
        '<td></td>';
      const actions = document.createElement('div');
      actions.className = 'actions';
      actions.append(
        btn(s.verified ? 'Unverify' : 'Verify', () => act(s.id, s.verified ? 'unverify' : 'verify')),
        btn(s.status === 'disabled' ? 'Enable' : 'Disable', () => act(s.id, s.status === 'disabled' ? 'enable' : 'disable')),
        btn('Edit URLs', () => openUrlEditor(s)),
        btn('Rotate key', () => rotate(s.id)),
      );
      tr.lastElementChild.append(actions);
      tbody.append(tr);
    }
    $('#tbl').hidden = false;
    msg(shards.length + ' shard(s).', 'ok');
  } catch (e) { msg(e.message, 'err'); }
}

function btn(label, onClick) { const b = document.createElement('button'); b.textContent = label; b.onclick = onClick; return b; }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

async function act(id, action) {
  try { await api('/admin/api/shards/' + id + '/' + action, { method: 'POST' }); await load(); }
  catch (e) { msg(e.message, 'err'); }
}

async function rotate(id) {
  if (!confirm("Rotate this shard's API key? The old key stops working immediately.")) return;
  try {
    const { apiKey } = await api('/admin/api/shards/' + id + '/rotate-key', { method: 'POST' });
    prompt('New API key (shown once — copy it now):', apiKey);
    await load();
  } catch (e) { msg(e.message, 'err'); }
}

function openUrlEditor(s) {
  $('#urlShardId').value = s.id;
  $('#urlShardName').textContent = s.name + ' · ' + s.id;
  $('#publicHttpUrl').value = s.publicHttpUrl || '';
  $('#publicWsUrl').value = s.publicWsUrl || (s.publicHttpUrl || '').replace(/^http/, 'ws');
  $('#urlEditor').hidden = false;
  $('#publicHttpUrl').focus();
}

function closeUrlEditor() {
  $('#urlEditor').hidden = true;
  $('#urlForm').reset();
}

async function saveUrls(e) {
  e.preventDefault();
  const shardId = $('#urlShardId').value;
  const publicHttpUrl = $('#publicHttpUrl').value.trim();
  const publicWsUrl = $('#publicWsUrl').value.trim();
  try {
    await api('/admin/api/shards/' + shardId + '/urls', {
      method: 'POST',
      body: JSON.stringify({ publicHttpUrl, publicWsUrl }),
    });
    closeUrlEditor();
    await load();
  } catch (e) { msg(e.message, 'err'); }
}

let knownBadges = [];
function badgeMsg(text, cls) { const el = $('#badgeMsg'); el.textContent = text; el.className = cls || ''; }

async function loadBadges() {
  const username = $('#badgeUser').value.trim();
  if (!username) return badgeMsg('Enter a username.', 'err');
  badgeMsg('Loading…');
  try {
    const data = await api('/admin/api/identity-badges?username=' + encodeURIComponent(username));
    knownBadges = data.known;
    renderBadges(data.username, data.badges);
  } catch (e) { $('#badgePanel').hidden = true; badgeMsg(e.message, 'err'); }
}

function renderBadges(username, badges) {
  const have = new Set(badges);
  const row = $('#badgeRow');
  row.innerHTML = '';
  for (const b of knownBadges) {
    const on = have.has(b);
    const button = btn((on ? '✓ ' : '+ ') + b, () => setBadge(username, b, !on));
    if (on) button.classList.add('primary');
    row.append(button);
  }
  $('#badgePanel').hidden = false;
  badgeMsg(esc(username) + ' · ' + (badges.length ? badges.join(', ') : 'no identity badges'), 'ok');
}

async function setBadge(username, badge, granted) {
  try {
    const data = await api('/admin/api/identity-badges', { method: 'POST', body: JSON.stringify({ username, badge, granted }) });
    renderBadges(data.username, data.badges);
  } catch (e) { badgeMsg(e.message, 'err'); }
}

$('#badgeLoad').onclick = loadBadges;
$('#badgeUser').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadBadges(); });
$('#load').onclick = load;
$('#cancelUrlEdit').onclick = closeUrlEditor;
$('#urlForm').addEventListener('submit', saveUrls);
$('#urlEditor').addEventListener('click', (e) => { if (e.target.id === 'urlEditor') closeUrlEditor(); });
keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
if (keyInput.value) load();
</script>
</body>
</html>`;
