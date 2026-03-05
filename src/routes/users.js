import express from "express";
import bcrypt from "bcrypt";
import crypto from "crypto";
import pool from "../db.js";
import { auth } from "../middleware/auth.js";

const router = express.Router();
router.use(auth);

function makeDoctorUsername(name) {
  return "dr_" + name.toLowerCase().replace(/\s+/g, "");
}

function makePassword() {
  return crypto.randomBytes(6).toString("base64url");
}

/**
 * GET /users
 * List all users for the current client
 * All authenticated users can read (needed for doctor lists in appointments, etc.)
 */
router.get("/", async (req, res) => {
  try {
    const { role, client_id } = req.user;

    const query = client_id
      ? `SELECT id, full_name, email, role, clinic_id, clinic_ids, client_id, is_active, is_archived,
                created_at, created_by, updated_at, updated_by
         FROM users WHERE client_id=$1 ORDER BY id`
      : `SELECT id, full_name, email, role, clinic_id, clinic_ids, client_id, is_active, is_archived,
                created_at, created_by, updated_at, updated_by
         FROM users ORDER BY id`;

    const params = client_id ? [client_id] : [];
    const { rows } = await pool.query(query, params);

    const users = rows.map((row) => {
      let clinicIds = [];
      try {
        clinicIds =
          typeof row.clinic_ids === "string"
            ? JSON.parse(row.clinic_ids)
            : row.clinic_ids || [];
      } catch {
        clinicIds = [];
      }
      if (clinicIds.length === 0 && row.clinic_id) {
        clinicIds = [String(row.clinic_id)];
      }
      return {
        uid: String(row.id),
        email: row.email,
        name: row.full_name,
        role: row.role,
        clinicIds,
        clientId: row.client_id,
        isActive: row.is_active !== false,
        createdAt: row.created_at
          ? new Date(row.created_at).getTime()
          : Date.now(),
        createdBy: row.created_by || "system",
        updatedAt: row.updated_at
          ? new Date(row.updated_at).getTime()
          : Date.now(),
        updatedBy: row.updated_by || "system",
        isArchived: row.is_archived || false,
      };
    });

    res.json(users);
  } catch (err) {
    console.error("GET /users error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /users
 * Create any user (admin, doctor, receptionist, etc.)
 * Admin only
 */
router.post("/", async (req, res) => {
  try {
    const { role: callerRole, client_id } = req.user;
    if (!["admin", "super_admin"].includes(callerRole)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const { full_name, email, password, role, clinic_ids, is_active } =
      req.body;

    if (!full_name || !role) {
      return res.status(400).json({ error: "full_name and role required" });
    }

    const plainPassword = password || makePassword();
    const hashedPassword = await bcrypt.hash(plainPassword, 10);
    const clinicIdsJson = JSON.stringify(clinic_ids || []);
    const deptClinicId =
      clinic_ids && clinic_ids.length > 0 ? parseInt(clinic_ids[0]) : null;

    const { rows } = await pool.query(
      `INSERT INTO users (full_name, email, password, role, clinic_id, clinic_ids, client_id,
                          created_at, updated_at, created_by, updated_by, is_active, is_archived)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, NOW(), NOW(), 'system', 'system', $8, false)
       RETURNING id, full_name, email, role`,
      [
        full_name,
        email || null,
        hashedPassword,
        role,
        deptClinicId,
        clinicIdsJson,
        client_id,
        is_active !== false,
      ]
    );

    res.status(201).json({
      user: rows[0],
      credentials: { password: plainPassword },
    });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "User already exists" });
    }
    console.error("POST /users error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /users/doctors
 * Legacy endpoint: create doctor with auto-generated credentials
 */
router.post("/doctors", async (req, res) => {
  try {
    const { role: callerRole, client_id } = req.user;
    if (!["admin", "super_admin"].includes(callerRole)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const { full_name, email } = req.body;
    if (!full_name) {
      return res.status(400).json({ error: "full_name required" });
    }

    let username = makeDoctorUsername(full_name);
    const password = makePassword();
    const hashedPassword = await bcrypt.hash(password, 10);

    try {
      const { rows } = await pool.query(
        `INSERT INTO users (full_name, email, role, username, password, client_id,
                            created_at, updated_at, created_by, updated_by, is_active, is_archived)
         VALUES ($1, $2, 'doctor', $3, $4, $5, NOW(), NOW(), 'system', 'system', true, false)
         RETURNING id, full_name, username`,
        [full_name, email || null, username, hashedPassword, client_id]
      );
      return res.status(201).json({
        doctor: rows[0],
        credentials: { username, password },
      });
    } catch (err) {
      if (err.code === "23505") {
        username =
          username + "-" + Math.floor(1000 + Math.random() * 9000);
        const { rows } = await pool.query(
          `INSERT INTO users (full_name, email, role, username, password, client_id,
                              created_at, updated_at, created_by, updated_by, is_active, is_archived)
           VALUES ($1, $2, 'doctor', $3, $4, $5, NOW(), NOW(), 'system', 'system', true, false)
           RETURNING id, full_name, username`,
          [full_name, email || null, username, hashedPassword, client_id]
        );
        return res.status(201).json({
          doctor: rows[0],
          credentials: { username, password },
        });
      }
      throw err;
    }
  } catch (err) {
    console.error("POST /users/doctors error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * PUT /users/:id
 * Update user fields
 * Admin only
 */
router.put("/:id", async (req, res) => {
  try {
    const { role: callerRole, client_id } = req.user;
    if (!["admin", "super_admin"].includes(callerRole)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const userId = parseInt(req.params.id);
    const { full_name, email, password, role, clinic_ids, is_active } =
      req.body;

    // Build SET clauses dynamically
    const sets = ["updated_at=NOW()"];
    const params = [];
    let idx = 1;

    if (full_name !== undefined) {
      sets.push(`full_name=$${idx++}`);
      params.push(full_name);
    }
    if (email !== undefined) {
      sets.push(`email=$${idx++}`);
      params.push(email);
    }
    if (password !== undefined && password !== "") {
      const hashed = await bcrypt.hash(password, 10);
      sets.push(`password=$${idx++}`);
      params.push(hashed);
    }
    if (role !== undefined) {
      sets.push(`role=$${idx++}`);
      params.push(role);
    }
    if (clinic_ids !== undefined) {
      sets.push(`clinic_ids=$${idx++}::jsonb`);
      params.push(JSON.stringify(clinic_ids));
    }
    if (is_active !== undefined) {
      sets.push(`is_active=$${idx++}`);
      params.push(is_active);
    }

    // Add WHERE clause params
    params.push(userId);
    const whereId = `id=$${idx++}`;

    let whereClause = whereId;
    if (client_id) {
      params.push(client_id);
      whereClause += ` AND client_id=$${idx++}`;
    }

    await pool.query(
      `UPDATE users SET ${sets.join(", ")} WHERE ${whereClause}`,
      params
    );

    res.json({ success: true });
  } catch (err) {
    console.error("PUT /users/:id error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * DELETE /users/:id
 * Delete a user
 * Admin only
 */
router.delete("/:id", async (req, res) => {
  try {
    const { role: callerRole, client_id } = req.user;
    if (!["admin", "super_admin"].includes(callerRole)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const userId = parseInt(req.params.id);
    const query = client_id
      ? "DELETE FROM users WHERE id=$1 AND client_id=$2"
      : "DELETE FROM users WHERE id=$1";
    const params = client_id ? [userId, client_id] : [userId];

    await pool.query(query, params);
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /users/:id error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
