import express from "express";
import bcrypt from "bcrypt";
import crypto from "crypto";
import pool from "../db.js";
import { auth } from "../middleware/auth.js";

const router = express.Router();
router.use(auth);

function makeUsername(phone) {
  const clean = String(phone || "").replace(/\D/g, "");
  return `p${clean}`;
}

function makePassword() {
  return crypto.randomBytes(6).toString("base64url");
}

/** Helper: calculate age from date of birth */
function calculateAge(dateOfBirth) {
  if (!dateOfBirth) return 0;
  const dob = new Date(dateOfBirth);
  if (isNaN(dob.getTime())) return 0;
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const monthDiff = today.getMonth() - dob.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) {
    age--;
  }
  return age;
}

/** Map a DB row to frontend-compatible Patient shape */
function mapPatientRow(row) {
  let medicalProfile = row.medical_profile;
  if (typeof medicalProfile === "string") {
    try { medicalProfile = JSON.parse(medicalProfile); } catch { medicalProfile = {}; }
  }
  let currentVisit = row.current_visit;
  if (typeof currentVisit === "string") {
    try { currentVisit = JSON.parse(currentVisit); } catch { currentVisit = null; }
  }
  let history = row.history;
  if (typeof history === "string") {
    try { history = JSON.parse(history); } catch { history = []; }
  }
  const dobStr = row.date_of_birth instanceof Date
    ? row.date_of_birth.toISOString().split("T")[0]
    : row.date_of_birth ? String(row.date_of_birth) : undefined;

  return {
    id: String(row.id),
    name: row.full_name,
    age: dobStr ? calculateAge(dobStr) : (row.age || 0),
    dateOfBirth: dobStr || undefined,
    gender: row.gender || "male",
    phone: row.phone || "",
    username: row.username || undefined,
    email: row.email || undefined,
    hasAccess: row.has_access || false,
    medicalProfile: medicalProfile && Object.keys(medicalProfile).length > 0
      ? medicalProfile
      : {
          allergies: { exists: false, details: "" },
          chronicConditions: { exists: false, details: "" },
          currentMedications: { exists: false, details: "" },
          isPregnant: false,
          notes: row.notes || "",
        },
    currentVisit: currentVisit && Object.keys(currentVisit).length > 0
      ? currentVisit
      : {
          visitId: `v_${row.id}_${Date.now()}`,
          clinicId: "",
          date: Date.now(),
          status: "waiting",
          priority: "normal",
          reasonForVisit: row.notes || "",
        },
    history: Array.isArray(history) ? history : [],
    createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
    createdBy: row.created_by || "system",
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : Date.now(),
    updatedBy: row.updated_by || "system",
    isArchived: row.is_archived || false,
  };
}

/**
 * GET /patients
 * List all patients for the current client
 */
