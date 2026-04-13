import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth.js";

const app = new Hono();
app.use("*", authMiddleware);

// Only staff can access invoices
app.use("*", async (c, next) => {
  const user = c.get("user");
  const allowed = ["admin", "doctor", "secretary", "accountant", "senior_accountant"];
  if (!allowed.includes(user.role)) return c.json({ error: "Access denied" }, 403);
  return next();
});

function mapInvoiceRow(row) {
  let items = [];
  try { items = typeof row.items === "string" ? JSON.parse(row.items) : (row.items || []); } catch { items = []; }
  return {
    id: row.id,
    visitId: row.visit_id,
    patientId: row.patient_id,
    patientName: row.patient_name,
    items,
    totalAmount: parseFloat(row.total_amount),
    paidAmount: parseFloat(row.paid_amount),
    paymentMethod: row.payment_method,
    status: row.status,
    createdAt: row.created_at ? Number(row.created_at) : Date.now(),
    created_at: row.created_at,
    createdBy: row.created_by || "system",
    updatedAt: row.updated_at ? Number(row.updated_at) : Date.now(),
    updatedBy: row.updated_by || "system",
    isArchived: false,
  };
}

app.get("/", async (c) => {
  try {
    const user = c.get("user");
    const db = c.env.DB;
    const { results } = await db.prepare("SELECT * FROM invoices ORDER BY created_at DESC").all();
    let invoices = results.map(mapInvoiceRow);

    if (user.role === "senior_accountant") {
      const { results: overrides } = await db.prepare("SELECT * FROM invoice_overrides").all();
      const overrideMap = {};
      for (const ov of overrides) overrideMap[ov.invoice_id] = ov;

      invoices = invoices
        .filter((inv) => !overrideMap[inv.id]?.is_deleted)
        .map((inv) => {
          const ov = overrideMap[inv.id];
          if (ov && ov.override_data) {
            const data = typeof ov.override_data === "string" ? JSON.parse(ov.override_data) : ov.override_data;
            return { ...inv, ...data };
          }
          return inv;
        });
    }

    return c.json(invoices);
  } catch (err) {
    console.error("GET /invoices error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.post("/", async (c) => {
  try {
    const user = c.get("user");
    if (!["admin", "receptionist", "secretary", "doctor"].includes(user.role)) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const body = await c.req.json();
    const db = c.env.DB;

    const invoiceId = body.id || `inv_${Date.now()}`;
    const vId = body.visitId || body.visit_id;
    const pId = body.patientId || body.patient_id;
    const pName = body.patientName || body.patient_name || "";
    const parsedItems = body.items || [];
    const calculatedTotal = parsedItems.reduce((s, i) => s + (parseFloat(i.price) || 0), 0);
    const total = calculatedTotal || body.totalAmount || body.total_amount || 0;
    const paid = body.paidAmount || body.paid_amount || 0;
    const method = body.paymentMethod || body.payment_method || "cash";
    const now = Date.now();
    const userId = user.id || user.username || "system";

    await db.prepare(
      `INSERT INTO invoices (id, visit_id, patient_id, patient_name, items, total_amount, paid_amount, payment_method, status, created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(invoiceId, vId, pId, pName, JSON.stringify(parsedItems), total, paid, method, body.status || "unpaid", now, now, userId, userId).run();

    const row = await db.prepare("SELECT * FROM invoices WHERE id=?").bind(invoiceId).first();
    return c.json(mapInvoiceRow(row), 201);
  } catch (err) {
    console.error("POST /invoices error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.put("/:id", async (c) => {
  try {
    const user = c.get("user");
    const invoiceId = c.req.param("id");
    const db = c.env.DB;

    if (user.role === "accountant") return c.json({ error: "Read-only access" }, 403);

    const body = await c.req.json();

    // Senior accountant: save to overlay table
    if (user.role === "senior_accountant") {
      const overrideData = {};
      if (body.items !== undefined) {
        overrideData.items = body.items;
        overrideData.totalAmount = body.items.reduce((s, i) => s + (parseFloat(i.price) || 0), 0);
      }
      const total = body.totalAmount !== undefined ? body.totalAmount : body.total_amount;
      if (total !== undefined && body.items === undefined) overrideData.totalAmount = total;
      const paid = body.paidAmount !== undefined ? body.paidAmount : body.paid_amount;
      if (paid !== undefined) overrideData.paidAmount = paid;
      const method = body.paymentMethod !== undefined ? body.paymentMethod : body.payment_method;
      if (method !== undefined) overrideData.paymentMethod = method;
      if (body.status !== undefined) overrideData.status = body.status;

      const userId = user.id || user.username || "system";
      await db.prepare(
        `INSERT INTO invoice_overrides (invoice_id, override_data, modified_by, updated_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT (invoice_id) DO UPDATE SET override_data=excluded.override_data, modified_by=excluded.modified_by, updated_at=datetime('now')`
      ).bind(invoiceId, JSON.stringify(overrideData), userId).run();
      return c.json({ success: true });
    }

    const sets = [];
    const params = [];

    sets.push("updated_at=?"); params.push(Date.now());
    sets.push("updated_by=?"); params.push(String(user.id || user.username || "system"));

    if (body.items !== undefined) {
      sets.push("items=?"); params.push(JSON.stringify(body.items));
      const recalcTotal = body.items.reduce((s, i) => s + (parseFloat(i.price) || 0), 0);
      sets.push("total_amount=?"); params.push(recalcTotal);

      const current = await db.prepare("SELECT paid_amount FROM invoices WHERE id=?").bind(invoiceId).first();
      if (current) {
        const currentPaid = parseFloat(current.paid_amount) || 0;
        if (currentPaid > recalcTotal) { sets.push("paid_amount=?"); params.push(recalcTotal); sets.push("status=?"); params.push("paid"); }
        else if (currentPaid > 0 && currentPaid < recalcTotal) { sets.push("status=?"); params.push("partial"); }
        else if (currentPaid === 0) { sets.push("status=?"); params.push("unpaid"); }
        else if (currentPaid >= recalcTotal) { sets.push("status=?"); params.push("paid"); }
      }
    }

    const total = body.totalAmount !== undefined ? body.totalAmount : body.total_amount;
    if (total !== undefined && body.items === undefined) { sets.push("total_amount=?"); params.push(total); }
    const paid = body.paidAmount !== undefined ? body.paidAmount : body.paid_amount;
    if (paid !== undefined) { sets.push("paid_amount=?"); params.push(paid); }
    const method = body.paymentMethod !== undefined ? body.paymentMethod : body.payment_method;
    if (method !== undefined) { sets.push("payment_method=?"); params.push(method); }
    if (body.status !== undefined) { sets.push("status=?"); params.push(body.status); }

    params.push(invoiceId);
    await db.prepare(`UPDATE invoices SET ${sets.join(", ")} WHERE id=?`).bind(...params).run();
    return c.json({ success: true });
  } catch (err) {
    console.error("PUT /invoices/:id error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.delete("/:id", async (c) => {
  try {
    const user = c.get("user");
    const db = c.env.DB;

    if (user.role === "accountant") return c.json({ error: "Read-only access" }, 403);

    if (user.role === "senior_accountant") {
      const invoiceId = c.req.param("id");
      const userId = user.id || user.username || "system";
      await db.prepare(
        `INSERT INTO invoice_overrides (invoice_id, is_deleted, modified_by, updated_at)
         VALUES (?, 1, ?, datetime('now'))
         ON CONFLICT (invoice_id) DO UPDATE SET is_deleted=1, modified_by=excluded.modified_by, updated_at=datetime('now')`
      ).bind(invoiceId, userId).run();
      return c.json({ success: true });
    }

    if (user.role !== "admin") return c.json({ error: "Forbidden" }, 403);

    const invoiceId = c.req.param("id");

    const inv = await db.prepare("SELECT visit_id, patient_id FROM invoices WHERE id=?").bind(invoiceId).first();
    if (inv && inv.visit_id && inv.patient_id) {
      const pat = await db.prepare("SELECT history FROM patients WHERE id=?").bind(inv.patient_id).first();
      if (pat && pat.history) {
        let history = typeof pat.history === "string" ? JSON.parse(pat.history) : pat.history;
        if (Array.isArray(history)) {
          const filtered = history.filter((v) => v.visitId !== inv.visit_id);
          if (filtered.length !== history.length) {
            await db.prepare("UPDATE patients SET history=? WHERE id=?").bind(JSON.stringify(filtered), inv.patient_id).run();
          }
        }
      }
    }

    await db.prepare("DELETE FROM invoices WHERE id=?").bind(invoiceId).run();
    return c.json({ success: true });
  } catch (err) {
    console.error("DELETE /invoices/:id error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

export default app;
