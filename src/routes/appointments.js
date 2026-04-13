import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth.js";

const app = new Hono();
app.use("*", authMiddleware);

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

function todayRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return { start, end: start + 86400000 };
}

function weekRange() {
  const { start } = todayRange();
  return { start, end: start + 7 * 86400000 };
}

app.get("/", async (c) => {
  try {
    const { results } = await c.env.DB.prepare("SELECT * FROM appointments ORDER BY date DESC").all();
    return c.json(results.map(mapAppointmentRow));
  } catch (err) {
    console.error("GET /appointments error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.get("/by-patient/:patientId", async (c) => {
  try {
    const { results } = await c.env.DB.prepare(
      "SELECT * FROM appointments WHERE patient_id=? ORDER BY date DESC"
    ).bind(c.req.param("patientId")).all();
    return c.json(results.map(mapAppointmentRow));
  } catch (err) {
    console.error("GET /appointments/by-patient error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.get("/today", async (c) => {
  try {
    const user = c.get("user");
    const { start, end } = todayRange();
    const db = c.env.DB;

    if (user.role === "doctor") {
      const { results } = await db.prepare(
        "SELECT * FROM appointments WHERE doctor_id=? AND date >= ? AND date < ? ORDER BY date"
      ).bind(user.uid, start, end).all();
      return c.json(results.map(mapAppointmentRow));
    }

    if (["admin", "receptionist", "secretary"].includes(user.role)) {
      const { results } = await db.prepare(
        "SELECT * FROM appointments WHERE date >= ? AND date < ? ORDER BY date"
      ).bind(start, end).all();
      return c.json(results.map(mapAppointmentRow));
    }

    return c.json({ error: "Forbidden" }, 403);
  } catch (err) {
    console.error("GET /appointments/today error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.get("/week", async (c) => {
  try {
    const user = c.get("user");
    const { start, end } = weekRange();
    const db = c.env.DB;

    if (user.role === "doctor") {
      const { results } = await db.prepare(
        "SELECT * FROM appointments WHERE doctor_id=? AND date >= ? AND date < ? ORDER BY date"
      ).bind(user.uid, start, end).all();
      return c.json(results.map(mapAppointmentRow));
    }

    const { results } = await db.prepare(
      "SELECT * FROM appointments WHERE date >= ? AND date < ? ORDER BY date"
    ).bind(start, end).all();
    return c.json(results.map(mapAppointmentRow));
  } catch (err) {
    console.error("GET /appointments/week error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.get("/day", async (c) => {
  try {
    const date = c.req.query("date");
    if (!date) return c.json({ error: "date required" }, 400);

    const user = c.get("user");
    const dayStart = new Date(date + "T00:00:00").getTime();
    const dayEnd = dayStart + 86400000;
    const db = c.env.DB;

    if (user.role === "doctor") {
      const { results } = await db.prepare(
        "SELECT * FROM appointments WHERE doctor_id=? AND date >= ? AND date < ? ORDER BY date"
      ).bind(user.uid, dayStart, dayEnd).all();
      return c.json(results.map(mapAppointmentRow));
    }

    const { results } = await db.prepare(
      "SELECT * FROM appointments WHERE date >= ? AND date < ? ORDER BY date"
    ).bind(dayStart, dayEnd).all();
    return c.json(results.map(mapAppointmentRow));
  } catch (err) {
    console.error("GET /appointments/day error:", err);
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
    const pId = String(body.patient_id || body.patientId || "");
    const dId = (body.doctor_id || body.doctorId) ? String(body.doctor_id || body.doctorId) : null;
    const cId = String(body.clinic_id || body.clinicId || "");
    const pName = body.patient_name || body.patientName || "";

    let dateEpoch;
    if (body.date !== undefined) {
      dateEpoch = typeof body.date === "number" ? body.date : new Date(body.date).getTime();
    } else if (body.start_time) {
      dateEpoch = new Date(body.start_time).getTime();
    }

    if (!pId || !dateEpoch) return c.json({ error: "patient_id and date required" }, 400);

    const appointmentId = "apt_" + Date.now();
    const now = Date.now();
    const userId = user.uid || "system";

    await c.env.DB.prepare(
      `INSERT INTO appointments (id, patient_id, patient_name, clinic_id, doctor_id, date, status, reason, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(appointmentId, pId, pName, cId, dId, dateEpoch, body.status || "scheduled", body.reason || "", now, userId, now, userId).run();

    const row = await c.env.DB.prepare("SELECT * FROM appointments WHERE id=?").bind(appointmentId).first();
    return c.json(mapAppointmentRow(row), 201);
  } catch (err) {
    if (err.message?.includes("UNIQUE")) return c.json({ error: "Appointment conflict" }, 409);
    console.error("POST /appointments error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.put("/:id", async (c) => {
  try {
    const user = c.get("user");
    const role = user.role || user.type;
    if (!["admin", "receptionist", "secretary", "doctor"].includes(role)) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const appointmentId = c.req.param("id");
    const body = await c.req.json();
    const now = Date.now();
    const db = c.env.DB;

    const sets = [`updated_at=${now}`];
    const params = [];

    if (body.status !== undefined) { sets.push("status=?"); params.push(body.status); }
    if (body.reason !== undefined) { sets.push("reason=?"); params.push(body.reason); }

    const cId = body.clinic_id || body.clinicId;
    if (cId !== undefined) { sets.push("clinic_id=?"); params.push(String(cId)); }

    const dId = body.doctor_id || body.doctorId;
    if (dId !== undefined) { sets.push("doctor_id=?"); params.push(dId ? String(dId) : null); }

    const dateVal = body.date !== undefined ? body.date : (body.start_time ? new Date(body.start_time).getTime() : undefined);
    if (dateVal !== undefined) {
      sets.push("date=?");
      params.push(typeof dateVal === "number" ? dateVal : new Date(dateVal).getTime());
    }

    sets.push("updated_by=?");
    params.push(user.uid || "system");
    params.push(appointmentId);

    await db.prepare(`UPDATE appointments SET ${sets.join(", ")} WHERE id=?`).bind(...params).run();
    return c.json({ success: true });
  } catch (err) {
    console.error("PUT /appointments/:id error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.put("/:id/status", async (c) => {
  try {
    const user = c.get("user");
    if (!["admin", "doctor", "receptionist", "secretary"].includes(user.role)) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const { status } = await c.req.json();
    await c.env.DB.prepare(
      "UPDATE appointments SET status=?, updated_by=?, updated_at=? WHERE id=?"
    ).bind(status, user.uid, Date.now(), c.req.param("id")).run();

    return c.json({ success: true });
  } catch (err) {
    console.error("PUT /appointments/:id/status error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.delete("/:id", async (c) => {
  try {
    const user = c.get("user");
    if (!["admin", "receptionist", "secretary"].includes(user.role)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    await c.env.DB.prepare("DELETE FROM appointments WHERE id=?").bind(c.req.param("id")).run();
    return c.json({ success: true });
  } catch (err) {
    console.error("DELETE /appointments/:id error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

export default app;
