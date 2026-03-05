import express from "express";
import pool from "../db.js";
import { auth } from "../middleware/auth.js";

const router = express.Router();
router.use(auth);

/**
 * GET /clinics
 * List all clinics for the current client
 */
router.get("/", async (req, res) => {
  try {
    const { client_id } = req.user;
    const query = client_id
      ? `SELECT * FROM clinics WHERE client_id=$1 ORDER BY id`
      : `SELECT * FROM clinics ORDER BY id`;
    const params = client_id ? [client_id] : [];
    const { rows } = await pool.query(query, params);

    const clinics = rows.map((row) => ({
      id: String(row.id),
      name: row.name,
      type: row.type || "General",
      category: row.category || "clinic",
      active: row.active !== false,
      clientId: row.client_id,
      createdAt: row.created_at
        ? new Date(row.created_at).getTime()
        : Date.now(),
      createdBy: row.created_by || "system",
      updatedAt: row.updated_at
        ? new Date(row.updated_at).getTime()
        : Date.now(),
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
 * Create a new clinic/department
 * Admin only
 */
router.post("/", async (req, res) => {
  try {
    const { role, client_id } = req.user;
    if (!["admin", "super_admin"].includes(role)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const { name, type, category, active } = req.body;
    if (!name) {
      return res.status(400).json({ error: "name required" });
    }

    const { rows } = await pool.query(
      `INSERT INTO clinics (name, type, category, active, client_id, created_at, updated_at, created_by, updated_by, is_archived)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW(), 'system', 'system', false)
       RETURNING *`,
      [name, type || "General", category || "clinic", active !== false, client_id]
    );

    res.status(201).json({
      id: String(rows[0].id),
      name: rows[0].name,
      type: rows[0].type,
      category: rows[0].category,
      active: rows[0].active,
      clientId: rows[0].client_id,
    });
  } catch (err) {
    console.error("POST /clinics error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * PUT /clinics/:id
 * Update clinic fields
 * Admin only
 */
router.put("/:id", async (req, res) => {
  try {
    const { role, client_id } = req.user;
    if (!["admin", "super_admin"].includes(role)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const clinicId = parseInt(req.params.id);
    const { name, type, category, active } = req.body;

    const sets = ["updated_at=NOW()"];
    const params = [];
    let idx = 1;

    if (name !== undefined) {
      sets.push(`name=$${idx++}`);
      params.push(name);
    }
    if (type !== undefined) {
      sets.push(`type=$${idx++}`);
      params.push(type);
    }
    if (category !== undefined) {
      sets.push(`category=$${idx++}`);
      params.push(category);
    }
    if (active !== undefined) {
      sets.push(`active=$${idx++}`);
      params.push(active);
    }

    params.push(clinicId);
    let whereClause = `id=$${idx++}`;
    if (client_id) {
      params.push(client_id);
      whereClause += ` AND client_id=$${idx++}`;
    }

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
 * Toggle clinic active status
 * Admin only
 */
router.put("/:id/status", async (req, res) => {
  try {
    const { role, client_id } = req.user;
    if (!["admin", "super_admin"].includes(role)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const clinicId = parseInt(req.params.id);
    const { active } = req.body;

    const query = client_id
      ? "UPDATE clinics SET active=$1, updated_at=NOW() WHERE id=$2 AND client_id=$3"
      : "UPDATE clinics SET active=$1, updated_at=NOW() WHERE id=$2";
    const params = client_id
      ? [active, clinicId, client_id]
      : [active, clinicId];

    await pool.query(query, params);
    res.json({ success: true });
  } catch (err) {
    console.error("PUT /clinics/:id/status error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * DELETE /clinics/:id
 * Delete a clinic
 * Admin only
 */
router.delete("/:id", async (req, res) => {
  try {
    const { role, client_id } = req.user;
    if (!["admin", "super_admin"].includes(role)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const clinicId = parseInt(req.params.id);
    const query = client_id
      ? "DELETE FROM clinics WHERE id=$1 AND client_id=$2"
      : "DELETE FROM clinics WHERE id=$1";
    const params = client_id ? [clinicId, client_id] : [clinicId];

    await pool.query(query, params);
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /clinics/:id error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
