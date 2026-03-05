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
    const clientId = req.user.client_id;
    if (!clientId) return res.status(400).json({ error: "No client_id associated with user" });

    // from/to can be ISO dates or epoch-ms; convert to epoch-ms
    const fromMs = isNaN(Number(from)) ? new Date(from).getTime() : Number(from);
    const toMs = isNaN(Number(to)) ? new Date(to).getTime() : Number(to);

    const { rows } = await pool.query(
      `SELECT u.name AS doctor, COUNT(a.id) AS total
       FROM appointments a
       JOIN users u ON a.doctor_id = u.uid
       WHERE a.client_id=$1
         AND a.date BETWEEN $2 AND $3
       GROUP BY u.name
       ORDER BY total DESC`,
      [clientId, fromMs, toMs]
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
    const clientId = req.user.client_id;
    if (!clientId) return res.status(400).json({ error: "No client_id associated with user" });

    const fromMs = isNaN(Number(from)) ? new Date(from).getTime() : Number(from);
    const toMs = isNaN(Number(to)) ? new Date(to).getTime() : Number(to);

    const { rows } = await pool.query(
      `SELECT status, COUNT(*) AS total
       FROM appointments
       WHERE client_id=$1
         AND status IN ('cancelled','no_show')
         AND date BETWEEN $2 AND $3
       GROUP BY status`,
      [clientId, fromMs, toMs]
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
    const clientId = req.user.client_id;
    if (!clientId) return res.status(400).json({ error: "No client_id associated with user" });

    const fromMs = isNaN(Number(from)) ? new Date(from).getTime() : Number(from);
    const toMs = isNaN(Number(to)) ? new Date(to).getTime() : Number(to);

    const { rows } = await pool.query(
      `SELECT EXTRACT(HOUR FROM to_timestamp(date / 1000.0)) AS hour, COUNT(*) AS total
       FROM appointments
       WHERE client_id=$1
         AND date BETWEEN $2 AND $3
       GROUP BY hour
       ORDER BY total DESC`,
      [clientId, fromMs, toMs]
    );

    res.json(rows);
  } catch (err) {
    console.error("GET /reports/peak-hours error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
