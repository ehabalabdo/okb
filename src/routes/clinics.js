import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth.js";

const app = new Hono();
app.use("*", authMiddleware);

/**
 * GET /clinics
 * List all clinics
 */
app.get("/", async (c) => {
  try {
    const db = c.env.DB;
    const { results } = await db.prepare("SELECT * FROM clinics ORDER BY id").all();

    const clinics = results.map((row) => ({
      id: String(row.id),
      name: row.name,
      type: row.type || "General",
      category: row.category || "clinic",
      active: row.active !== false && row.active !== 0,
      createdAt: row.created_at ? Number(row.created_at) : Date.now(),
      createdBy: row.created_by || "system",
      updatedAt: row.updated_at ? Number(row.updated_at) : Date.now(),
      updatedBy: row.updated_by || "system",
      isArchived: row.is_archived || false,
    }));

    return c.json(clinics);
  } catch (err) {
    console.error("GET /clinics error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

/**
 * POST /clinics
 * Create a new clinic/department (Admin only)
 */
app.post("/", async (c) => {
  try {
    const user = c.get("user");
    if (user.role !== "admin") {
      return c.json({ error: "Forbidden" }, 403);
    }

    const { name, type, category, active } = await c.req.json();
    if (!name) {
      return c.json({ error: "name required" }, 400);
    }

    const db = c.env.DB;
    const now = Date.now();
    const id = name.toLowerCase().replace(/\s+/g, "_") + "_" + Date.now();

    const { results } = await db
      .prepare(
        `INSERT INTO clinics (id, name, type, category, active, created_at, updated_at, created_by, updated_by, is_archived)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'system', 'system', 0)
         RETURNING *`
      )
      .bind(id, name, type || "General", category || "clinic", active !== false ? 1 : 0, now, now)
      .all();

    const row = results[0];
    return c.json(
      {
        id: String(row.id),
        name: row.name,
        type: row.type,
        category: row.category,
        active: row.active !== 0,
      },
      201
    );
  } catch (err) {
    console.error("POST /clinics error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

/**
 * PUT /clinics/:id
 * Update clinic fields (Admin only)
 */
app.put("/:id", async (c) => {
  try {
    const user = c.get("user");
    if (user.role !== "admin") {
      return c.json({ error: "Forbidden" }, 403);
    }

    const { name, type, category, active } = await c.req.json();
    const db = c.env.DB;

    const sets = ["updated_at=?"];
    const params = [Date.now()];

    if (name !== undefined) { sets.push("name=?"); params.push(name); }
    if (type !== undefined) { sets.push("type=?"); params.push(type); }
    if (category !== undefined) { sets.push("category=?"); params.push(category); }
    if (active !== undefined) { sets.push("active=?"); params.push(active ? 1 : 0); }

    params.push(c.req.param("id"));
    await db.prepare(`UPDATE clinics SET ${sets.join(", ")} WHERE id=?`).bind(...params).run();

    return c.json({ success: true });
  } catch (err) {
    console.error("PUT /clinics/:id error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

/**
 * PUT /clinics/:id/status
 * Toggle clinic active status (Admin only)
 */
app.put("/:id/status", async (c) => {
  try {
    const user = c.get("user");
    if (user.role !== "admin") {
      return c.json({ error: "Forbidden" }, 403);
    }

    const { active } = await c.req.json();
    const db = c.env.DB;
    await db
      .prepare("UPDATE clinics SET active=?, updated_at=? WHERE id=?")
      .bind(active ? 1 : 0, Date.now(), c.req.param("id"))
      .run();

    return c.json({ success: true });
  } catch (err) {
    console.error("PUT /clinics/:id/status error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

/**
 * DELETE /clinics/:id
 * Delete a clinic (Admin only)
 */
app.delete("/:id", async (c) => {
  try {
    const user = c.get("user");
    if (user.role !== "admin") {
      return c.json({ error: "Forbidden" }, 403);
    }

    const db = c.env.DB;
    await db.prepare("DELETE FROM clinics WHERE id=?").bind(c.req.param("id")).run();
    return c.json({ success: true });
  } catch (err) {
    console.error("DELETE /clinics/:id error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

export default app;
