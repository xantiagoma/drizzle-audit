/**
 * drizzle-audit example — audit entries stored in MongoDB
 *
 * PostgreSQL (PGlite) for app data, MongoDB (mongoz) for audit log.
 * Uses Elysia as the web framework.
 *
 * Run: bun examples/mongo/server.ts
 * Open: http://localhost:3001
 */
import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import { drizzleAuditPlugin } from "../../src/middleware/elysia.ts";
import { drizzleAuditAction } from "../../src/audit-action.ts";
import { db, rawDb, auditCollection } from "./db.ts";
import { users } from "./schema.ts";

const app = new Elysia()
  .use(
    drizzleAuditPlugin({
      getContext: ({ headers }) => ({
        userId: headers["x-user-id"] ?? "anonymous",
        metadata: {
          ip: headers["x-forwarded-for"] ?? "127.0.0.1",
        },
      }),
    }),
  )

  // List users
  .get("/api/users", async () => {
    return rawDb.select().from(users);
  })

  // Create user
  .post("/api/users", async ({ body }) => {
    const [user] = await db
      .insert(users)
      .values(body as any)
      .returning();
    return user;
  })

  // Update user
  .patch("/api/users/:id", async ({ params, body }) => {
    const [user] = await db
      .update(users)
      .set(body as any)
      .where(eq(users.id, Number(params.id)))
      .returning();
    return user;
  })

  // Delete user
  .delete("/api/users/:id", async ({ params }) => {
    await db
      .delete(users)
      .where(eq(users.id, Number(params.id)))
      .returning();
    return { ok: true };
  })

  // View email (custom audit action)
  .get("/api/users/:id/email", async ({ params }) => {
    const [user] = await rawDb
      .select()
      .from(users)
      .where(eq(users.id, Number(params.id)));
    if (!user) return { error: "Not found" };

    await drizzleAuditAction({
      action: "VIEW_PII",
      tableName: "users",
      rowId: params.id,
      metadata: { field: "email" },
    });

    return { email: user.email };
  })

  // Audit log from MongoDB
  .get("/api/audit", async () => {
    return auditCollection.find().sort({ timestamp: -1 }).limit(50).toArray();
  })

  // MongoDB aggregation stats
  .get("/api/audit/stats", async () => {
    const total = await auditCollection.countDocuments();
    const byAction = await auditCollection
      .aggregate([{ $group: { _id: "$action", count: { $sum: 1 } } }, { $sort: { count: -1 } }])
      .toArray();
    return { total, byAction };
  })

  // HTML UI
  .get("/", () => new Response(HTML, { headers: { "content-type": "text/html" } }));

import { getPort } from "get-port-please";

const port = await getPort({ portRange: [3001, 3100] });

app.listen(port);

console.log(`\n  drizzle-audit mongo example (Elysia) at http://localhost:${port}\n`);

