import express from "express";
import pool from "../db.js";
import { auth } from "../middleware/auth.js";

const router = express.Router();
router.use(auth);

// Only staff can manage device results (not patients, not HR employees)
function requireStaffRole(req, res, next) {
  const allowedRoles = ["admin", "doctor", "secretary", "lab_tech", "super_admin"];
  if (!allowedRoles.includes(req.user.role) && req.user.type !== "super_admin") {
    return res.status(403).json({ error: "Access denied" });
  }
  next();
}
router.use(requireStaffRole);

/** Map a DB row to frontend-compatible DeviceResult shape */
function mapResultRow(row) {
  return {
    id: row.id,
    clientId: row.client_id,
    deviceId: row.device_id,
    deviceName: row.device_name || undefined,
    deviceType: row.device_type || undefined,
    patientIdentifier: row.patient_identifier,
    testCode: row.test_code,
    testName: row.test_name || undefined,
    value: row.value,
    unit: row.unit || undefined,
    referenceRange: row.reference_range || undefined,
    isAbnormal: row.is_abnormal || false,
    rawMessage: row.raw_message || undefined,
    status: row.status,
    matchedPatientId: row.matched_patient_id
      ? String(row.matched_patient_id)
      : undefined,
    matchedPatientName: row.patient_name || undefined,
    matchedAt: row.matched_at
      ? new Date(row.matched_at).toISOString()
      : undefined,
    matchedBy: row.matched_by || undefined,
    errorMessage: row.error_message || undefined,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/**
 * GET /device-results
 * List device results for the current client
 * Optional query: ?status=pending|matched|error|rejected  &patientId=X
 */
router.get("/", async (req, res) => {
  try {
    const { client_id } = req.user;
    if (!client_id) {
      return res.status(400).json({ error: "client_id required" });
    }

    const { status, patientId } = req.query;

    let query, params;

    if (patientId) {
      query = `
        SELECT dr.*, d.name as device_name, d.type as device_type
        FROM device_results dr
        LEFT JOIN devices d ON d.id = dr.device_id
        WHERE dr.matched_patient_id::text=$1 AND dr.client_id=$2
        ORDER BY dr.created_at DESC
      `;
      params = [String(patientId), client_id];
    } else if (status) {
      query = `
        SELECT dr.*, d.name as device_name, d.type as device_type, p.full_name as patient_name
        FROM device_results dr
        LEFT JOIN devices d ON d.id = dr.device_id
        LEFT JOIN patients p ON p.id = dr.matched_patient_id::text
        WHERE dr.client_id=$1 AND dr.status=$2
        ORDER BY dr.created_at DESC
        LIMIT 200
      `;
      params = [client_id, status];
    } else {
      query = `
        SELECT dr.*, d.name as device_name, d.type as device_type, p.full_name as patient_name
        FROM device_results dr
        LEFT JOIN devices d ON d.id = dr.device_id
        LEFT JOIN patients p ON p.id = dr.matched_patient_id::text
        WHERE dr.client_id=$1
        ORDER BY dr.created_at DESC
        LIMIT 200
      `;
      params = [client_id];
    }

    const { rows } = await pool.query(query, params);
    res.json(rows.map(mapResultRow));
  } catch (err) {
    console.error("GET /device-results error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * GET /device-results/pending-count
 * Get count of pending results for badge display
 */
router.get("/pending-count", async (req, res) => {
  try {
    const { client_id } = req.user;
    if (!client_id) {
      return res.json({ count: 0 });
    }

    const { rows } = await pool.query(
      "SELECT COUNT(*)::int as count FROM device_results WHERE client_id=$1 AND status='pending'",
      [client_id]
    );

    res.json({ count: rows[0]?.count || 0 });
  } catch (err) {
    console.error("GET /device-results/pending-count error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /device-results
 * Insert a device result and attempt auto-match by patient_identifier
 */
router.post("/", async (req, res) => {
  try {
    const { client_id } = req.user;
    if (!client_id) {
      return res.status(400).json({ error: "client_id required" });
    }

    const {
      deviceId, device_id,
      patientIdentifier, patient_identifier,
      testCode, test_code,
      testName, test_name,
      value, unit,
      referenceRange, reference_range,
      isAbnormal, is_abnormal,
      rawMessage, raw_message,
    } = req.body;

    const devId = deviceId || device_id;
    const identifier = (patientIdentifier || patient_identifier || "").trim();
    const tCode = testCode || test_code;
    const tName = testName || test_name || null;
    const refRange = referenceRange || reference_range || null;
    const abnormal = isAbnormal !== undefined ? isAbnormal : (is_abnormal || false);
    const rawMsg = rawMessage || raw_message || null;

    if (!devId || !identifier || !tCode || !value) {
      return res
        .status(400)
        .json({ error: "deviceId, patientIdentifier, testCode, value required" });
    }

    // Auto-match: try by patient ID, then phone, then name
    let matchedPatientId = null;
    let status = "pending";

    const numericId = parseInt(identifier);
    if (!isNaN(numericId)) {
      // Try matching by numeric patient ID cast to text
      const match = await pool.query(
        "SELECT id FROM patients WHERE id=$1 AND client_id=$2 LIMIT 1",
        [String(identifier), client_id]
      );
      if (match.rows.length > 0) {
        matchedPatientId = match.rows[0].id;
        status = "matched";
      }
    }

    if (!matchedPatientId) {
      const phoneMatch = await pool.query(
        "SELECT id FROM patients WHERE phone=$1 AND client_id=$2 LIMIT 1",
        [identifier, client_id]
      );
      if (phoneMatch.rows.length > 0) {
        matchedPatientId = phoneMatch.rows[0].id;
        status = "matched";
      }
    }

    if (!matchedPatientId) {
      const nameMatch = await pool.query(
        "SELECT id FROM patients WHERE full_name=$1 AND client_id=$2 LIMIT 1",
        [identifier, client_id]
      );
      if (nameMatch.rows.length > 0) {
        matchedPatientId = nameMatch.rows[0].id;
        status = "matched";
      }
    }

    const { rows } = await pool.query(
      `INSERT INTO device_results (
        client_id, device_id, patient_identifier, test_code, test_name,
        value, unit, reference_range, is_abnormal, raw_message,
        status, matched_patient_id, matched_at, matched_by
      )
      VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10,
              $11, $12, $13, $14)
      RETURNING id`,
      [
        client_id, devId, identifier, tCode, tName,
        value, unit || null, refRange, abnormal, rawMsg,
        status, matchedPatientId,
        matchedPatientId ? new Date().toISOString() : null,
        matchedPatientId ? "auto" : null,
      ]
    );

    res.status(201).json({
      id: rows[0].id,
      status,
      matchedPatientId,
    });
  } catch (err) {
    console.error("POST /device-results error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * PUT /device-results/:id/match
 * Manual match: link a pending result to a patient
 */
router.put("/:id/match", async (req, res) => {
  try {
    const { client_id } = req.user;
    const resultId = req.params.id;
    const { patientId, patient_id, matchedBy, matched_by } = req.body;

    const pId = String(patientId || patient_id || "");
    const by = matchedBy || matched_by || "manual";

    if (!pId) {
      return res.status(400).json({ error: "patientId required" });
    }

    const query = client_id
      ? `UPDATE device_results
         SET status='matched', matched_patient_id=$1, matched_at=NOW(), matched_by=$2
         WHERE id=$3::uuid AND status='pending' AND client_id=$4`
      : `UPDATE device_results
         SET status='matched', matched_patient_id=$1, matched_at=NOW(), matched_by=$2
         WHERE id=$3::uuid AND status='pending'`;
    const params = client_id
      ? [pId, by, resultId, client_id]
      : [pId, by, resultId];

    await pool.query(query, params);
    res.json({ success: true });
  } catch (err) {
    console.error("PUT /device-results/:id/match error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * PUT /device-results/:id/reject
 * Reject a pending result
 */
router.put("/:id/reject", async (req, res) => {
  try {
    const { client_id } = req.user;
    const resultId = req.params.id;

    const query = client_id
      ? "UPDATE device_results SET status='rejected' WHERE id=$1::uuid AND client_id=$2"
      : "UPDATE device_results SET status='rejected' WHERE id=$1::uuid";
    const params = client_id ? [resultId, client_id] : [resultId];

    await pool.query(query, params);
    res.json({ success: true });
  } catch (err) {
    console.error("PUT /device-results/:id/reject error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
