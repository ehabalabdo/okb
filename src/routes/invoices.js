import express from "express";
import pool from "../db.js";
import { auth } from "../middleware/auth.js";

const router = express.Router();
router.use(auth);

// Only staff can access invoices
function requireStaffRole(req, res, next) {
  const allowedRoles = ["admin", "doctor", "secretary", "accountant", "senior_accountant"];
  if (!allowedRoles.includes(req.user.role)) {
    return res.status(403).json({ error: "Access denied" });
  }
  next();
}
router.use(requireStaffRole);

/** Map a DB row to frontend-compatible Invoice shape */
function mapInvoiceRow(row) {
  return {
    id: row.id,
    visitId: row.visit_id,
    patientId: row.patient_id,
    patientName: row.patient_name,
    items: (() => { try { return typeof row.items === "string" ? JSON.parse(row.items) : (row.items || []); } catch { return []; } })(),
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

/**
 * GET /invoices
 * List all invoices
 * For senior_accountant: apply overlays from invoice_overrides
 */
router.get("/", async (req, res) => {
  try {
    const { role } = req.user;
    const { rows } = await pool.query("SELECT * FROM invoices ORDER BY created_at DESC");
    let invoices = rows.map(mapInvoiceRow);

    // For senior_accountant: apply overlay (edited/deleted invoices)
    if (role === "senior_accountant") {
      const { rows: overrides } = await pool.query("SELECT * FROM invoice_overrides");
      const overrideMap = {};
      for (const ov of overrides) {
        overrideMap[ov.invoice_id] = ov;
      }
      invoices = invoices
        .filter(inv => !overrideMap[inv.id]?.is_deleted)
        .map(inv => {
          const ov = overrideMap[inv.id];
          if (ov && ov.override_data) {
            const data = typeof ov.override_data === "string" ? JSON.parse(ov.override_data) : ov.override_data;
            return { ...inv, ...data };
          }
          return inv;
        });
    }

    res.json(invoices);
  } catch (err) {
    console.error("GET /invoices error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /invoices
 * Create a new invoice
 */
router.post("/", async (req, res) => {
  try {
    const { role } = req.user;
    if (!["admin", "receptionist", "secretary", "doctor"].includes(role)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const {
      id, visitId, visit_id,
      patientId, patient_id,
      patientName, patient_name,
      items, totalAmount, total_amount,
      paidAmount, paid_amount,
      paymentMethod, payment_method,
      status,
    } = req.body;

    const invoiceId = id || `inv_${Date.now()}`;
    const vId = visitId || visit_id;
    const pId = patientId || patient_id;
    const pName = patientName || patient_name || "";
    const parsedItems = items || [];
    const calculatedTotal = parsedItems.reduce((s, i) => s + (parseFloat(i.price) || 0), 0);
    const total = calculatedTotal || totalAmount || total_amount || 0;
    const paid = paidAmount || paid_amount || 0;
    const method = paymentMethod || payment_method || "cash";

    const now = Date.now();
    const userId = req.user.id || req.user.username || 'system';

    const { rows } = await pool.query(
      `INSERT INTO invoices (
        id, visit_id, patient_id, patient_name, items,
        total_amount, paid_amount, payment_method, status,
        created_at, updated_at, created_by, updated_by
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING *`,
      [
        invoiceId, vId, pId, pName, JSON.stringify(parsedItems),
        total, paid, method, status || "unpaid",
        now, now, userId, userId,
      ]
    );

    res.status(201).json(mapInvoiceRow(rows[0]));
  } catch (err) {
    console.error("POST /invoices error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * PUT /invoices/:id
 * Update invoice fields
 * accountant: blocked (read-only)
 * senior_accountant: writes to invoice_overrides (overlay)
 */
router.put("/:id", async (req, res) => {
  try {
    const { role } = req.user;
    const invoiceId = req.params.id;

    // Accountant is read-only
    if (role === "accountant") {
      return res.status(403).json({ error: "Read-only access" });
    }

    // Senior accountant: save to overlay table instead of real data
    if (role === "senior_accountant") {
      const { items, totalAmount, total_amount, paidAmount, paid_amount, paymentMethod, payment_method, status } = req.body;
      const overrideData = {};
      if (items !== undefined) {
        overrideData.items = items;
        overrideData.totalAmount = items.reduce((s, i) => s + (parseFloat(i.price) || 0), 0);
      }
      const total = totalAmount !== undefined ? totalAmount : total_amount;
      if (total !== undefined && items === undefined) overrideData.totalAmount = total;
      const paid = paidAmount !== undefined ? paidAmount : paid_amount;
      if (paid !== undefined) overrideData.paidAmount = paid;
      const method = paymentMethod !== undefined ? paymentMethod : payment_method;
      if (method !== undefined) overrideData.paymentMethod = method;
      if (status !== undefined) overrideData.status = status;

      const userId = req.user.id || req.user.username || "system";
      await pool.query(
        `INSERT INTO invoice_overrides (invoice_id, override_data, modified_by, updated_at)
         VALUES ($1, $2::jsonb, $3, NOW())
         ON CONFLICT (invoice_id)
         DO UPDATE SET override_data = $2::jsonb, modified_by = $3, updated_at = NOW()`,
        [invoiceId, JSON.stringify(overrideData), userId]
      );
      return res.json({ success: true });
    }

    const {
      items, totalAmount, total_amount,
      paidAmount, paid_amount,
      paymentMethod, payment_method,
      status,
    } = req.body;

    const sets = [];
    const params = [];
    let idx = 1;

    sets.push(`updated_at=$${idx++}`);
    params.push(Date.now());
    sets.push(`updated_by=$${idx++}`);
    params.push(String(req.user.id || req.user.username || 'system'));

    if (items !== undefined) {
      sets.push(`items=$${idx++}::jsonb`);
      params.push(JSON.stringify(items));
      const recalcTotal = items.reduce((s, i) => s + (parseFloat(i.price) || 0), 0);
      sets.push(`total_amount=$${idx++}`);
      params.push(recalcTotal);

      const { rows: currentRows } = await pool.query(
        `SELECT paid_amount FROM invoices WHERE id=$1`, [invoiceId]
      );
      if (currentRows.length > 0) {
        const currentPaid = parseFloat(currentRows[0].paid_amount) || 0;
        if (currentPaid > recalcTotal) {
          sets.push(`paid_amount=$${idx++}`);
          params.push(recalcTotal);
          sets.push(`status=$${idx++}`);
          params.push('paid');
        } else if (currentPaid > 0 && currentPaid < recalcTotal) {
          sets.push(`status=$${idx++}`);
          params.push('partial');
        } else if (currentPaid === 0) {
          sets.push(`status=$${idx++}`);
          params.push('unpaid');
        } else if (currentPaid >= recalcTotal) {
          sets.push(`status=$${idx++}`);
          params.push('paid');
        }
      }
    }

    const total = totalAmount !== undefined ? totalAmount : total_amount;
    if (total !== undefined && items === undefined) {
      sets.push(`total_amount=$${idx++}`);
      params.push(total);
    }

    const paid = paidAmount !== undefined ? paidAmount : paid_amount;
    if (paid !== undefined) {
      sets.push(`paid_amount=$${idx++}`);
      params.push(paid);
    }

    const method = paymentMethod !== undefined ? paymentMethod : payment_method;
    if (method !== undefined) {
      sets.push(`payment_method=$${idx++}`);
      params.push(method);
    }

    if (status !== undefined) {
      sets.push(`status=$${idx++}`);
      params.push(status);
    }

    params.push(invoiceId);
    const whereClause = `id=$${idx++}`;

    await pool.query(
      `UPDATE invoices SET ${sets.join(", ")} WHERE ${whereClause}`,
      params
    );

    res.json({ success: true });
  } catch (err) {
    console.error("PUT /invoices/:id error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * DELETE /invoices/:id
 * Delete an invoice
 * accountant: blocked
 * senior_accountant: marks as deleted in overlay only
 */
router.delete("/:id", async (req, res) => {
  try {
    const { role } = req.user;

    if (role === "accountant") {
      return res.status(403).json({ error: "Read-only access" });
    }

    // Senior accountant: overlay delete
    if (role === "senior_accountant") {
      const invoiceId = req.params.id;
      const userId = req.user.id || req.user.username || "system";
      await pool.query(
        `INSERT INTO invoice_overrides (invoice_id, is_deleted, modified_by, updated_at)
         VALUES ($1, true, $2, NOW())
         ON CONFLICT (invoice_id)
         DO UPDATE SET is_deleted = true, modified_by = $2, updated_at = NOW()`,
        [invoiceId, userId]
      );
      return res.json({ success: true });
    }

    if (role !== "admin") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const invoiceId = req.params.id;

    // Get the invoice to find visit_id and patient_id
    const { rows: invRows } = await pool.query(
      "SELECT visit_id, patient_id FROM invoices WHERE id=$1",
      [invoiceId]
    );

    if (invRows.length > 0 && invRows[0].visit_id && invRows[0].patient_id) {
      const { visit_id, patient_id } = invRows[0];

      // Remove the visit from patient's history array
      const { rows: patRows } = await pool.query(
        "SELECT history FROM patients WHERE id=$1", [patient_id]
      );
      if (patRows.length > 0 && patRows[0].history) {
        let history = patRows[0].history;
        if (typeof history === "string") {
          try { history = JSON.parse(history); } catch { history = []; }
        }
        if (Array.isArray(history)) {
          const filtered = history.filter(v => v.visitId !== visit_id);
          if (filtered.length !== history.length) {
            await pool.query(
              "UPDATE patients SET history=$1::jsonb WHERE id=$2",
              [JSON.stringify(filtered), patient_id]
            );
          }
        }
      }
    }

    // Delete the invoice
    await pool.query("DELETE FROM invoices WHERE id=$1", [invoiceId]);
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /invoices/:id error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