const HTML = /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>drizzle-audit — MongoDB + Elysia</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #0a0a0a; color: #e5e5e5; padding: 24px; }
    h1 { font-size: 1.5rem; margin-bottom: 4px; }
    h1 span { color: #22c55e; }
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
    button.primary { background: #16a34a; border-color: #16a34a; color: white; }
    button.primary:hover { background: #15803d; }
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
    .stats { display: flex; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
    .stat { background: #1a1a1a; border: 1px solid #262626; border-radius: 8px; padding: 10px 14px; min-width: 80px; }
    .stat-value { font-size: 1.25rem; font-weight: 700; color: #22c55e; }
    .stat-label { font-size: 0.6875rem; color: #737373; margin-top: 2px; }
    .tag { font-size: 0.6875rem; padding: 1px 6px; border-radius: 4px; margin-left: 6px; }
    .tag-pg { background: #1e1b4b; color: #a78bfa; }
    .tag-mongo { background: #052e16; color: #4ade80; }
  </style>
</head>
<body>
  <h1><span>drizzle-audit</span> — MongoDB Storage</h1>
  <p class="subtitle">
    App data in <span class="tag tag-pg">PostgreSQL</span> ·
    Audit log in <span class="tag tag-mongo">MongoDB</span> ·
    Server: <span class="tag tag-mongo">Elysia</span>
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
      <h2>Users <span class="tag tag-pg">PG</span></h2>
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
      <h2>Audit Log <span class="tag tag-mongo">MongoDB</span> <span class="count" id="audit-count">0</span></h2>
      <div class="stats" id="stats"></div>
      <table>
        <thead><tr><th>Action</th><th>Table</th><th>Row</th><th>User</th><th>Changes</th><th>Time</th></tr></thead>
        <tbody id="audit-body"></tbody>
      </table>
      <div class="empty" id="audit-empty">No audit entries yet.</div>
    </div>
  </div>

  <script>
    const headers = () => ({
      'Content-Type': 'application/json',
      'X-User-Id': document.getElementById('actor').value,
    });

    async function loadUsers() {
      const data = await (await fetch('/api/users')).json();
      document.getElementById('users-body').innerHTML = data.map(u =>
        '<tr><td>'+u.id+'</td><td>'+u.name+'</td><td>'+u.email+'</td><td>'+u.role+'</td>' +
        '<td class="actions">' +
        '<button onclick="viewEmail('+u.id+')">View Email</button>' +
        '<button onclick="promoteUser('+u.id+')">Make Admin</button>' +
        '<button class="danger" onclick="deleteUser('+u.id+')">Delete</button>' +
        '</td></tr>'
      ).join('');
    }

    async function loadAudit() {
      const [data, stats] = await Promise.all([
        (await fetch('/api/audit')).json(),
        (await fetch('/api/audit/stats')).json(),
      ]);
      document.getElementById('audit-count').textContent = stats.total;
      document.getElementById('audit-empty').style.display = data.length ? 'none' : 'block';
      document.getElementById('stats').innerHTML =
        '<div class="stat"><div class="stat-value">'+stats.total+'</div><div class="stat-label">Total</div></div>' +
        stats.byAction.map(a =>
          '<div class="stat"><div class="stat-value">'+a.count+'</div><div class="stat-label">'+a._id+'</div></div>'
        ).join('');
      document.getElementById('audit-body').innerHTML = data.map(e => {
        const badge = ['INSERT','UPDATE','DELETE'].includes(e.action) ? 'badge-'+e.action.toLowerCase() : 'badge-custom';
        const changes = e.changes ? JSON.stringify(e.changes) : '—';
        const time = new Date(e.timestamp).toLocaleTimeString();
        return '<tr><td><span class="badge '+badge+'">'+e.action+'</span></td>' +
          '<td>'+(e.tableName||'—')+'</td><td>'+(e.rowId||'—')+'</td><td>'+(e.userId||'—')+'</td>' +
          '<td class="changes" title="'+changes.replace(/"/g,'&quot;')+'">'+changes+'</td>' +
          '<td class="meta">'+time+'</td></tr>';
      }).join('');
    }

    async function createUser() {
      const name = document.getElementById('name').value;
      const email = document.getElementById('email').value;
      if (!name || !email) return alert('Name and email required');
      await fetch('/api/users', { method: 'POST', headers: headers(), body: JSON.stringify({ name, email }) });
      document.getElementById('name').value = '';
      document.getElementById('email').value = '';
      refresh();
    }
    async function deleteUser(id) { await fetch('/api/users/'+id, { method: 'DELETE', headers: headers() }); refresh(); }
    async function promoteUser(id) { await fetch('/api/users/'+id, { method: 'PATCH', headers: headers(), body: JSON.stringify({ role: 'admin' }) }); refresh(); }
    async function viewEmail(id) { const d = await (await fetch('/api/users/'+id+'/email', { headers: headers() })).json(); alert('Email: '+d.email); refresh(); }
    function refresh() { loadUsers(); setTimeout(loadAudit, 100); }
    loadUsers(); loadAudit();
  </script>
</body>
</html>`;
