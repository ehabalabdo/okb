import express from "express";
import pool from "../db.js";
import { auth } from "../middleware/auth.js";

const router = express.Router();
router.use(auth);

// Only staff can access invoices (not patients or HR employees)
function requireStaffRole(req, res, next) {
  const allowedRoles = ["admin", "doctor", "secretary", "super_admin"];
  if (!allowedRoles.includes(req.user.role) && req.user.type !== "super_admin") {
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
 * List all invoices for the current client
 */
router.get("/", async (req, res) => {
  try {
    const { client_id } = req.user;
    const query = client_id
      ? "SELECT * FROM invoices WHERE client_id=$1 ORDER BY created_at DESC"
      : "SELECT * FROM invoices ORDER BY created_at DESC";
    const params = client_id ? [client_id] : [];
    const { rows } = await pool.query(query, params);
    res.json(rows.map(mapInvoiceRow));
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
    const { role, client_id } = req.user;
    if (!["admin", "receptionist", "secretary", "doctor", "super_admin"].includes(role)) {
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
        client_id, created_at, updated_at, created_by, updated_by
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING *`,
      [
        invoiceId, vId, pId, pName, JSON.stringify(parsedItems),
        total, paid, method, status || "unpaid", client_id,
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
 */
router.put("/:id", async (req, res) => {
  try {
    const { client_id } = req.user;
    const invoiceId = req.params.id;

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
      // Auto-recalculate total from items
      const recalcTotal = items.reduce((s, i) => s + (parseFloat(i.price) || 0), 0);
      sets.push(`total_amount=$${idx++}`);
      params.push(recalcTotal);

      // If paid > new total, cap paid_amount and fix status
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
    let whereClause = `id=$${idx++}`;
    if (client_id) {
      params.push(client_id);
      whereClause += ` AND client_id=$${idx++}`;
    }

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
 */
router.delete("/:id", async (req, res) => {
  try {
    const { role, client_id } = req.user;
    if (!["admin", "super_admin"].includes(role)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const invoiceId = req.params.id;

    // 1. Get the invoice to find visit_id and patient_id
    const invQuery = client_id
      ? "SELECT visit_id, patient_id FROM invoices WHERE id=$1 AND client_id=$2"
      : "SELECT visit_id, patient_id FROM invoices WHERE id=$1";
    const invParams = client_id ? [invoiceId, client_id] : [invoiceId];
    const { rows: invRows } = await pool.query(invQuery, invParams);

    if (invRows.length > 0 && invRows[0].visit_id && invRows[0].patient_id) {
      const { visit_id, patient_id } = invRows[0];

      // 2. Remove the visit from patient's history array
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

    // 3. Delete the invoice
    const delQuery = client_id
      ? "DELETE FROM invoices WHERE id=$1 AND client_id=$2"
      : "DELETE FROM invoices WHERE id=$1";
    const delParams = client_id ? [invoiceId, client_id] : [invoiceId];
    await pool.query(delQuery, delParams);

    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /invoices/:id error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
