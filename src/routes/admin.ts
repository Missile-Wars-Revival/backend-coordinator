import type { Express, Request, Response } from "express";
import { adminAuth, sendError } from "../middleware";
import { getStore, hashApiKey, isShardListable } from "../store";
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
      const shards = await getStore().listShards();
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
  button { background: #21262d; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; padding: .45rem .8rem; cursor: pointer; }
  button:hover { border-color: #8b949e; }
  button.primary { background: #238636; border-color: #238636; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: .5rem .75rem; border-bottom: 1px solid #21262d; font-size: .9rem; vertical-align: top; }
  .pill { display: inline-block; padding: .1rem .5rem; border-radius: 999px; font-size: .75rem; border: 1px solid #30363d; }
  .pill.active { color: #3fb950; border-color: #3fb950; }
  .pill.pending { color: #d29922; border-color: #d29922; }
  .pill.disabled { color: #f85149; border-color: #f85149; }
  .pill.verified { color: #58a6ff; border-color: #58a6ff; }
  .muted { color: #8b949e; font-size: .8rem; }
  #msg { margin: .75rem 0; min-height: 1.2rem; font-size: .9rem; }
  #msg.err { color: #f85149; }
  #msg.ok { color: #3fb950; }
  td .actions { display: flex; gap: .35rem; flex-wrap: wrap; }
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
  <thead><tr><th>Shard</th><th>Region</th><th>URLs</th><th>Status</th><th>Players</th><th>Last heartbeat</th><th>Actions</th></tr></thead>
  <tbody></tbody>
</table>
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
          (s.ownerContact ? '<div class="muted">' + esc(s.ownerContact) + '</div>' : '') + '</td>' +
        '<td>' + esc(s.region || '') + '</td>' +
        '<td class="muted">' + esc(s.publicHttpUrl) + '<br>' + esc(s.publicWsUrl || '') + '</td>' +
        '<td><span class="pill ' + s.status + '">' + s.status + '</span> ' +
          (s.verified ? '<span class="pill verified">verified</span>' : '') + '</td>' +
        '<td>' + (s.playerCount ?? 0) + '</td>' +
        '<td>' + ago(s.lastHeartbeatAt) + (s.version ? '<div class="muted">v' + esc(s.version) + '</div>' : '') + '</td>' +
        '<td></td>';
      const actions = document.createElement('div');
      actions.className = 'actions';
      actions.append(
        btn(s.verified ? 'Unverify' : 'Verify', () => act(s.id, s.verified ? 'unverify' : 'verify')),
        btn(s.status === 'disabled' ? 'Enable' : 'Disable', () => act(s.id, s.status === 'disabled' ? 'enable' : 'disable')),
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
  if (!confirm('Rotate this shard\\'s API key? The old key stops working immediately.')) return;
  try {
    const { apiKey } = await api('/admin/api/shards/' + id + '/rotate-key', { method: 'POST' });
    prompt('New API key (shown once — copy it now):', apiKey);
    await load();
  } catch (e) { msg(e.message, 'err'); }
}

$('#load').onclick = load;
keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
if (keyInput.value) load();
</script>
</body>
</html>`;
