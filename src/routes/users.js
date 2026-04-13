import { Hono } from "hono";
import crypto from "crypto";
import { authMiddleware } from "../middleware/auth.js";
import { hashPassword } from "../utils/password.js";

const app = new Hono();
app.use("*", authMiddleware);

function makePassword() {
  return crypto.randomBytes(6).toString("base64url");
}

app.get("/", async (c) => {
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT uid, name, email, role, clinic_ids, is_active, is_archived,
              created_at, created_by, updated_at, updated_by
       FROM users ORDER BY uid`
    ).all();

    const users = results.map((row) => {
      let clinicIds = [];
      try { clinicIds = typeof row.clinic_ids === "string" ? JSON.parse(row.clinic_ids) : (row.clinic_ids || []); } catch { clinicIds = []; }
      return {
        uid: String(row.uid),
        email: row.email,
        name: row.name,
        role: row.role,
        clinicIds,
        isActive: row.is_active !== false && row.is_active !== 0,
        createdAt: row.created_at ? Number(row.created_at) : Date.now(),
        createdBy: row.created_by || "system",
        updatedAt: row.updated_at ? Number(row.updated_at) : Date.now(),
        updatedBy: row.updated_by || "system",
        isArchived: row.is_archived || false,
      };
    });

    return c.json(users);
  } catch (err) {
    console.error("GET /users error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.post("/", async (c) => {
  try {
    const user = c.get("user");
    if (user.role !== "admin") return c.json({ error: "Forbidden" }, 403);

    const { name, full_name, email, password, role, clinic_ids, is_active } = await c.req.json();
    const userName = name || full_name;
    if (!userName || !role) return c.json({ error: "name and role required" }, 400);

    const db = c.env.DB;
    const plainPassword = password || makePassword();
    const hashedPassword = await hashPassword(plainPassword);
    const clinicIdsJson = JSON.stringify(clinic_ids || []);
    const uid = role + "_" + Date.now();
    const now = Date.now();

    await db.prepare(
      `INSERT INTO users (uid, name, email, password, role, clinic_ids, created_at, updated_at, created_by, updated_by, is_active, is_archived)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'system', 'system', ?, 0)`
    ).bind(uid, userName, email || null, hashedPassword, role, clinicIdsJson, now, now, is_active !== false ? 1 : 0).run();

    return c.json({ user: { uid, name: userName, email, role }, credentials: { password: plainPassword } }, 201);
  } catch (err) {
    if (err.message?.includes("UNIQUE")) return c.json({ error: "User already exists" }, 409);
    console.error("POST /users error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.post("/doctors", async (c) => {
  try {
    const user = c.get("user");
    if (user.role !== "admin") return c.json({ error: "Forbidden" }, 403);

    const { full_name, name: bodyName, email } = await c.req.json();
    const doctorName = bodyName || full_name;
    if (!doctorName) return c.json({ error: "name required" }, 400);

    const db = c.env.DB;
    const password = makePassword();
    const hashedPassword = await hashPassword(password);
    const uid = "doctor_" + Date.now();
    const now = Date.now();

    await db.prepare(
      `INSERT INTO users (uid, name, email, role, password, created_at, updated_at, created_by, updated_by, is_active, is_archived, clinic_ids)
       VALUES (?, ?, ?, 'doctor', ?, ?, ?, 'system', 'system', 1, 0, '[]')`
    ).bind(uid, doctorName, email || null, hashedPassword, now, now).run();

    return c.json({ doctor: { uid, name: doctorName, email }, credentials: { email, password } }, 201);
  } catch (err) {
    console.error("POST /users/doctors error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.put("/:id", async (c) => {
  try {
    const user = c.get("user");
    if (user.role !== "admin") return c.json({ error: "Forbidden" }, 403);

    const userId = c.req.param("id");
    const body = await c.req.json();
    const db = c.env.DB;
    const now = Date.now();

    const sets = [`updated_at=${now}`];
    const params = [];

    const userName = body.name || body.full_name;
    if (userName !== undefined) { sets.push("name=?"); params.push(userName); }
    if (body.email !== undefined) { sets.push("email=?"); params.push(body.email); }
    if (body.password !== undefined && body.password !== "") {
      const hashed = await hashPassword(body.password);
      sets.push("password=?"); params.push(hashed);
    }
    if (body.role !== undefined) { sets.push("role=?"); params.push(body.role); }
    if (body.clinic_ids !== undefined) { sets.push("clinic_ids=?"); params.push(JSON.stringify(Array.isArray(body.clinic_ids) ? body.clinic_ids : [])); }
    if (body.is_active !== undefined) { sets.push("is_active=?"); params.push(body.is_active ? 1 : 0); }

    params.push(userId);
    await db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE uid=?`).bind(...params).run();

    return c.json({ success: true });
  } catch (err) {
    console.error("PUT /users/:id error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.delete("/:id", async (c) => {
  try {
    const user = c.get("user");
    if (user.role !== "admin") return c.json({ error: "Forbidden" }, 403);
    await c.env.DB.prepare("DELETE FROM users WHERE uid=?").bind(c.req.param("id")).run();
    return c.json({ success: true });
  } catch (err) {
    console.error("DELETE /users/:id error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

export default app;
