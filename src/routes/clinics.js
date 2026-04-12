import express from "express";
import pool from "../db.js";
import { auth } from "../middleware/auth.js";

const router = express.Router();
router.use(auth);

/**
 * GET /clinics
 * List all clinics
 */
router.get("/", async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM clinics ORDER BY id`);

    const clinics = rows.map((row) => ({
      id: String(row.id),
      name: row.name,
      type: row.type || "General",
      category: row.category || "clinic",
      active: row.active !== false,
      createdAt: row.created_at ? Number(row.created_at) : Date.now(),
      createdBy: row.created_by || "system",
      updatedAt: row.updated_at ? Number(row.updated_at) : Date.now(),
      updatedBy: row.updated_by || "system",
      isArchived: row.is_archived || false,
    }));

    res.json(clinics);
  } catch (err) {
    console.error("GET /clinics error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /clinics
 * Create a new clinic/department (Admin only)
 */
router.post("/", async (req, res) => {
  try {
    const { role } = req.user;
    if (role !== "admin") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const { name, type, category, active } = req.body;
    if (!name) {
      return res.status(400).json({ error: "name required" });
    }

    const now = Date.now();
    const { rows } = await pool.query(
      `INSERT INTO clinics (id, name, type, category, active, created_at, updated_at, created_by, updated_by, is_archived)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'system', 'system', false)
       RETURNING *`,
      [name.toLowerCase().replace(/\s+/g, '_') + '_' + Date.now(), name, type || "General", category || "clinic", active !== false, now, now]
    );

    res.status(201).json({
      id: String(rows[0].id),
      name: rows[0].name,
      type: rows[0].type,
      category: rows[0].category,
      active: rows[0].active,
    });
  } catch (err) {
    console.error("POST /clinics error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * PUT /clinics/:id
 * Update clinic fields (Admin only)
 */
router.put("/:id", async (req, res) => {
  try {
    const { role } = req.user;
    if (role !== "admin") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const { name, type, category, active } = req.body;

    const sets = [`updated_at=${Date.now()}`];
    const params = [];
    let idx = 1;

    if (name !== undefined) { sets.push(`name=$${idx++}`); params.push(name); }
    if (type !== undefined) { sets.push(`type=$${idx++}`); params.push(type); }
    if (category !== undefined) { sets.push(`category=$${idx++}`); params.push(category); }
    if (active !== undefined) { sets.push(`active=$${idx++}`); params.push(active); }

    params.push(req.params.id);
    const whereClause = `id=$${idx++}`;

    await pool.query(
      `UPDATE clinics SET ${sets.join(", ")} WHERE ${whereClause}`,
      params
    );

    res.json({ success: true });
  } catch (err) {
    console.error("PUT /clinics/:id error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * PUT /clinics/:id/status
 * Toggle clinic active status (Admin only)
 */
router.put("/:id/status", async (req, res) => {
  try {
    const { role } = req.user;
    if (role !== "admin") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const { active } = req.body;
    await pool.query(
      `UPDATE clinics SET active=$1, updated_at=${Date.now()} WHERE id=$2`,
      [active, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("PUT /clinics/:id/status error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * DELETE /clinics/:id
 * Delete a clinic (Admin only)
 */
router.delete("/:id", async (req, res) => {
  try {
    const { role } = req.user;
    if (role !== "admin") {
      return res.status(403).json({ error: "Forbidden" });
    }

    await pool.query("DELETE FROM clinics WHERE id=$1", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /clinics/:id error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
