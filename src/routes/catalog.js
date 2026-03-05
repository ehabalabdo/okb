import express from "express";
import pool from "../db.js";
import { auth } from "../middleware/auth.js";

const router = express.Router();
router.use(auth);

// ===================== SERVICES =====================

/**
 * GET /catalog/services
 * List all services for the current client
 */
router.get("/services", async (req, res) => {
  try {
    const { client_id } = req.user;
    const { rows } = await pool.query(
      `SELECT * FROM clinic_services WHERE client_id=$1 ORDER BY category, service_name`,
      [client_id]
    );
    res.json(rows.map(mapService));
  } catch (err) {
    console.error("GET /catalog/services error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /catalog/services
 * Create a single service
 */
router.post("/services", async (req, res) => {
  try {
    const { role, client_id } = req.user;
    if (!["admin", "super_admin"].includes(role))
      return res.status(403).json({ error: "Forbidden" });

    const { serviceName, category, price, currency, active } = req.body;
    if (!serviceName) return res.status(400).json({ error: "serviceName required" });
    if (price == null || isNaN(Number(price)))
      return res.status(400).json({ error: "price required and must be numeric" });

    const { rows } = await pool.query(
      `INSERT INTO clinic_services (client_id, service_name, category, price, currency, active)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (client_id, service_name) DO UPDATE SET
         category=EXCLUDED.category, price=EXCLUDED.price, currency=EXCLUDED.currency,
         active=EXCLUDED.active, updated_at=NOW()
       RETURNING *`,
      [client_id, serviceName, category || "General", Number(price), currency || "JOD", active !== false]
    );
    res.status(201).json(mapService(rows[0]));
  } catch (err) {
    console.error("POST /catalog/services error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * PUT /catalog/services/:id
 */
router.put("/services/:id", async (req, res) => {
  try {
    const { role, client_id } = req.user;
    if (!["admin", "super_admin"].includes(role))
      return res.status(403).json({ error: "Forbidden" });

    const id = parseInt(req.params.id);
    const { serviceName, category, price, currency, active } = req.body;

    const sets = ["updated_at=NOW()"];
    const params = [];
    let idx = 1;

    if (serviceName !== undefined) { sets.push(`service_name=$${idx++}`); params.push(serviceName); }
    if (category !== undefined) { sets.push(`category=$${idx++}`); params.push(category); }
    if (price !== undefined) { sets.push(`price=$${idx++}`); params.push(Number(price)); }
    if (currency !== undefined) { sets.push(`currency=$${idx++}`); params.push(currency); }
    if (active !== undefined) { sets.push(`active=$${idx++}`); params.push(active); }

    params.push(id, client_id);
    const { rows } = await pool.query(
      `UPDATE clinic_services SET ${sets.join(",")} WHERE id=$${idx++} AND client_id=$${idx} RETURNING *`,
      params
    );
    if (rows.length === 0) return res.status(404).json({ error: "Not found" });
    res.json(mapService(rows[0]));
  } catch (err) {
    console.error("PUT /catalog/services error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * DELETE /catalog/services/:id
 */
router.delete("/services/:id", async (req, res) => {
  try {
    const { role, client_id } = req.user;
    if (!["admin", "super_admin"].includes(role))
      return res.status(403).json({ error: "Forbidden" });

    const id = parseInt(req.params.id);
    await pool.query(`DELETE FROM clinic_services WHERE id=$1 AND client_id=$2`, [id, client_id]);
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /catalog/services error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /catalog/services/import
 * Upload Excel, validate, upsert services
 * Expects JSON body: { rows: [ {serviceName, category, price, currency, active}, ... ] }
 */
router.post("/services/import", async (req, res) => {
  try {
    const { role, client_id } = req.user;
    if (!["admin", "super_admin"].includes(role))
      return res.status(403).json({ error: "Forbidden" });

    const { rows: importRows } = req.body;
    if (!Array.isArray(importRows) || importRows.length === 0)
      return res.status(400).json({ error: "No rows provided" });
    if (importRows.length > 5000)
      return res.status(400).json({ error: "Maximum 5000 rows allowed" });

    let created = 0, updated = 0, failed = 0;
    const errors = [];

    for (let i = 0; i < importRows.length; i++) {
      const row = importRows[i];
      const rowNum = i + 2; // +2 because row 1 is header, data starts at 2

      // Validate
      if (!row.serviceName || String(row.serviceName).trim() === "") {
        errors.push({ row: rowNum, message: "Missing serviceName" });
        failed++;
        continue;
      }
      if (row.price == null || row.price === "" || isNaN(Number(row.price))) {
        errors.push({ row: rowNum, message: "Missing or invalid price" });
        failed++;
        continue;
      }

      try {
        // Check if exists
        const existing = await pool.query(
          `SELECT id FROM clinic_services WHERE client_id=$1 AND service_name=$2`,
          [client_id, String(row.serviceName).trim()]
        );

        const active = row.active === false || String(row.active).toUpperCase() === "FALSE" ? false : true;

        if (existing.rows.length > 0) {
          await pool.query(
            `UPDATE clinic_services SET category=$1, price=$2, currency=$3, active=$4, updated_at=NOW()
             WHERE client_id=$5 AND service_name=$6`,
            [row.category || "General", Number(row.price), row.currency || "JOD", active, client_id, String(row.serviceName).trim()]
          );
          updated++;
        } else {
          await pool.query(
            `INSERT INTO clinic_services (client_id, service_name, category, price, currency, active)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [client_id, String(row.serviceName).trim(), row.category || "General", Number(row.price), row.currency || "JOD", active]
          );
          created++;
        }
      } catch (rowErr) {
        errors.push({ row: rowNum, message: rowErr.message });
        failed++;
      }
    }

    res.json({ created, updated, failed, errors });
  } catch (err) {
    console.error("POST /catalog/services/import error:", err);
    res.status(500).json({ error: "Server error" });
  }
});


// ===================== MEDICATIONS =====================

/**
 * GET /catalog/medications
 * List all medications for the current client
 */
router.get("/medications", async (req, res) => {
  try {
    const { client_id } = req.user;
    const { rows } = await pool.query(
      `SELECT * FROM clinic_medications WHERE client_id=$1 ORDER BY COALESCE(brand_name, generic_name)`,
      [client_id]
    );
    res.json(rows.map(mapMedication));
  } catch (err) {
    console.error("GET /catalog/medications error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /catalog/medications
 * Create a single medication
 */
router.post("/medications", async (req, res) => {
  try {
    const { role, client_id } = req.user;
    if (!["admin", "super_admin"].includes(role))
      return res.status(403).json({ error: "Forbidden" });

    const { brandName, genericName, strength, dosageForm, route, defaultDose, defaultFrequency, defaultDuration, notes, active } = req.body;
    if (!brandName && !genericName)
      return res.status(400).json({ error: "At least brandName or genericName required" });

    const { rows } = await pool.query(
      `INSERT INTO clinic_medications (client_id, brand_name, generic_name, strength, dosage_form, route, default_dose, default_frequency, default_duration, notes, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [client_id, brandName || null, genericName || null, strength || null, dosageForm || null,
       route || null, defaultDose || null, defaultFrequency || null, defaultDuration || null, notes || null, active !== false]
    );
    res.status(201).json(mapMedication(rows[0]));
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "Medication already exists with same name/strength/form" });
    }
    console.error("POST /catalog/medications error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * PUT /catalog/medications/:id
 */
router.put("/medications/:id", async (req, res) => {
  try {
    const { role, client_id } = req.user;
    if (!["admin", "super_admin"].includes(role))
      return res.status(403).json({ error: "Forbidden" });

    const id = parseInt(req.params.id);
    const { brandName, genericName, strength, dosageForm, route, defaultDose, defaultFrequency, defaultDuration, notes, active } = req.body;

    const sets = ["updated_at=NOW()"];
    const params = [];
    let idx = 1;

    if (brandName !== undefined) { sets.push(`brand_name=$${idx++}`); params.push(brandName || null); }
    if (genericName !== undefined) { sets.push(`generic_name=$${idx++}`); params.push(genericName || null); }
    if (strength !== undefined) { sets.push(`strength=$${idx++}`); params.push(strength || null); }
    if (dosageForm !== undefined) { sets.push(`dosage_form=$${idx++}`); params.push(dosageForm || null); }
    if (route !== undefined) { sets.push(`route=$${idx++}`); params.push(route || null); }
    if (defaultDose !== undefined) { sets.push(`default_dose=$${idx++}`); params.push(defaultDose || null); }
    if (defaultFrequency !== undefined) { sets.push(`default_frequency=$${idx++}`); params.push(defaultFrequency || null); }
    if (defaultDuration !== undefined) { sets.push(`default_duration=$${idx++}`); params.push(defaultDuration || null); }
    if (notes !== undefined) { sets.push(`notes=$${idx++}`); params.push(notes || null); }
    if (active !== undefined) { sets.push(`active=$${idx++}`); params.push(active); }

    params.push(id, client_id);
    const { rows } = await pool.query(
      `UPDATE clinic_medications SET ${sets.join(",")} WHERE id=$${idx++} AND client_id=$${idx} RETURNING *`,
      params
    );
    if (rows.length === 0) return res.status(404).json({ error: "Not found" });
    res.json(mapMedication(rows[0]));
  } catch (err) {
    console.error("PUT /catalog/medications error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * DELETE /catalog/medications/:id
 */
router.delete("/medications/:id", async (req, res) => {
  try {
    const { role, client_id } = req.user;
    if (!["admin", "super_admin"].includes(role))
      return res.status(403).json({ error: "Forbidden" });

    const id = parseInt(req.params.id);
    await pool.query(`DELETE FROM clinic_medications WHERE id=$1 AND client_id=$2`, [id, client_id]);
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /catalog/medications error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /catalog/medications/import
 * Upload Excel, validate, upsert medications
 * Expects JSON body: { rows: [ {brandName, genericName, strength, ...}, ... ] }
 */
router.post("/medications/import", async (req, res) => {
  try {
    const { role, client_id } = req.user;
    if (!["admin", "super_admin"].includes(role))
      return res.status(403).json({ error: "Forbidden" });

    const { rows: importRows } = req.body;
    if (!Array.isArray(importRows) || importRows.length === 0)
      return res.status(400).json({ error: "No rows provided" });
    if (importRows.length > 5000)
      return res.status(400).json({ error: "Maximum 5000 rows allowed" });

    let created = 0, updated = 0, failed = 0;
    const errors = [];

    for (let i = 0; i < importRows.length; i++) {
      const row = importRows[i];
      const rowNum = i + 2;

      const brandName = row.brandName ? String(row.brandName).trim() : null;
      const genericName = row.genericName ? String(row.genericName).trim() : null;
      const strength = row.strength ? String(row.strength).trim() : null;
      const dosageForm = row.dosageForm ? String(row.dosageForm).trim() : null;

      if (!brandName && !genericName) {
        errors.push({ row: rowNum, message: "Missing both brandName and genericName" });
        failed++;
        continue;
      }

      const active = row.active === false || String(row.active).toUpperCase() === "FALSE" ? false : true;

      try {
        // Try to find existing by brand or generic key
        let existing = null;
        if (brandName) {
          const r = await pool.query(
            `SELECT id FROM clinic_medications WHERE client_id=$1 AND brand_name=$2 AND COALESCE(strength,'')=$3 AND COALESCE(dosage_form,'')=$4`,
            [client_id, brandName, strength || '', dosageForm || '']
          );
          if (r.rows.length > 0) existing = r.rows[0];
        }
        if (!existing && genericName) {
          const r = await pool.query(
            `SELECT id FROM clinic_medications WHERE client_id=$1 AND generic_name=$2 AND COALESCE(strength,'')=$3 AND COALESCE(dosage_form,'')=$4`,
            [client_id, genericName, strength || '', dosageForm || '']
          );
          if (r.rows.length > 0) existing = r.rows[0];
        }

        if (existing) {
          await pool.query(
            `UPDATE clinic_medications SET brand_name=$1, generic_name=$2, strength=$3, dosage_form=$4,
             route=$5, default_dose=$6, default_frequency=$7, default_duration=$8, notes=$9, active=$10, updated_at=NOW()
             WHERE id=$11 AND client_id=$12`,
            [
              brandName, genericName, strength, dosageForm,
              row.route || null, row.defaultDose || null, row.defaultFrequency || null,
              row.defaultDuration || null, row.notes || null, active,
              existing.id, client_id
            ]
          );
          updated++;
        } else {
          await pool.query(
            `INSERT INTO clinic_medications (client_id, brand_name, generic_name, strength, dosage_form, route, default_dose, default_frequency, default_duration, notes, active)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [
              client_id, brandName, genericName, strength, dosageForm,
              row.route || null, row.defaultDose || null, row.defaultFrequency || null,
              row.defaultDuration || null, row.notes || null, active
            ]
          );
          created++;
        }
      } catch (rowErr) {
        errors.push({ row: rowNum, message: rowErr.message });
        failed++;
      }
    }

    res.json({ created, updated, failed, errors });
  } catch (err) {
    console.error("POST /catalog/medications/import error:", err);
    res.status(500).json({ error: "Server error" });
  }
});


// ===================== MAPPERS =====================

function mapService(row) {
  return {
    id: String(row.id),
    serviceName: row.service_name,
    category: row.category || "General",
    price: parseFloat(row.price),
    currency: row.currency || "JOD",
    active: row.active !== false,
    clientId: row.client_id,
    createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : Date.now(),
  };
}

function mapMedication(row) {
  return {
    id: String(row.id),
    brandName: row.brand_name || "",
    genericName: row.generic_name || "",
    strength: row.strength || "",
    dosageForm: row.dosage_form || "",
    route: row.route || "",
    defaultDose: row.default_dose || "",
    defaultFrequency: row.default_frequency || "",
    defaultDuration: row.default_duration || "",
    notes: row.notes || "",
    active: row.active !== false,
    clientId: row.client_id,
    createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : Date.now(),
  };
}

export default router;
