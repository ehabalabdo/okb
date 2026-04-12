import express from "express";
import pool from "../db.js";
import { auth } from "../middleware/auth.js";

const router = express.Router();
router.use(auth);

// Only admin / doctor / secretary can view reports
function requireStaff(req, res, next) {
  const role = req.user.role;
  if (!["admin", "doctor", "secretary"].includes(role)) {
    return res.status(403).json({ error: "Access denied" });
  }
  next();
}
router.use(requireStaff);

// Doctor load (appointments per week)
router.get("/doctor-load", async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: "from and to query params required" });

    const fromMs = isNaN(Number(from)) ? new Date(from).getTime() : Number(from);
    const toMs = isNaN(Number(to)) ? new Date(to).getTime() : Number(to);

    const { rows } = await pool.query(
      `SELECT u.name AS doctor, COUNT(a.id) AS total
       FROM appointments a
       JOIN users u ON a.doctor_id = u.uid
       WHERE a.date BETWEEN $1 AND $2
       GROUP BY u.name
       ORDER BY total DESC`,
      [fromMs, toMs]
    );

    res.json(rows);
  } catch (err) {
    console.error("GET /reports/doctor-load error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Cancellations (Cancelled / No-show)
router.get("/cancellations", async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: "from and to query params required" });

    const fromMs = isNaN(Number(from)) ? new Date(from).getTime() : Number(from);
    const toMs = isNaN(Number(to)) ? new Date(to).getTime() : Number(to);

    const { rows } = await pool.query(
      `SELECT status, COUNT(*) AS total
       FROM appointments
       WHERE status IN ('cancelled','no_show')
         AND date BETWEEN $1 AND $2
       GROUP BY status`,
      [fromMs, toMs]
    );

    res.json(rows);
  } catch (err) {
    console.error("GET /reports/cancellations error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Peak hours (by hour)
router.get("/peak-hours", async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: "from and to query params required" });

    const fromMs = isNaN(Number(from)) ? new Date(from).getTime() : Number(from);
    const toMs = isNaN(Number(to)) ? new Date(to).getTime() : Number(to);

    const { rows } = await pool.query(
      `SELECT EXTRACT(HOUR FROM to_timestamp(date / 1000.0)) AS hour, COUNT(*) AS total
       FROM appointments
       WHERE date BETWEEN $1 AND $2
       GROUP BY hour
       ORDER BY total DESC`,
      [fromMs, toMs]
    );

    res.json(rows);
  } catch (err) {
    console.error("GET /reports/peak-hours error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ===================== FINANCIAL REPORTS =====================

// Financial summary
router.get("/financial-summary", async (req, res) => {
  try {
    const { from, to } = req.query;
    const fromMs = from ? (isNaN(Number(from)) ? new Date(from).getTime() : Number(from)) : 0;
    const toMs = to ? (isNaN(Number(to)) ? new Date(to).getTime() : Number(to)) : Date.now();

    const { rows } = await pool.query(
      `SELECT
         COUNT(*) AS total_invoices,
         COALESCE(SUM(total_amount), 0) AS total_revenue,
         COALESCE(SUM(paid_amount), 0) AS total_collected,
         COALESCE(SUM(total_amount) - SUM(paid_amount), 0) AS total_pending,
         COALESCE(SUM(CASE WHEN status = 'paid' THEN total_amount ELSE 0 END), 0) AS paid_total,
         COALESCE(SUM(CASE WHEN status = 'unpaid' THEN total_amount ELSE 0 END), 0) AS unpaid_total,
         COALESCE(SUM(CASE WHEN status = 'partial' THEN total_amount ELSE 0 END), 0) AS partial_total,
         COUNT(CASE WHEN status = 'paid' THEN 1 END) AS paid_count,
         COUNT(CASE WHEN status = 'unpaid' THEN 1 END) AS unpaid_count,
         COUNT(CASE WHEN status = 'partial' THEN 1 END) AS partial_count
       FROM invoices
       WHERE created_at BETWEEN $1 AND $2`,
      [fromMs, toMs]
    );

    res.json(rows[0] || {});
  } catch (err) {
    console.error("GET /reports/financial-summary error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Daily revenue (last N days)
router.get("/daily-revenue", async (req, res) => {
  try {
    const { days } = req.query;
    const numDays = Math.min(parseInt(days) || 30, 365);
    const fromMs = Date.now() - numDays * 24 * 60 * 60 * 1000;

    const { rows } = await pool.query(
      `SELECT
         to_char(to_timestamp(created_at / 1000.0), 'YYYY-MM-DD') AS day,
         COALESCE(SUM(total_amount), 0) AS total,
         COALESCE(SUM(paid_amount), 0) AS collected,
         COUNT(*) AS invoice_count
       FROM invoices
       WHERE created_at >= $1
       GROUP BY day
       ORDER BY day ASC`,
      [fromMs]
    );

    res.json(rows);
  } catch (err) {
    console.error("GET /reports/daily-revenue error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Payment methods report
router.get("/payment-methods", async (req, res) => {
  try {
    const { from, to } = req.query;
    const fromMs = from ? (isNaN(Number(from)) ? new Date(from).getTime() : Number(from)) : 0;
    const toMs = to ? (isNaN(Number(to)) ? new Date(to).getTime() : Number(to)) : Date.now();

    const { rows } = await pool.query(
      `SELECT
         payment_method,
         COUNT(*) AS count,
         COALESCE(SUM(total_amount), 0) AS total,
         COALESCE(SUM(paid_amount), 0) AS collected
       FROM invoices
       WHERE created_at BETWEEN $1 AND $2
       GROUP BY payment_method
       ORDER BY total DESC`,
      [fromMs, toMs]
    );

    res.json(rows);
  } catch (err) {
    console.error("GET /reports/payment-methods error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Top services by revenue
router.get("/top-services", async (req, res) => {
  try {
    const { from, to } = req.query;
    const fromMs = from ? (isNaN(Number(from)) ? new Date(from).getTime() : Number(from)) : 0;
    const toMs = to ? (isNaN(Number(to)) ? new Date(to).getTime() : Number(to)) : Date.now();

    const { rows } = await pool.query(
      `SELECT
         item->>'description' AS service_name,
         COUNT(*) AS count,
         COALESCE(SUM((item->>'price')::numeric), 0) AS total
       FROM invoices,
            jsonb_array_elements(items) AS item
       WHERE items IS NOT NULL AND jsonb_typeof(items) = 'array'
         AND created_at BETWEEN $1 AND $2
       GROUP BY service_name
       ORDER BY total DESC
       LIMIT 20`,
      [fromMs, toMs]
    );

    res.json(rows);
  } catch (err) {
    console.error("GET /reports/top-services error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
