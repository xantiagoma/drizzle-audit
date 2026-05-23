/**
 * drizzle-audit example — Express + MySQL + SQLite audit
 *
 * MySQL (in-memory via mysql-memory-server) for app data.
 * bun:sqlite (in-memory) for audit log.
 * Express with Node.js middleware pattern.
 *
 * No Docker or external services needed — everything runs in-memory.
 *
 * Run: bun examples/express-mysql-sqlite/server.ts
 */
import express from "express";
import { eq } from "drizzle-orm";
import { drizzleAuditNodeMiddleware } from "../../src/middleware/node.ts";
import { drizzleAuditAction } from "../../src/audit-action.ts";
import { rawDb, sqliteDb } from "./db.ts";
import { users } from "./schema.ts";
import { getPort } from "get-port-please";

const app = express();
app.use(express.json());

// Audit middleware
app.use(
  drizzleAuditNodeMiddleware((req) => ({
    userId: (req.headers["x-user-id"] as string) ?? "anonymous",
    metadata: {
      method: req.method,
      path: req.url,
      ip: (req.headers["x-forwarded-for"] as string) ?? req.socket.remoteAddress,
    },
  })),
);

// --- API ---

app.get("/api/users", async (_req, res) => {
  res.json(await rawDb.select().from(users));
});

app.post("/api/users", async (req, res) => {
  await rawDb.insert(users).values(req.body);
  const allUsers = await rawDb.select().from(users);
  const user = allUsers[allUsers.length - 1]!;

  await drizzleAuditAction({
    action: "INSERT",
    tableName: "users",
    rowId: String(user.id),
    changes: { ...user },
  });

  res.status(201).json(user);
});

app.patch("/api/users/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [oldUser] = await rawDb.select().from(users).where(eq(users.id, id));
  if (!oldUser) return res.status(404).json({ error: "Not found" });

  await rawDb.update(users).set(req.body).where(eq(users.id, id));
  const [newUser] = await rawDb.select().from(users).where(eq(users.id, id));

  const changes: Record<string, any> = {};
  for (const key of Object.keys(req.body)) {
    if ((oldUser as any)[key] !== (newUser as any)?.[key]) {
      changes[key] = { from: (oldUser as any)[key], to: (newUser as any)?.[key] };
    }
  }

  if (Object.keys(changes).length > 0) {
    await drizzleAuditAction({
      action: "UPDATE",
      tableName: "users",
      rowId: String(id),
      changes,
    });
  }

  res.json(newUser ?? oldUser);
});

app.delete("/api/users/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [user] = await rawDb.select().from(users).where(eq(users.id, id));
  if (!user) return res.status(404).json({ error: "Not found" });

  await rawDb.delete(users).where(eq(users.id, id));

  await drizzleAuditAction({
    action: "DELETE",
    tableName: "users",
    rowId: String(id),
    changes: { ...user },
  });

  res.json({ ok: true });
});

app.get("/api/users/:id/email", async (req, res) => {
  const id = Number(req.params.id);
  const [user] = await rawDb.select().from(users).where(eq(users.id, id));
  if (!user) return res.status(404).json({ error: "Not found" });

  await drizzleAuditAction({
    action: "VIEW_PII",
    tableName: "users",
    rowId: String(id),
    metadata: { field: "email" },
  });

  res.json({ email: user.email });
});

// Audit log — read from SQLite
app.get("/api/audit", async (_req, res) => {
  const rows = sqliteDb
    .query("SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT 50")
    .all() as any[];

  res.json(
    rows.map((r) => ({
      ...r,
      changes: r.changes ? JSON.parse(r.changes) : null,
      oldData: r.old_data ? JSON.parse(r.old_data) : null,
      newData: r.new_data ? JSON.parse(r.new_data) : null,
      metadata: r.metadata ? JSON.parse(r.metadata) : null,
    })),
  );
});

app.get("/", (_req, res) => {
  res.type("html").send(HTML);
});

const port = await getPort({ portRange: [3002, 3100] });
app.listen(port, () => {
  console.log(`\n  drizzle-audit express+mysql+sqlite example at http://localhost:${port}\n`);
});

