/**
 * Interactive drizzle-audit example
 *
 * Run: bun examples/basic/server.ts
 * Open: http://localhost:3000
 */
import { Hono } from "hono";
import { eq, desc } from "drizzle-orm";
import { drizzleAuditMiddleware } from "../../src/middleware/hono.ts";
import { drizzleAuditAction } from "../../src/audit-action.ts";
import { db, rawDb } from "./db.ts";
import { users, auditLog } from "./schema.ts";

const app = new Hono();

// Audit middleware — sets context from request headers
app.use(
  "/api/*",
  drizzleAuditMiddleware((c) => ({
    userId: c.req.header("x-user-id") ?? "anonymous",
    metadata: {
      method: c.req.method,
      path: c.req.path,
      ip: c.req.header("x-forwarded-for") ?? "127.0.0.1",
    },
  })),
);

// --- API Routes ---

// List users
app.get("/api/users", async (c) => {
  const result = await rawDb.select().from(users);
  return c.json(result);
});

// Create user
app.post("/api/users", async (c) => {
  const body = await c.req.json();
  const [user] = await db.insert(users).values(body).returning();
  return c.json(user, 201);
});

// Update user
app.patch("/api/users/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json();
  const [user] = await db.update(users).set(body).where(eq(users.id, id)).returning();
  return c.json(user);
});

// Delete user
app.delete("/api/users/:id", async (c) => {
  const id = Number(c.req.param("id"));
  await db.delete(users).where(eq(users.id, id)).returning();
  return c.json({ ok: true });
});

// View user email (custom audit action — logs PII access)
app.get("/api/users/:id/email", async (c) => {
  const id = Number(c.req.param("id"));
  const [user] = await rawDb.select().from(users).where(eq(users.id, id));
  if (!user) return c.json({ error: "Not found" }, 404);

  await drizzleAuditAction({
    action: "VIEW_PII",
    tableName: "users",
    rowId: String(id),
    metadata: { field: "email" },
  });

  return c.json({ email: user.email });
});

// Get audit log
app.get("/api/audit", async (c) => {
  const result = await rawDb.select().from(auditLog).orderBy(desc(auditLog.timestamp)).limit(50);
  return c.json(result);
});

// --- HTML UI ---
app.get("/", (c) => {
  return c.html(HTML);
});

import { getPort } from "get-port-please";

const port = await getPort({ portRange: [3000, 3100] });
console.log(`\n  drizzle-audit example running at http://localhost:${port}\n`);

export default { port, fetch: app.fetch };

// --- Inline HTML ---
const HTML = /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>drizzle-audit — Interactive Example</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #0a0a0a; color: #e5e5e5; padding: 24px; }
    h1 { font-size: 1.5rem; margin-bottom: 4px; }
    h1 span { color: #6366f1; }
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
    button.primary { background: #4f46e5; border-color: #4f46e5; color: white; }
    button.primary:hover { background: #4338ca; }
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
    #audit-panel h2 { display: flex; align-items: center; }
  </style>
</head>
<body>
  <h1><span>drizzle-audit</span> — Interactive Example</h1>
  <p class="subtitle">Perform CRUD operations on users and watch the audit log populate in real-time.</p>

  <div class="user-select">
    <label>Acting as:</label>
    <select id="actor">
      <option value="anonymous">anonymous</option>
      <option value="admin_1" selected>admin_1</option>
      <option value="user_42">user_42</option>
      <option value="system">system</option>
    </select>
  </div>

  <div class="grid">
    <div class="panel">
      <h2>Users</h2>
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

    <div class="panel" id="audit-panel">
      <h2>Audit Log <span class="count" id="audit-count">0</span></h2>
      <table>
        <thead><tr><th>Action</th><th>Table</th><th>Row</th><th>User</th><th>Changes</th><th>Time</th></tr></thead>
        <tbody id="audit-body"></tbody>
      </table>
      <div class="empty" id="audit-empty">No audit entries yet. Perform an action to see entries appear.</div>
    </div>
  </div>

  <script>
    const headers = () => ({
      'Content-Type': 'application/json',
      'X-User-Id': document.getElementById('actor').value,
    });

    async function loadUsers() {
      const res = await fetch('/api/users');
      const data = await res.json();
      const tbody = document.getElementById('users-body');
      tbody.innerHTML = data.map(u => \`
        <tr>
          <td>\${u.id}</td>
          <td>\${u.name}</td>
          <td>\${u.email}</td>
          <td>\${u.role}</td>
          <td class="actions">
            <button onclick="viewEmail(\${u.id})">View Email</button>
            <button onclick="promoteUser(\${u.id})">Make Admin</button>
            <button class="danger" onclick="deleteUser(\${u.id})">Delete</button>
          </td>
        </tr>
      \`).join('');
    }

    async function loadAudit() {
      const res = await fetch('/api/audit');
      const data = await res.json();
      const tbody = document.getElementById('audit-body');
      const empty = document.getElementById('audit-empty');
      const count = document.getElementById('audit-count');
      count.textContent = data.length;
      empty.style.display = data.length ? 'none' : 'block';
      tbody.innerHTML = data.map(e => {
        const badge = ['INSERT','UPDATE','DELETE'].includes(e.action)
          ? \`badge-\${e.action.toLowerCase()}\`
          : 'badge-custom';
        const changes = e.changes ? JSON.stringify(e.changes) : '—';
        const time = new Date(e.timestamp).toLocaleTimeString();
        return \`
          <tr>
            <td><span class="badge \${badge}">\${e.action}</span></td>
            <td>\${e.tableName || '—'}</td>
            <td>\${e.rowId || '—'}</td>
            <td>\${e.userId || '—'}</td>
            <td class="changes" title='\${changes}'>\${changes}</td>
            <td class="meta">\${time}</td>
          </tr>
        \`;
      }).join('');
    }

    async function createUser() {
      const name = document.getElementById('name').value;
      const email = document.getElementById('email').value;
      if (!name || !email) return alert('Name and email required');
      await fetch('/api/users', {
        method: 'POST', headers: headers(),
        body: JSON.stringify({ name, email }),
      });
      document.getElementById('name').value = '';
      document.getElementById('email').value = '';
      refresh();
    }

    async function deleteUser(id) {
      await fetch(\`/api/users/\${id}\`, { method: 'DELETE', headers: headers() });
      refresh();
    }

    async function promoteUser(id) {
      await fetch(\`/api/users/\${id}\`, {
        method: 'PATCH', headers: headers(),
        body: JSON.stringify({ role: 'admin' }),
      });
      refresh();
    }

    async function viewEmail(id) {
      const res = await fetch(\`/api/users/\${id}/email\`, { headers: headers() });
      const data = await res.json();
      alert(\`Email: \${data.email}\`);
      refresh();
    }

    function refresh() {
      loadUsers();
      setTimeout(loadAudit, 100);
    }

    loadUsers();
    loadAudit();
  </script>
</body>
</html>`;
