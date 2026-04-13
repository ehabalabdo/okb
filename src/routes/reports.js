import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth.js";

const app = new Hono();
app.use("*", authMiddleware);

// Only admin / doctor / secretary
app.use("*", async (c, next) => {
  const user = c.get("user");
  if (!["admin", "doctor", "secretary"].includes(user.role)) return c.json({ error: "Access denied" }, 403);
  return next();
});

app.get("/doctor-load", async (c) => {
  try {
    const from = c.req.query("from");
    const to = c.req.query("to");
    if (!from || !to) return c.json({ error: "from and to query params required" }, 400);

    const fromMs = isNaN(Number(from)) ? new Date(from).getTime() : Number(from);
    const toMs = isNaN(Number(to)) ? new Date(to).getTime() : Number(to);

    const { results } = await c.env.DB.prepare(
      `SELECT u.name AS doctor, COUNT(a.id) AS total
       FROM appointments a
       JOIN users u ON a.doctor_id = u.uid
       WHERE a.date BETWEEN ? AND ?
       GROUP BY u.name
       ORDER BY total DESC`
    ).bind(fromMs, toMs).all();

    return c.json(results);
  } catch (err) {
    console.error("GET /reports/doctor-load error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.get("/cancellations", async (c) => {
  try {
    const from = c.req.query("from");
    const to = c.req.query("to");
    if (!from || !to) return c.json({ error: "from and to query params required" }, 400);

    const fromMs = isNaN(Number(from)) ? new Date(from).getTime() : Number(from);
    const toMs = isNaN(Number(to)) ? new Date(to).getTime() : Number(to);

    const { results } = await c.env.DB.prepare(
      `SELECT status, COUNT(*) AS total
       FROM appointments
       WHERE status IN ('cancelled','no_show')
         AND date BETWEEN ? AND ?
       GROUP BY status`
    ).bind(fromMs, toMs).all();

    return c.json(results);
  } catch (err) {
    console.error("GET /reports/cancellations error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.get("/peak-hours", async (c) => {
  try {
    const from = c.req.query("from");
    const to = c.req.query("to");
    if (!from || !to) return c.json({ error: "from and to query params required" }, 400);

    const fromMs = isNaN(Number(from)) ? new Date(from).getTime() : Number(from);
    const toMs = isNaN(Number(to)) ? new Date(to).getTime() : Number(to);

    const { results } = await c.env.DB.prepare(
      `SELECT CAST(strftime('%H', date/1000, 'unixepoch') AS INTEGER) AS hour, COUNT(*) AS total
       FROM appointments
       WHERE date BETWEEN ? AND ?
       GROUP BY hour
       ORDER BY total DESC`
    ).bind(fromMs, toMs).all();

    return c.json(results);
  } catch (err) {
    console.error("GET /reports/peak-hours error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.get("/financial-summary", async (c) => {
  try {
    const from = c.req.query("from");
    const to = c.req.query("to");
    const fromMs = from ? (isNaN(Number(from)) ? new Date(from).getTime() : Number(from)) : 0;
    const toMs = to ? (isNaN(Number(to)) ? new Date(to).getTime() : Number(to)) : Date.now();

    const row = await c.env.DB.prepare(
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
       WHERE created_at BETWEEN ? AND ?`
    ).bind(fromMs, toMs).first();

    return c.json(row || {});
  } catch (err) {
    console.error("GET /reports/financial-summary error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.get("/daily-revenue", async (c) => {
  try {
    const days = c.req.query("days");
    const numDays = Math.min(parseInt(days) || 30, 365);
    const fromMs = Date.now() - numDays * 24 * 60 * 60 * 1000;

    const { results } = await c.env.DB.prepare(
      `SELECT
         strftime('%Y-%m-%d', created_at/1000, 'unixepoch') AS day,
         COALESCE(SUM(total_amount), 0) AS total,
         COALESCE(SUM(paid_amount), 0) AS collected,
         COUNT(*) AS invoice_count
       FROM invoices
       WHERE created_at >= ?
       GROUP BY day
       ORDER BY day ASC`
    ).bind(fromMs).all();

    return c.json(results);
  } catch (err) {
    console.error("GET /reports/daily-revenue error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.get("/payment-methods", async (c) => {
  try {
    const from = c.req.query("from");
    const to = c.req.query("to");
    const fromMs = from ? (isNaN(Number(from)) ? new Date(from).getTime() : Number(from)) : 0;
    const toMs = to ? (isNaN(Number(to)) ? new Date(to).getTime() : Number(to)) : Date.now();

    const { results } = await c.env.DB.prepare(
      `SELECT payment_method, COUNT(*) AS count, COALESCE(SUM(total_amount), 0) AS total, COALESCE(SUM(paid_amount), 0) AS collected
       FROM invoices WHERE created_at BETWEEN ? AND ? GROUP BY payment_method ORDER BY total DESC`
    ).bind(fromMs, toMs).all();

    return c.json(results);
  } catch (err) {
    console.error("GET /reports/payment-methods error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.get("/top-services", async (c) => {
  try {
    const from = c.req.query("from");
    const to = c.req.query("to");
    const fromMs = from ? (isNaN(Number(from)) ? new Date(from).getTime() : Number(from)) : 0;
    const toMs = to ? (isNaN(Number(to)) ? new Date(to).getTime() : Number(to)) : Date.now();

    const { results } = await c.env.DB.prepare(
      `SELECT json_extract(j.value, '$.description') AS service_name,
              COUNT(*) AS count,
              COALESCE(SUM(CAST(json_extract(j.value, '$.price') AS REAL)), 0) AS total
       FROM invoices, json_each(items) AS j
       WHERE items IS NOT NULL AND json_type(items) = 'array'
         AND created_at BETWEEN ? AND ?
       GROUP BY service_name
       ORDER BY total DESC LIMIT 20`
    ).bind(fromMs, toMs).all();

    return c.json(results);
  } catch (err) {
    console.error("GET /reports/top-services error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

export default app;
