import express from "express";
import pool from "../db.js";
import { auth } from "../middleware/auth.js";

const router = express.Router();
router.use(auth);

/** Map a DB row to frontend-compatible Device shape */
function mapDeviceRow(row) {
  return {
    id: row.id,
    clientId: row.client_id,
    clinicId: String(row.clinic_id),
    name: row.name,
    type: row.type,
    connectionType: row.connection_type,
    ipAddress: row.ip_address || undefined,
    port: row.port || undefined,
    comPort: row.com_port || undefined,
    baudRate: row.baud_rate || undefined,
    config: row.config || {},
    isActive: row.is_active,
    lastSeenAt: row.last_seen_at
      ? new Date(row.last_seen_at).toISOString()
      : undefined,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/**
 * GET /devices
 * List all devices for the current client
 * Optional query: ?clinicId=X
 */
router.get("/", async (req, res) => {
  try {
    const { client_id } = req.user;
    if (!client_id) {
      return res.status(400).json({ error: "client_id required" });
    }

    const { clinicId } = req.query;

    let query, params;
    if (clinicId) {
      query = `SELECT * FROM devices WHERE client_id=$1 AND clinic_id=$2 AND is_active=true ORDER BY name`;
      params = [client_id, parseInt(clinicId)];
    } else {
      query = `SELECT * FROM devices WHERE client_id=$1 ORDER BY created_at DESC`;
      params = [client_id];
    }

    const { rows } = await pool.query(query, params);
    res.json(rows.map(mapDeviceRow));
  } catch (err) {
    console.error("GET /devices error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /devices
 * Create a new device
 * Admin only
 */
router.post("/", async (req, res) => {
  try {
    const { role, client_id } = req.user;
    if (!["admin", "super_admin"].includes(role)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    if (!client_id) {
      return res.status(400).json({ error: "client_id required" });
    }

    const {
      clinicId, clinic_id: bodyClinicId,
      name, type, connectionType, connection_type,
      ipAddress, ip_address,
      port, comPort, com_port,
      baudRate, baud_rate,
      config, isActive, is_active,
    } = req.body;

    const cId = clinicId || bodyClinicId;
    const connType = connectionType || connection_type;
    const ip = ipAddress || ip_address || null;
    const comP = comPort || com_port || null;
    const baud = baudRate || baud_rate || null;
    const active = isActive !== undefined ? isActive : (is_active !== undefined ? is_active : true);

    if (!name || !type || !connType || !cId) {
      return res
        .status(400)
        .json({ error: "name, type, connectionType, clinicId required" });
    }

    const { rows } = await pool.query(
      `INSERT INTO devices (client_id, clinic_id, name, type, connection_type, ip_address, port, com_port, baud_rate, config, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
       RETURNING *`,
      [
        client_id, parseInt(cId), name, type, connType,
        ip, port || null, comP, baud,
        JSON.stringify(config || {}), active,
      ]
    );

    res.status(201).json(mapDeviceRow(rows[0]));
  } catch (err) {
    console.error("POST /devices error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * PUT /devices/:id
 * Update device fields
 * Admin only
 */
router.put("/:id", async (req, res) => {
  try {
    const { role, client_id } = req.user;
    if (!["admin", "super_admin"].includes(role)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const deviceId = req.params.id;
    const {
      name, type, connectionType, connection_type,
      ipAddress, ip_address,
      port, comPort, com_port,
      baudRate, baud_rate,
      isActive, is_active,
    } = req.body;

    const sets = ["updated_at=NOW()"];
    const params = [];
    let idx = 1;

    if (name !== undefined) { sets.push(`name=$${idx++}`); params.push(name); }
    if (type !== undefined) { sets.push(`type=$${idx++}`); params.push(type); }

    const connType = connectionType || connection_type;
    if (connType !== undefined) { sets.push(`connection_type=$${idx++}`); params.push(connType); }

    const ip = ipAddress !== undefined ? ipAddress : ip_address;
    if (ip !== undefined) { sets.push(`ip_address=$${idx++}`); params.push(ip); }

    if (port !== undefined) { sets.push(`port=$${idx++}`); params.push(port); }

    const comP = comPort !== undefined ? comPort : com_port;
    if (comP !== undefined) { sets.push(`com_port=$${idx++}`); params.push(comP); }

    const baud = baudRate !== undefined ? baudRate : baud_rate;
    if (baud !== undefined) { sets.push(`baud_rate=$${idx++}`); params.push(baud); }

    const active = isActive !== undefined ? isActive : is_active;
    if (active !== undefined) { sets.push(`is_active=$${idx++}`); params.push(active); }

    params.push(deviceId);
    let whereClause = `id=$${idx++}::uuid`;
    if (client_id) {
      params.push(client_id);
      whereClause += ` AND client_id=$${idx++}`;
    }

    await pool.query(
      `UPDATE devices SET ${sets.join(", ")} WHERE ${whereClause}`,
      params
    );

    res.json({ success: true });
  } catch (err) {
    console.error("PUT /devices/:id error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * PUT /devices/:id/last-seen
 * Update device last_seen_at timestamp
 */
router.put("/:id/last-seen", async (req, res) => {
  try {
    const { client_id } = req.user;
    const deviceId = req.params.id;

    const query = client_id
      ? "UPDATE devices SET last_seen_at=NOW() WHERE id=$1::uuid AND client_id=$2"
      : "UPDATE devices SET last_seen_at=NOW() WHERE id=$1::uuid";
    const params = client_id ? [deviceId, client_id] : [deviceId];

    await pool.query(query, params);
    res.json({ success: true });
  } catch (err) {
    console.error("PUT /devices/:id/last-seen error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * DELETE /devices/:id
 * Delete a device
 * Admin only
 */
router.delete("/:id", async (req, res) => {
  try {
    const { role, client_id } = req.user;
    if (!["admin", "super_admin"].includes(role)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const deviceId = req.params.id;
    const query = client_id
      ? "DELETE FROM devices WHERE id=$1::uuid AND client_id=$2"
      : "DELETE FROM devices WHERE id=$1::uuid";
    const params = client_id ? [deviceId, client_id] : [deviceId];

    await pool.query(query, params);
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE /devices/:id error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
