import express from "express";
import pool from "../db.js";
import { auth } from "../middleware/auth.js";
import { createAppointmentSchema } from "../validation/appointment.js";

const router = express.Router();
router.use(auth);

/** Map a DB row to frontend-compatible Appointment shape */
function mapAppointmentRow(row) {
  return {
    id: String(row.id),
    patientId: String(row.patient_id),
    patientName: row.patient_name,
    clinicId: String(row.clinic_id),
    doctorId: row.doctor_id ? String(row.doctor_id) : undefined,
    date: row.start_time ? new Date(row.start_time).getTime() : (row.date || Date.now()),
    status: row.status,
    reason: row.reason || "",
    notes: "",
    suggestedDate: row.suggested_date ? new Date(row.suggested_date).getTime() : undefined,
    suggestedNotes: row.suggested_notes || undefined,
    createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
    createdBy: row.created_by || "system",
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : Date.now(),
    updatedBy: row.updated_by || "system",
    isArchived: row.is_archived || false,
  };
}

/**
 * GET /appointments
 * List all appointments for the current client
 */
router.get("/", async (req, res) => {
  try {
    const { client_id, role, id: userId, patient_id } = req.user;

    let query, params;

    // Patients can only see their own appointments
    if (req.user.type === "patient") {
      query = client_id
        ? "SELECT * FROM appointments WHERE patient_id=$1 AND client_id=$2 ORDER BY start_time DESC"
        : "SELECT * FROM appointments WHERE patient_id=$1 ORDER BY start_time DESC";
      params = client_id ? [patient_id, client_id] : [patient_id];
    } else if (client_id) {
      query = "SELECT * FROM appointments WHERE client_id=$1 ORDER BY start_time DESC";
      params = [client_id];
    } else if (req.user.type === "super_admin") {
      query = "SELECT * FROM appointments ORDER BY start_time DESC LIMIT 500";
      params = [];
    } else {
      return res.status(403).json({ error: "client_id required" });
    }

    const { rows } = await pool.query(query, params);
    res.json(rows.map(mapAppointmentRow));
  } catch (err) {
    console.error("GET /appointments error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * GET /appointments/by-patient/:patientId
 * Get appointments for a specific patient
 */
router.get("/by-patient/:patientId", async (req, res) => {
  try {
    const patientId = parseInt(req.params.patientId);
    const { client_id } = req.user;

    const query = client_id
      ? "SELECT * FROM appointments WHERE patient_id=$1 AND client_id=$2 ORDER BY start_time DESC"
      : "SELECT * FROM appointments WHERE patient_id=$1 ORDER BY start_time DESC";
    const params = client_id ? [patientId, client_id] : [patientId];
    const { rows } = await pool.query(query, params);

    res.json(rows.map(mapAppointmentRow));
  } catch (err) {
    console.error("GET /appointments/by-patient error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * GET /appointments/today
 * Today's appointments (filtered by role)
 */
router.get("/today", async (req, res) => {
  try {
    const { role, id, client_id } = req.user;

    if (role === "doctor") {
      const { rows } = await pool.query(
        `SELECT * FROM appointments
         WHERE doctor_id=$1 AND DATE(start_time)=CURRENT_DATE
         ORDER BY start_time`,
        [id]
      );
      return res.json(rows.map(mapAppointmentRow));
    }

    if (["admin", "receptionist", "secretary"].includes(role)) {
      const query = client_id
        ? `SELECT * FROM appointments WHERE client_id=$1 AND DATE(start_time)=CURRENT_DATE ORDER BY start_time`
        : `SELECT * FROM appointments WHERE DATE(start_time)=CURRENT_DATE ORDER BY start_time`;
      const params = client_id ? [client_id] : [];
      const { rows } = await pool.query(query, params);
      return res.json(rows.map(mapAppointmentRow));
    }

    res.status(403).json({ error: "Forbidden" });
  } catch (err) {
    console.error("GET /appointments/today error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * GET /appointments/week
 * This week's appointments
 */
router.get("/week", async (req, res) => {
  try {
    const { role, id, client_id } = req.user;

    const baseFilter = role === "doctor" ? "doctor_id=$1" : "client_id=$1";
    const filterParam = role === "doctor" ? id : client_id;

    const { rows } = await pool.query(
      `SELECT * FROM appointments
       WHERE ${baseFilter}
       AND start_time BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'
       ORDER BY start_time`,
      [filterParam]
    );
    res.json(rows.map(mapAppointmentRow));
  } catch (err) {
    console.error("GET /appointments/week error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * GET /appointments/day?date=YYYY-MM-DD
 * Appointments for a specific date
 */
router.get("/day", async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: "date required" });

    const { role, id, client_id } = req.user;

    const baseFilter = role === "doctor" ? "doctor_id=$1" : "client_id=$1";
    const filterParam = role === "doctor" ? id : client_id;

    const { rows } = await pool.query(
      `SELECT * FROM appointments
       WHERE ${baseFilter} AND DATE(start_time)=$2
       ORDER BY start_time`,
      [filterParam, date]
    );
    res.json(rows.map(mapAppointmentRow));
  } catch (err) {
    console.error("GET /appointments/day error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /appointments
 * Create a new appointment
 * Accepts both frontend format (patientId, clinicId, date, reason)
 * and backend format (patient_id, doctor_id, start_time, end_time)
 */
router.post("/", async (req, res) => {
  try {
    const { role, client_id, id: userId } = req.user;
    if (!["admin", "receptionist", "secretary", "doctor", "super_admin"].includes(role)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    // Validate input
    const parsed = createAppointmentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid input", details: parsed.error.issues.map(i => i.message) });
    }

    // Support both frontend and backend field naming
    const {
      patient_id, patientId,
      patient_name, patientName,
      doctor_id, doctorId,
      clinic_id, clinicId,
      start_time, date,
      end_time,
      reason, status,
    } = req.body;

    const pId = patient_id || (patientId ? parseInt(patientId) : null);
    const dId = doctor_id || (doctorId ? parseInt(doctorId) : null);
    const cId = clinic_id || (clinicId ? parseInt(clinicId) : null);
    const pName = patient_name || patientName || "";

    // Convert date timestamp to ISO string if needed
    let startTime = start_time;
    if (!startTime && date) {
      startTime = typeof date === "number" ? new Date(date).toISOString() : date;
    }
    let endTime = end_time;
    if (!endTime && startTime) {
      endTime = new Date(new Date(startTime).getTime() + 3600000).toISOString();
    }

    if (!pId || !startTime) {
      return res.status(400).json({ error: "patient_id and start_time/date required" });
    }

    const { rows } = await pool.query(
      `INSERT INTO appointments
       (patient_id, patient_name, clinic_id, doctor_id, start_time, end_time, status, reason, client_id, created_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), $10)
       RETURNING *`,
      [pId, pName, cId, dId, startTime, endTime, status || "scheduled", reason || "", client_id, userId]
    );

    res.status(201).json(mapAppointmentRow(rows[0]));
  } catch (err) {
    if (err.code === "23505" || (err.message && err.message.includes("overlap"))) {
      return res.status(409).json({ error: "Doctor already booked at this time" });
    }
    if (err.code === "23503") {
      return res.status(400).json({ error: "Referenced record not found" });
    }
    console.error("POST /appointments error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * PUT /appointments/:id
 * Full update (status, clinicId, doctorId, date, reason, suggestedDate, suggestedNotes)
 */
router.put("/:id", async (req, res) => {
  try {
    const role = req.user.role || req.user.type;
    if (!["admin", "receptionist", "secretary", "doctor", "super_admin"].includes(role)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const { client_id, id: userId } = req.user;
    const appointmentId = parseInt(req.params.id);

    const {
      status, reason,
      clinic_id, clinicId,
      doctor_id, doctorId,
      start_time, date,
      suggested_date, suggestedDate,
      suggested_notes, suggestedNotes,
    } = req.body;

    const sets = ["updated_at=NOW()"];
    const params = [];
    let idx = 1;

    if (status !== undefined) {
      sets.push(`status=$${idx++}`);
      params.push(status);
    }
    if (reason !== undefined) {
      sets.push(`reason=$${idx++}`);
      params.push(reason);
    }

    const cId = clinic_id || (clinicId ? parseInt(clinicId) : undefined);
    if (cId !== undefined) {
      sets.push(`clinic_id=$${idx++}`);
      params.push(cId);
    }

    const dId = doctor_id || (doctorId ? parseInt(doctorId) : undefined);
    if (dId !== undefined) {
      sets.push(`doctor_id=$${idx++}`);
      params.push(dId);
    }

    const startTimeVal = start_time || (date !== undefined ? (typeof date === "number" ? new Date(date).toISOString() : date) : undefined);
    if (startTimeVal !== undefined) {
      sets.push(`start_time=$${idx++}`);
      params.push(startTimeVal);
    }

    const sugDate = suggested_date || (suggestedDate !== undefined ? new Date(suggestedDate).toISOString() : undefined);
    if (sugDate !== undefined) {
      sets.push(`suggested_date=$${idx++}`);
      params.push(sugDate);
    }

    const sugNotes = suggested_notes || suggestedNotes;
    if (sugNotes !== undefined) {
      sets.push(`suggested_notes=$${idx++}`);
      params.push(sugNotes);
    }

    sets.push(`updated_by=$${idx++}`);
    params.push(userId || "system");

    params.push(appointmentId);
    let whereClause = `id=$${idx++}`;
    if (client_id) {
      params.push(client_id);
      whereClause += ` AND client_id=$${idx++}`;
    }

    await pool.query(
      `UPDATE appointments SET ${sets.join(", ")} WHERE ${whereClause}`,
      params
    );

    res.json({ success: true });
  } catch (err) {
    console.error("PUT /appointments/:id error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * PUT /appointments/:id/status
 * Legacy endpoint: update status only
 */
router.put("/:id/status", async (req, res) => {
  try {
    const { role, id: userId, client_id } = req.user;
    const { status } = req.body;

    if (!["admin", "doctor", "receptionist", "secretary", "super_admin"].includes(role)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const query = client_id
      ? "UPDATE appointments SET status=$1, updated_by=$2, updated_at=NOW() WHERE id=$3 AND client_id=$4"
      : "UPDATE appointments SET status=$1, updated_by=$2, updated_at=NOW() WHERE id=$3";
    const params = client_id
      ? [status, userId, parseInt(req.params.id), client_id]
      : [status, userId, parseInt(req.params.id)];

    await pool.query(query, params);
    res.json({ success: true });
  } catch (err) {
    console.error("PUT /appointments/:id/status error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * DELETE /appointments/:id
 * Delete an appointment
 */
router.delete("/:id", async (req, res) => {
  try {
    const { role, client_id } = req.user;
    if (!["admin", "receptionist", "secretary", "super_admin"].includes(role)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const appointmentId = parseInt(req.params.id);
    const query = client_id
      ? "DELETE FROM appointments WHERE id=$1 AND client_id=$2"
      : "DELETE FROM appointments WHERE id=$1";
    const params = client_id ? [appointmentId, client_id] : [appointmentId];

    await pool.query(query, params);
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /appointments/:id error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
