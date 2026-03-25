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
      ? `SELECT uid, name, email, role, clinic_ids, client_id, is_active, is_archived,
                created_at, created_by, updated_at, updated_by
         FROM users WHERE client_id=$1 ORDER BY uid`
      : `SELECT uid, name, email, role, clinic_ids, client_id, is_active, is_archived,
                created_at, created_by, updated_at, updated_by
         FROM users ORDER BY uid`;

    const params = client_id ? [client_id] : [];
    const { rows } = await pool.query(query, params);

    const users = rows.map((row) => {
      let clinicIds = Array.isArray(row.clinic_ids) ? row.clinic_ids : [];
      return {
        uid: String(row.uid),
        email: row.email,
        name: row.name,
        role: row.role,
        clinicIds,
        clientId: row.client_id,
        isActive: row.is_active !== false,
        createdAt: row.created_at
          ? Number(row.created_at)
          : Date.now(),
        createdBy: row.created_by || "system",
        updatedAt: row.updated_at
          ? Number(row.updated_at)
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

    const { name, full_name, email, password, role, clinic_ids, is_active } =
      req.body;

    const userName = name || full_name;
    if (!userName || !role) {
      return res.status(400).json({ error: "name and role required" });
    }

    const plainPassword = password || makePassword();
    const hashedPassword = await bcrypt.hash(plainPassword, 10);
    const clinicIdsArr = clinic_ids || [];
    const uid = role + '_' + Date.now();
    const now = Date.now();

    const { rows } = await pool.query(
      `INSERT INTO users (uid, name, email, password, role, clinic_ids, client_id,
                          created_at, updated_at, created_by, updated_by, is_active, is_archived)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'system', 'system', $10, false)
       RETURNING uid, name, email, role`,
      [
        uid,
        userName,
        email || null,
        hashedPassword,
        role,
        clinicIdsArr,
        client_id,
        now,
        now,
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

    const { full_name, name: bodyName, email } = req.body;
    const doctorName = bodyName || full_name;
    if (!doctorName) {
      return res.status(400).json({ error: "name required" });
    }

    const password = makePassword();
    const hashedPassword = await bcrypt.hash(password, 10);
    const uid = 'doctor_' + Date.now();
    const now = Date.now();

    const { rows } = await pool.query(
      `INSERT INTO users (uid, name, email, role, password, client_id,
                          created_at, updated_at, created_by, updated_by, is_active, is_archived, clinic_ids)
       VALUES ($1, $2, $3, 'doctor', $4, $5, $6, $7, 'system', 'system', true, false, $8)
       RETURNING uid, name, email`,
      [uid, doctorName, email || null, hashedPassword, client_id, now, now, []]
    );
    return res.status(201).json({
      doctor: rows[0],
      credentials: { email: email, password },
    });
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

    const userId = req.params.id;
    const { name, full_name, email, password, role, clinic_ids, is_active } =
      req.body;

    // Build SET clauses dynamically
    const now = Date.now();
    const sets = [`updated_at=${now}`];
    const params = [];
    let idx = 1;

    const userName = name || full_name;
    if (userName !== undefined) {
      sets.push(`name=$${idx++}`);
      params.push(userName);
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
      sets.push(`clinic_ids=$${idx++}`);
      params.push(Array.isArray(clinic_ids) ? clinic_ids : []);
    }
    if (is_active !== undefined) {
      sets.push(`is_active=$${idx++}`);
      params.push(is_active);
    }

    // Add WHERE clause params
    params.push(userId);
    const whereId = `uid=$${idx++}`;

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

    const userId = req.params.id;
    const query = client_id
      ? "DELETE FROM users WHERE uid=$1 AND client_id=$2"
      : "DELETE FROM users WHERE uid=$1";
    const params = client_id ? [userId, client_id] : [userId];

    await pool.query(query, params);
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /users/:id error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
