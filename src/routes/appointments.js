import express from "express";
import pool from "../db.js";
import { auth } from "../middleware/auth.js";

const router = express.Router();
router.use(auth);

/**
 * Map a DB row to frontend-compatible Appointment shape.
 */
function mapAppointmentRow(row) {
  return {
    id: String(row.id),
    patientId: String(row.patient_id),
    patientName: row.patient_name || "",
    clinicId: String(row.clinic_id || ""),
    doctorId: row.doctor_id ? String(row.doctor_id) : undefined,
    date: typeof row.date === "number" ? row.date : Number(row.date) || Date.now(),
    status: row.status || "scheduled",
    reason: row.reason || "",
    notes: "",
    createdAt: typeof row.created_at === "number" ? row.created_at : Number(row.created_at) || Date.now(),
    createdBy: row.created_by || "system",
    updatedAt: typeof row.updated_at === "number" ? row.updated_at : Number(row.updated_at) || Date.now(),
    updatedBy: row.updated_by || "system",
    isArchived: false,
  };
}

// Helper: get epoch-ms range for "today"
function todayRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const end = start + 86400000;
  return { start, end };
}

// Helper: get epoch-ms range for "this week" (next 7 days)
function weekRange() {
  const { start } = todayRange();
  return { start, end: start + 7 * 86400000 };
}

/**
 * GET /appointments
 * List all appointments
 */
