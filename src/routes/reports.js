import express from "express";
import pool from "../db.js";
import { auth } from "../middleware/auth.js";

const router = express.Router();
router.use(auth);

// Only admin / doctor / secretary can view reports
function requireStaff(req, res, next) {
  const role = req.user.role;
  if (!["admin", "doctor", "secretary"].includes(role) && req.user.type !== "super_admin") {
    return res.status(403).json({ error: "Access denied" });
  }
  next();
}
router.use(requireStaff);

// ضغط الأطباء (عدد المواعيد بالأسبوع)
router.get("/doctor-load", async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: "from and to query params required" });
    const clinicId = req.user.clinic_id;
    if (!clinicId) return res.status(400).json({ error: "No clinic_id associated with user" });

    const { rows } = await pool.query(
      `SELECT u.full_name AS doctor, COUNT(a.id) AS total
       FROM appointments a
       JOIN users u ON a.doctor_id = u.id
       WHERE a.clinic_id=$1
         AND a.start_time BETWEEN $2 AND $3
       GROUP BY u.full_name
       ORDER BY total DESC`,
      [clinicId, from, to]
    );

    res.json(rows);
  } catch (err) {
    console.error("GET /reports/doctor-load error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// الإلغاءات (Cancelled / No-show)
router.get("/cancellations", async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: "from and to query params required" });
    const clinicId = req.user.clinic_id;
    if (!clinicId) return res.status(400).json({ error: "No clinic_id associated with user" });

    const { rows } = await pool.query(
      `SELECT status, COUNT(*) AS total
       FROM appointments
       WHERE clinic_id=$1
         AND status IN ('cancelled','no_show')
         AND start_time BETWEEN $2 AND $3
       GROUP BY status`,
      [clinicId, from, to]
    );

    res.json(rows);
  } catch (err) {
    console.error("GET /reports/cancellations error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// أوقات الذروة (حسب الساعة)
router.get("/peak-hours", async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: "from and to query params required" });
    const clinicId = req.user.clinic_id;
    if (!clinicId) return res.status(400).json({ error: "No clinic_id associated with user" });

    const { rows } = await pool.query(
      `SELECT EXTRACT(HOUR FROM start_time) AS hour, COUNT(*) AS total
       FROM appointments
       WHERE clinic_id=$1
         AND start_time BETWEEN $2 AND $3
       GROUP BY hour
       ORDER BY total DESC`,
      [clinicId, from, to]
    );

    res.json(rows);
  } catch (err) {
    console.error("GET /reports/peak-hours error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
