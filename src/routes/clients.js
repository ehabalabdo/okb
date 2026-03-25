import express from "express";
import bcrypt from "bcrypt";
import pool from "../db.js";
import { auth } from "../middleware/auth.js";

const router = express.Router();

/**
 * All client routes require super_admin auth (except getBySlug which is public for tenant resolution)
 */

/**
 * GET /clients/by-slug/:slug
 * Public — used by frontend to resolve tenant from URL
 */
router.get("/by-slug/:slug", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, name, slug, phone, email, address, logo_url, is_active, status FROM clients WHERE slug=$1 LIMIT 1",
      [req.params.slug]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Client not found" });
    }
    res.json(mapClientRow(rows[0]));
  } catch (err) {
    console.error("GET /clients/by-slug error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// All routes below require super_admin auth
router.use(auth);

function requireSuperAdmin(req, res, next) {
  if (req.user.type !== "super_admin" && req.user.role !== "super_admin") {
    return res.status(403).json({ error: "Super admin access required" });
  }
  next();
}

/**
 * GET /clients
 * List all clients (super_admin only)
 */
router.get("/", requireSuperAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM clients ORDER BY created_at DESC"
    );
    res.json(rows.map(mapClientRow));
  } catch (err) {
    console.error("GET /clients error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * GET /clients/:id
 * Get a single client by ID (super_admin only)
 */
router.get("/:id", requireSuperAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM clients WHERE id=$1 LIMIT 1",
      [parseInt(req.params.id)]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Client not found" });
    }
    res.json(mapClientRow(rows[0]));
  } catch (err) {
    console.error("GET /clients/:id error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /clients
 * Create a new client (super_admin only)
 */
router.post("/", requireSuperAdmin, async (req, res) => {
  try {
    const { name, slug, phone, email, address, trialDays } = req.body;
    if (!name || !slug) {
      return res.status(400).json({ error: "name and slug required" });
    }

    const days = trialDays || 30;
    const { rows } = await pool.query(
      `INSERT INTO clients (name, slug, phone, email, address, status, trial_ends_at, created_at, updated_at, is_active)
       VALUES ($1, $2, $3, $4, $5, 'trial', NOW() + ($6 || ' days')::interval, NOW(), NOW(), true)
       RETURNING *`,
      [name, slug, phone || "", email || "", address || "", String(days)]
    );

    res.status(201).json(mapClientRow(rows[0]));
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "Slug already exists" });
    }
    console.error("POST /clients error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /clients/:id/owner
 * Create the admin user for a client (super_admin only)
 */
router.post("/:id/owner", requireSuperAdmin, async (req, res) => {
  try {
    const clientId = parseInt(req.params.id);
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res
        .status(400)
        .json({ error: "name, email, and password required" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const uid = 'admin_' + Date.now();
    const now = Date.now();
    const { rows } = await pool.query(
      `INSERT INTO users (uid, name, email, password, role, client_id, created_at, updated_at, created_by, updated_by, is_active, is_archived)
       VALUES ($1, $2, $3, $4, 'admin', $5, $6, $7, 'super_admin', 'super_admin', true, false)
       RETURNING uid`,
      [uid, name, email, hashedPassword, clientId, now, now]
    );

    const userId = rows[0].uid;
    await pool.query("UPDATE clients SET owner_user_id=$1 WHERE id=$2", [
      userId,
      clientId,
    ]);

    res.status(201).json({ userId });
  } catch (err) {
    console.error("POST /clients/:id/owner error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * PUT /clients/:id/extend-trial
 * Extend trial period by N days (super_admin only)
 */
router.put("/:id/extend-trial", requireSuperAdmin, async (req, res) => {
  try {
    const clientId = parseInt(req.params.id);
    const { days } = req.body;
    if (!days || days <= 0) {
      return res.status(400).json({ error: "days required (positive number)" });
    }

    await pool.query(
      `UPDATE clients
       SET trial_ends_at = COALESCE(
             CASE WHEN trial_ends_at > NOW() THEN trial_ends_at ELSE NOW() END,
             NOW()
           ) + ($1 || ' days')::interval,
           updated_at = NOW()
       WHERE id = $2`,
      [String(days), clientId]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("PUT extend-trial error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * PUT /clients/:id/trial-end-date
 * Set trial end date directly (super_admin only)
 */
router.put("/:id/trial-end-date", requireSuperAdmin, async (req, res) => {
  try {
    const clientId = parseInt(req.params.id);
    const { endDate } = req.body;
    if (!endDate) {
      return res.status(400).json({ error: "endDate required" });
    }

    await pool.query(
      `UPDATE clients SET trial_ends_at=$1::timestamptz, updated_at=NOW() WHERE id=$2`,
      [endDate, clientId]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("PUT trial-end-date error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * PUT /clients/:id/extend-subscription
 * Activate/extend subscription by N days (super_admin only)
 */
router.put(
  "/:id/extend-subscription",
  requireSuperAdmin,
  async (req, res) => {
    try {
      const clientId = parseInt(req.params.id);
      const { days } = req.body;
      if (!days || days <= 0) {
        return res
          .status(400)
          .json({ error: "days required (positive number)" });
      }

      await pool.query(
        `UPDATE clients
       SET status = 'active',
           subscription_ends_at = COALESCE(
             CASE WHEN subscription_ends_at > NOW() THEN subscription_ends_at ELSE NOW() END,
             NOW()
           ) + ($1 || ' days')::interval,
           updated_at = NOW()
       WHERE id = $2`,
        [String(days), clientId]
      );

      res.json({ success: true });
    } catch (err) {
      console.error("PUT extend-subscription error:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
);

/**
 * PUT /clients/:id/suspend
 * Suspend a client (super_admin only)
 */
router.put("/:id/suspend", requireSuperAdmin, async (req, res) => {
  try {
    const clientId = parseInt(req.params.id);
    await pool.query(
      "UPDATE clients SET status='suspended', updated_at=NOW() WHERE id=$1",
      [clientId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("PUT suspend error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * PUT /clients/:id/activate
 * Reactivate a client (super_admin only)
 */
router.put("/:id/activate", requireSuperAdmin, async (req, res) => {
  try {
    const clientId = parseInt(req.params.id);
    await pool.query(
      "UPDATE clients SET status='active', updated_at=NOW() WHERE id=$1",
      [clientId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("PUT activate error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * PUT /clients/:id/features
 * Update enabled features (super_admin only)
 */
router.put("/:id/features", requireSuperAdmin, async (req, res) => {
  try {
    const clientId = parseInt(req.params.id);
    const { features } = req.body;
    if (!features) {
      return res.status(400).json({ error: "features object required" });
    }

    await pool.query(
      "UPDATE clients SET enabled_features=$1::jsonb, updated_at=NOW() WHERE id=$2",
      [JSON.stringify(features), clientId]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("PUT features error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * PATCH /clients/:id
 * Update client info (super_admin only)
 */
router.patch("/:id", requireSuperAdmin, async (req, res) => {
  try {
    const clientId = parseInt(req.params.id);
    const { name, phone, email, address, logoUrl } = req.body;

    const sets = ["updated_at=NOW()"];
    const params = [];
    let idx = 1;

    if (name !== undefined) {
      sets.push(`name=$${idx++}`);
      params.push(name);
    }
    if (phone !== undefined) {
      sets.push(`phone=$${idx++}`);
      params.push(phone);
    }
    if (email !== undefined) {
      sets.push(`email=$${idx++}`);
      params.push(email);
    }
    if (address !== undefined) {
      sets.push(`address=$${idx++}`);
      params.push(address);
    }
    if (logoUrl !== undefined) {
      sets.push(`logo_url=$${idx++}`);
      params.push(logoUrl);
    }

    params.push(clientId);
    await pool.query(
      `UPDATE clients SET ${sets.join(", ")} WHERE id=$${idx}`,
      params
    );

    res.json({ success: true });
  } catch (err) {
    console.error("PATCH /clients/:id error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * GET /clients/:id/stats
 * Get stats for a client (super_admin only)
 */
router.get("/:id/stats", requireSuperAdmin, async (req, res) => {
  try {
    const clientId = parseInt(req.params.id);

    const [patients, users, appointments] = await Promise.all([
      pool.query(
        "SELECT COUNT(*)::int as count FROM patients WHERE client_id=$1",
        [clientId]
      ),
      pool.query(
        "SELECT COUNT(*)::int as count FROM users WHERE client_id=$1",
        [clientId]
      ),
      pool.query(
        "SELECT COUNT(*)::int as count FROM appointments WHERE client_id=$1",
        [clientId]
      ),
    ]);

    res.json({
      patientsCount: patients.rows[0]?.count || 0,
      usersCount: users.rows[0]?.count || 0,
      appointmentsCount: appointments.rows[0]?.count || 0,
    });
  } catch (err) {
    console.error("GET /clients/:id/stats error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * DELETE /clients/:id
 * Delete a client and all related data (super_admin only)
 */
router.delete("/:id", requireSuperAdmin, async (req, res) => {
  const client = pool.connect ? await pool.connect() : null;
  try {
    const clientId = parseInt(req.params.id);

    // Delete in dependency order (HR tables first, then core tables)
    if (client) {
      await client.query("BEGIN");
      // HR module tables (dependency order: children first)
      await client.query("DELETE FROM hr_webauthn_challenges WHERE employee_id IN (SELECT id FROM hr_employees WHERE client_id=$1)", [clientId]);
      await client.query("DELETE FROM hr_biometric_credentials WHERE employee_id IN (SELECT id FROM hr_employees WHERE client_id=$1)", [clientId]);
      await client.query("DELETE FROM hr_payslips WHERE client_id=$1", [clientId]);
      await client.query("DELETE FROM hr_payroll_runs WHERE client_id=$1", [clientId]);
      await client.query("DELETE FROM hr_attendance_events WHERE client_id=$1", [clientId]);
      await client.query("DELETE FROM hr_attendance WHERE client_id=$1", [clientId]);
      await client.query("DELETE FROM hr_deductions WHERE client_id=$1", [clientId]);
      await client.query("DELETE FROM hr_warnings WHERE client_id=$1", [clientId]);
      await client.query("DELETE FROM hr_notifications WHERE client_id=$1", [clientId]);
      await client.query("DELETE FROM hr_work_schedules WHERE client_id=$1", [clientId]);
      await client.query("DELETE FROM hr_social_security_settings WHERE client_id=$1", [clientId]);
      await client.query("DELETE FROM hr_employees WHERE client_id=$1", [clientId]);
      // ENT forms
      await client.query("DELETE FROM ent_audiograms WHERE client_id=$1", [clientId]);
      await client.query("DELETE FROM ent_balance_assessments WHERE client_id=$1", [clientId]);
      await client.query("DELETE FROM ent_follow_up_forms WHERE client_id=$1", [clientId]);
      await client.query("DELETE FROM ent_new_patient_forms WHERE client_id=$1", [clientId]);
      await client.query("DELETE FROM ent_referrals WHERE client_id=$1", [clientId]);
      // Courses
      await client.query("DELETE FROM course_students WHERE course_id IN (SELECT id FROM courses WHERE client_id=$1)", [clientId]);
      await client.query("DELETE FROM course_sessions WHERE course_id IN (SELECT id FROM courses WHERE client_id=$1)", [clientId]);
      await client.query("DELETE FROM courses WHERE client_id=$1", [clientId]);
      // Invoices & payments
      await client.query("DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE client_id=$1)", [clientId]);
      await client.query("DELETE FROM invoice_audit_log WHERE invoice_id IN (SELECT id FROM invoices WHERE client_id=$1)", [clientId]);
      await client.query("DELETE FROM invoices WHERE client_id=$1", [clientId]);
      // Devices
      await client.query("DELETE FROM device_results WHERE client_id=$1", [clientId]);
      await client.query("DELETE FROM devices WHERE client_id=$1", [clientId]);
      // Lab & implants
      await client.query("DELETE FROM lab_cases WHERE client_id=$1", [clientId]);
      await client.query("DELETE FROM implant_orders WHERE client_id=$1", [clientId]);
      await client.query("DELETE FROM implant_inventory WHERE client_id=$1", [clientId]);
      // Catalog
      await client.query("DELETE FROM clinic_services WHERE client_id=$1", [clientId]);
      await client.query("DELETE FROM clinic_medications WHERE client_id=$1", [clientId]);
      // Core tables
      await client.query("DELETE FROM notifications WHERE client_id=$1", [clientId]);
      await client.query("DELETE FROM appointments WHERE client_id=$1", [clientId]);
      await client.query("DELETE FROM patients WHERE client_id=$1", [clientId]);
      await client.query("DELETE FROM users WHERE client_id=$1", [clientId]);
      await client.query("DELETE FROM clinics WHERE client_id=$1", [clientId]);
      await client.query("DELETE FROM system_settings WHERE client_id=$1", [clientId]);
      await client.query("DELETE FROM clients WHERE id=$1", [clientId]);
      await client.query("COMMIT");
    } else {
      // Fallback: sequential deletes without transaction
      const tables = [
        "hr_webauthn_challenges", "hr_biometric_credentials",
        "hr_payslips", "hr_payroll_runs", "hr_attendance_events",
        "hr_attendance", "hr_deductions", "hr_warnings", "hr_notifications",
        "hr_work_schedules", "hr_social_security_settings", "hr_employees",
        "ent_audiograms", "ent_balance_assessments", "ent_follow_up_forms",
        "ent_new_patient_forms", "ent_referrals",
        "course_students", "course_sessions", "courses",
        "invoice_payments", "invoice_audit_log", "invoices",
        "device_results", "devices",
        "lab_cases", "implant_orders", "implant_inventory",
        "clinic_services", "clinic_medications",
        "notifications", "appointments", "patients", "users", "clinics",
        "system_settings",
      ];
      for (const table of tables) {
        try {
          await pool.query(`DELETE FROM ${table} WHERE client_id=$1`, [clientId]);
        } catch (e) {
          // Table may not exist or column not applicable, skip
        }
      }
      await pool.query("DELETE FROM clients WHERE id=$1", [clientId]);
    }

    res.json({ success: true });
  } catch (err) {
    if (client) {
      try { await client.query("ROLLBACK"); } catch {}
    }
    console.error("DELETE /clients/:id error:", err);
    res.status(500).json({ error: "Server error" });
  } finally {
    if (client) client.release();
  }
});

/** Map a DB row to frontend-compatible Client shape */
function mapClientRow(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    logoUrl: row.logo_url || "",
    phone: row.phone || "",
    email: row.email || "",
    address: row.address || "",
    status: row.status,
    trialEndsAt: row.trial_ends_at,
    subscriptionEndsAt: row.subscription_ends_at,
    ownerUserId: row.owner_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isActive: row.is_active,
    enabledFeatures: row.enabled_features || {
      dental_lab: false,
      implant_company: false,
      academy: false,
      device_results: false,
    },
  };
}

export default router;