router.get("/", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM appointments ORDER BY date DESC"
    );
    res.json(rows.map(mapAppointmentRow));
  } catch (err) {
    console.error("GET /appointments error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * GET /appointments/by-patient/:patientId
 */
router.get("/by-patient/:patientId", async (req, res) => {
  try {
    const patientId = req.params.patientId;
    const { rows } = await pool.query(
      "SELECT * FROM appointments WHERE patient_id=$1 ORDER BY date DESC",
      [patientId]
    );
    res.json(rows.map(mapAppointmentRow));
  } catch (err) {
    console.error("GET /appointments/by-patient error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * GET /appointments/today
 */
router.get("/today", async (req, res) => {
  try {
    const { role, uid } = req.user;
    const { start, end } = todayRange();

    if (role === "doctor") {
      const { rows } = await pool.query(
        "SELECT * FROM appointments WHERE doctor_id=$1 AND date >= $2 AND date < $3 ORDER BY date",
        [uid, start, end]
      );
      return res.json(rows.map(mapAppointmentRow));
    }

    if (["admin", "receptionist", "secretary"].includes(role)) {
      const { rows } = await pool.query(
        "SELECT * FROM appointments WHERE date >= $1 AND date < $2 ORDER BY date",
        [start, end]
      );
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
 */
router.get("/week", async (req, res) => {
  try {
    const { role, uid } = req.user;
    const { start, end } = weekRange();

    if (role === "doctor") {
      const { rows } = await pool.query(
        "SELECT * FROM appointments WHERE doctor_id=$1 AND date >= $2 AND date < $3 ORDER BY date",
        [uid, start, end]
      );
      return res.json(rows.map(mapAppointmentRow));
    }

    const { rows } = await pool.query(
      "SELECT * FROM appointments WHERE date >= $1 AND date < $2 ORDER BY date",
      [start, end]
    );
    res.json(rows.map(mapAppointmentRow));
  } catch (err) {
    console.error("GET /appointments/week error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * GET /appointments/day?date=YYYY-MM-DD
 */
router.get("/day", async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: "date required" });

    const { role, uid } = req.user;
    const dayStart = new Date(date + "T00:00:00").getTime();
    const dayEnd = dayStart + 86400000;

    if (role === "doctor") {
      const { rows } = await pool.query(
        "SELECT * FROM appointments WHERE doctor_id=$1 AND date >= $2 AND date < $3 ORDER BY date",
        [uid, dayStart, dayEnd]
      );
      return res.json(rows.map(mapAppointmentRow));
    }

    const { rows } = await pool.query(
      "SELECT * FROM appointments WHERE date >= $1 AND date < $2 ORDER BY date",
      [dayStart, dayEnd]
    );
    res.json(rows.map(mapAppointmentRow));
  } catch (err) {
    console.error("GET /appointments/day error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /appointments
 * Create a new appointment.
 */
router.post("/", async (req, res) => {
  try {
    const { role, uid: userId } = req.user;
    if (!["admin", "receptionist", "secretary", "doctor"].includes(role)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const {
      patient_id, patientId,
      patient_name, patientName,
      doctor_id, doctorId,
      clinic_id, clinicId,
      start_time, date,
      reason, status,
    } = req.body;

    const pId = String(patient_id || patientId || "");
    const dId = (doctor_id || doctorId) ? String(doctor_id || doctorId) : null;
    const cId = String(clinic_id || clinicId || "");
    const pName = patient_name || patientName || "";

    let dateEpoch;
    if (date !== undefined) {
      dateEpoch = typeof date === "number" ? date : new Date(date).getTime();
    } else if (start_time) {
      dateEpoch = new Date(start_time).getTime();
    }

    if (!pId || !dateEpoch) {
      return res.status(400).json({ error: "patient_id and date required" });
    }

    const appointmentId = "apt_" + Date.now();
    const now = Date.now();

    const { rows } = await pool.query(
      `INSERT INTO appointments
       (id, patient_id, patient_name, clinic_id, doctor_id, date, status, reason,
        created_at, created_by, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        appointmentId, pId, pName, cId, dId, dateEpoch,
        status || "scheduled", reason || "",
        now, userId || "system", now, userId || "system",
      ]
    );

    res.status(201).json(mapAppointmentRow(rows[0]));
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "Appointment conflict" });
    }
    console.error("POST /appointments error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * PUT /appointments/:id
 * Update appointment fields
 */
router.put("/:id", async (req, res) => {
  try {
    const role = req.user.role || req.user.type;
    if (!["admin", "receptionist", "secretary", "doctor"].includes(role)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const { uid: userId } = req.user;
    const appointmentId = req.params.id;

    const {
      status, reason,
      clinic_id, clinicId,
      doctor_id, doctorId,
      start_time, date,
    } = req.body;

    const now = Date.now();
    const sets = [`updated_at=${now}`];
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

    const cId = clinic_id || clinicId;
    if (cId !== undefined) {
      sets.push(`clinic_id=$${idx++}`);
      params.push(String(cId));
    }

    const dId = doctor_id || doctorId;
    if (dId !== undefined) {
      sets.push(`doctor_id=$${idx++}`);
      params.push(dId ? String(dId) : null);
    }

    const dateVal = date !== undefined ? date : (start_time ? new Date(start_time).getTime() : undefined);
    if (dateVal !== undefined) {
      const epoch = typeof dateVal === "number" ? dateVal : new Date(dateVal).getTime();
      sets.push(`date=$${idx++}`);
      params.push(epoch);
    }

    sets.push(`updated_by=$${idx++}`);
    params.push(userId || "system");

    params.push(appointmentId);
    const whereClause = `id=$${idx++}`;

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
 */
router.put("/:id/status", async (req, res) => {
  try {
    const { role, uid: userId } = req.user;
    const { status } = req.body;

    if (!["admin", "doctor", "receptionist", "secretary"].includes(role)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const now = Date.now();
    const appointmentId = req.params.id;

    await pool.query(
      "UPDATE appointments SET status=$1, updated_by=$2, updated_at=$3 WHERE id=$4",
      [status, userId, now, appointmentId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("PUT /appointments/:id/status error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * DELETE /appointments/:id
 */
router.delete("/:id", async (req, res) => {
  try {
    const { role } = req.user;
    if (!["admin", "receptionist", "secretary"].includes(role)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const appointmentId = req.params.id;
    await pool.query("DELETE FROM appointments WHERE id=$1", [appointmentId]);
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /appointments/:id error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