const HTML = /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>drizzle-audit — Express + MySQL + SQLite</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #0a0a0a; color: #e5e5e5; padding: 24px; }
    h1 { font-size: 1.5rem; margin-bottom: 4px; }
    h1 span { color: #f97316; }
    .subtitle { color: #737373; margin-bottom: 24px; font-size: 0.875rem; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
    @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
    .panel { background: #141414; border: 1px solid #262626; border-radius: 12px; padding: 20px; }
    .panel h2 { font-size: 1rem; margin-bottom: 16px; color: #a3a3a3; }
    table { width: 100%; border-collapse: collapse; font-size: 0.8125rem; }
    th { text-align: left; padding: 8px; color: #737373; border-bottom: 1px solid #262626; font-weight: 500; }
    td { padding: 8px; border-bottom: 1px solid #1a1a1a; }
    .actions { display: flex; gap: 6px; }
    button { background: #262626; border: 1px solid #404040; color: #e5e5e5; padding: 4px 10px; border-radius: 6px; cursor: pointer; font-size: 0.75rem; }
    button:hover { background: #333; }
    button.danger { border-color: #7f1d1d; color: #fca5a5; }
    button.danger:hover { background: #7f1d1d; }
    button.primary { background: #ea580c; border-color: #ea580c; color: white; }
    button.primary:hover { background: #c2410c; }
    .form { display: flex; gap: 8px; margin-bottom: 16px; }
    input { background: #1a1a1a; border: 1px solid #333; color: #e5e5e5; padding: 6px 10px; border-radius: 6px; font-size: 0.8125rem; flex: 1; }
    input::placeholder { color: #525252; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 9999px; font-size: 0.6875rem; font-weight: 600; }
    .badge-insert { background: #052e16; color: #4ade80; }
    .badge-update { background: #1e1b4b; color: #a78bfa; }
    .badge-delete { background: #450a0a; color: #fca5a5; }
    .badge-custom { background: #422006; color: #fdba74; }
    .meta { color: #525252; font-size: 0.75rem; }
    .changes { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.6875rem; color: #a3a3a3; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .user-select { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; font-size: 0.8125rem; }
    .user-select select { background: #1a1a1a; border: 1px solid #333; color: #e5e5e5; padding: 4px 8px; border-radius: 6px; }
    .empty { color: #525252; text-align: center; padding: 24px; }
    .count { background: #262626; padding: 2px 8px; border-radius: 9999px; font-size: 0.75rem; margin-left: 8px; }
    .tag { font-size: 0.6875rem; padding: 1px 6px; border-radius: 4px; margin-left: 6px; }
    .tag-mysql { background: #1e1b4b; color: #a78bfa; }
    .tag-sqlite { background: #422006; color: #fdba74; }
    .tag-express { background: #1a1a1a; color: #737373; }
  </style>
</head>
<body>
  <h1><span>drizzle-audit</span> — Express + MySQL + SQLite</h1>
  <p class="subtitle">
    App data in <span class="tag tag-mysql">MySQL</span> ·
    Audit log in <span class="tag tag-sqlite">SQLite (bun:sqlite)</span> ·
    Server: <span class="tag tag-express">Express</span>
  </p>

  <div class="user-select">
    <label>Acting as:</label>
    <select id="actor">
      <option value="anonymous">anonymous</option>
      <option value="admin_1" selected>admin_1</option>
      <option value="user_42">user_42</option>
    </select>
  </div>

  <div class="grid">
    <div class="panel">
      <h2>Users <span class="tag tag-mysql">MySQL</span></h2>
      <div class="form">
        <input id="name" placeholder="Name" />
        <input id="email" placeholder="Email" />
        <button class="primary" onclick="createUser()">Add User</button>
      </div>
      <table>
        <thead><tr><th>ID</th><th>Name</th><th>Email</th><th>Role</th><th></th></tr></thead>
        <tbody id="users-body"></tbody>
      </table>
    </div>

    <div class="panel">
      <h2>Audit Log <span class="tag tag-sqlite">SQLite</span> <span class="count" id="audit-count">0</span></h2>
      <table>
        <thead><tr><th>Action</th><th>Table</th><th>Row</th><th>User</th><th>Changes</th><th>Time</th></tr></thead>
        <tbody id="audit-body"></tbody>
      </table>
      <div class="empty" id="audit-empty">No audit entries yet.</div>
    </div>
  </div>

  <script>
    const headers = () => ({ 'Content-Type': 'application/json', 'X-User-Id': document.getElementById('actor').value });
    async function loadUsers() {
      const data = await (await fetch('/api/users')).json();
      document.getElementById('users-body').innerHTML = data.map(u =>
        '<tr><td>'+u.id+'</td><td>'+u.name+'</td><td>'+u.email+'</td><td>'+u.role+'</td>' +
        '<td class="actions">' +
        '<button onclick="viewEmail('+u.id+')">View Email</button>' +
        '<button onclick="promoteUser('+u.id+')">Make Admin</button>' +
        '<button class="danger" onclick="deleteUser('+u.id+')">Delete</button></td></tr>'
      ).join('');
    }
    async function loadAudit() {
      const data = await (await fetch('/api/audit')).json();
      document.getElementById('audit-count').textContent = data.length;
      document.getElementById('audit-empty').style.display = data.length ? 'none' : 'block';
      document.getElementById('audit-body').innerHTML = data.map(e => {
        const badge = ['INSERT','UPDATE','DELETE'].includes(e.action) ? 'badge-'+e.action.toLowerCase() : 'badge-custom';
        const changes = e.changes ? JSON.stringify(e.changes) : '—';
        const time = e.timestamp ? new Date(e.timestamp).toLocaleTimeString() : '—';
        return '<tr><td><span class="badge '+badge+'">'+e.action+'</span></td>' +
          '<td>'+(e.table_name||'—')+'</td><td>'+(e.row_id||'—')+'</td><td>'+(e.user_id||'—')+'</td>' +
          '<td class="changes" title="'+changes.replace(/"/g,'&quot;')+'">'+changes+'</td>' +
          '<td class="meta">'+time+'</td></tr>';
      }).join('');
    }
    async function createUser() {
      const name = document.getElementById('name').value, email = document.getElementById('email').value;
      if (!name || !email) return alert('Name and email required');
      await fetch('/api/users', { method: 'POST', headers: headers(), body: JSON.stringify({ name, email }) });
      document.getElementById('name').value = ''; document.getElementById('email').value = '';
      refresh();
    }
    async function deleteUser(id) { await fetch('/api/users/'+id, { method: 'DELETE', headers: headers() }); refresh(); }
    async function promoteUser(id) { await fetch('/api/users/'+id, { method: 'PATCH', headers: headers(), body: JSON.stringify({ role: 'admin' }) }); refresh(); }
    async function viewEmail(id) { const d = await (await fetch('/api/users/'+id+'/email', { headers: headers() })).json(); alert('Email: '+d.email); refresh(); }
    function refresh() { loadUsers(); setTimeout(loadAudit, 150); }
    loadUsers(); loadAudit();
  </script>
</body>
</html>`;