router.get("/", async (req, res) => {
  try {
    const { client_id } = req.user;
    const query = client_id
      ? "SELECT * FROM patients WHERE client_id=$1 ORDER BY id DESC"
      : "SELECT * FROM patients ORDER BY id DESC";
    const params = client_id ? [client_id] : [];
    const { rows } = await pool.query(query, params);
    res.json(rows.map(mapPatientRow));
  } catch (err) {
    console.error("GET /patients error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * GET /patients/:id
 * Get a single patient by ID
 */
router.get("/:id", async (req, res) => {
  try {
    const patientId = req.params.id;

    const { client_id, type, patient_id } = req.user;

    // Patients can only view their own record
    if (type === "patient" && String(patient_id) !== String(patientId)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const query = client_id
      ? "SELECT * FROM patients WHERE id=$1 AND client_id=$2 LIMIT 1"
      : "SELECT * FROM patients WHERE id=$1 LIMIT 1";
    const params = client_id ? [patientId, client_id] : [patientId];
    const { rows } = await pool.query(query, params);

    if (rows.length === 0) {
      return res.status(404).json({ error: "Patient not found" });
    }
    res.json(mapPatientRow(rows[0]));
  } catch (err) {
    console.error("GET /patients/:id error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /patients
 * Create a new patient
 * Admin/Receptionist/Doctor only
 */
router.post("/", async (req, res) => {
  try {
    const { role, client_id } = req.user;
    if (!["admin", "receptionist", "secretary", "doctor", "super_admin"].includes(role)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const {
      full_name, name, phone, email, gender, date_of_birth, dateOfBirth,
      notes, username, password, has_access, hasAccess,
      medical_profile, medicalProfile,
      current_visit, currentVisit,
      history,
    } = req.body;

    const patientName = full_name || name;
    if (!patientName) {
      return res.status(400).json({ error: "full_name required" });
    }

    // Auto-generate credentials if not provided
    let finalUsername = username || (phone ? makeUsername(phone) : null);
    let plainPassword = password || makePassword();
    let hashedPassword = await bcrypt.hash(plainPassword, 10);

    const dob = date_of_birth || dateOfBirth || null;
    const age = dob ? calculateAge(dob) : 0;
    const medProfile = medical_profile || medicalProfile || {};
    const visit = current_visit || currentVisit || {};
    const hist = history || [];
    const access = has_access !== undefined ? has_access : (hasAccess !== undefined ? hasAccess : false);

    try {
      const patientId = "pat_" + Date.now();
      const { rows } = await pool.query(
        `INSERT INTO patients (
          id, full_name, age, date_of_birth, gender, phone, username, email, password, has_access,
          notes, medical_profile, current_visit, history,
          client_id, created_at, updated_at, created_by, updated_by, is_archived
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14::jsonb,
                $15, NOW(), NOW(), 'system', 'system', false)
        RETURNING id, full_name, phone, username`,
        [
          patientId,
          patientName, age, dob, gender || "male", phone || "",
          finalUsername, email || null, hashedPassword, access,
          notes || medProfile?.notes || "",
          JSON.stringify(medProfile), JSON.stringify(visit), JSON.stringify(hist),
          client_id,
        ]
      );

      res.status(201).json({
        patient: mapPatientRow({
          ...rows[0],
          full_name: patientName,
          medical_profile: medProfile,
          current_visit: visit,
          history: hist,
        }),
        credentials: { username: finalUsername, password: plainPassword },
      });
    } catch (err) {
      if (err.code === "23505" && finalUsername) {
        // Duplicate username — append random suffix
        finalUsername = finalUsername + "-" + Math.floor(1000 + Math.random() * 9000);
        plainPassword = makePassword();
        hashedPassword = await bcrypt.hash(plainPassword, 10);
        const retryPatientId = "pat_" + Date.now() + "_" + Math.floor(Math.random() * 1000);
        const { rows } = await pool.query(
          `INSERT INTO patients (
            id, full_name, age, date_of_birth, gender, phone, username, email, password, has_access,
            notes, medical_profile, current_visit, history,
            client_id, created_at, updated_at, created_by, updated_by, is_archived
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14::jsonb,
                  $15, NOW(), NOW(), 'system', 'system', false)
          RETURNING id, full_name, phone, username`,
          [
            retryPatientId,
            patientName, age, dob, gender || "male", phone || "",
            finalUsername, email || null, hashedPassword, access,
            notes || medProfile?.notes || "",
            JSON.stringify(medProfile), JSON.stringify(visit), JSON.stringify(hist),
            client_id,
          ]
        );
        return res.status(201).json({
          patient: rows[0],
          credentials: { username: finalUsername, password: plainPassword },
        });
      }
      throw err;
    }
  } catch (err) {
    console.error("POST /patients error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * PUT /patients/:id
 * Update patient fields
 */
router.put("/:id", async (req, res) => {
  try {
    const { role, client_id, type, patient_id: callerPatientId } = req.user;

    // Patients can only update their own record (limited fields)
    const patientId = req.params.id;
    if (type === "patient" && String(callerPatientId) !== String(patientId)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const {
      full_name, name, phone, email, gender, date_of_birth, dateOfBirth,
      username, password, has_access, hasAccess,
      medical_profile, medicalProfile,
      current_visit, currentVisit,
      history, age,
    } = req.body;

    const sets = ["updated_at=NOW()"];
    const params = [];
    let idx = 1;

    const patientName = full_name || name;
    if (patientName !== undefined) {
      sets.push(`full_name=$${idx++}`);
      params.push(patientName);
    }

    const dob = date_of_birth || dateOfBirth;
    if (dob !== undefined) {
      sets.push(`date_of_birth=$${idx++}`);
      params.push(dob);
      sets.push(`age=$${idx++}`);
      params.push(calculateAge(dob));
    } else if (age !== undefined) {
      sets.push(`age=$${idx++}`);
      params.push(age);
    }

    if (gender !== undefined) {
      sets.push(`gender=$${idx++}`);
      params.push(gender);
    }
    if (phone !== undefined) {
      sets.push(`phone=$${idx++}`);
      params.push(phone);
    }
    if (username !== undefined) {
      sets.push(`username=$${idx++}`);
      params.push(username || null);
    }
    if (email !== undefined) {
      sets.push(`email=$${idx++}`);
      params.push(email || null);
    }
    if (password !== undefined && password !== "") {
      const hashed = await bcrypt.hash(password, 10);
      sets.push(`password=$${idx++}`);
      params.push(hashed);
    }

    const accessValue = has_access !== undefined ? has_access : hasAccess;
    if (accessValue !== undefined) {
      sets.push(`has_access=$${idx++}`);
      params.push(accessValue);
    }

    const medProfile = medical_profile || medicalProfile;
    if (medProfile !== undefined) {
      sets.push(`medical_profile=$${idx++}::jsonb`);
      params.push(JSON.stringify(medProfile));
    }

    const visit = current_visit || currentVisit;
    if (visit !== undefined) {
      sets.push(`current_visit=$${idx++}::jsonb`);
      params.push(JSON.stringify(visit));
    }

    if (history !== undefined) {
      sets.push(`history=$${idx++}::jsonb`);
      params.push(JSON.stringify(history));
    }

    // WHERE clause
    params.push(patientId);
    let whereClause = `id=$${idx++}`;
    if (client_id) {
      params.push(client_id);
      whereClause += ` AND client_id=$${idx++}`;
    }

    await pool.query(
      `UPDATE patients SET ${sets.join(", ")} WHERE ${whereClause}`,
      params
    );

    res.json({ success: true });
  } catch (err) {
    console.error("PUT /patients/:id error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * DELETE /patients/:id
 * Delete a patient (admin only)
 */
router.delete("/:id", async (req, res) => {
  try {
    const { role, client_id } = req.user;
    if (!["admin", "super_admin"].includes(role)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const patientId = req.params.id;
    const query = client_id
      ? "DELETE FROM patients WHERE id=$1 AND client_id=$2"
      : "DELETE FROM patients WHERE id=$1";
    const params = client_id ? [patientId, client_id] : [patientId];
    await pool.query(query, params);

    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /patients/:id error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
