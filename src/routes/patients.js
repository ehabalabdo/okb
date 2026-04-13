import { Hono } from "hono";
import crypto from "crypto";
import { authMiddleware } from "../middleware/auth.js";
import { hashPassword } from "../utils/password.js";

const app = new Hono();
app.use("*", authMiddleware);

function makeUsername(phone) {
  return `p${String(phone || "").replace(/\D/g, "")}`;
}
function makePassword() {
  return crypto.randomBytes(6).toString("base64url");
}
function calculateAge(dateOfBirth) {
  if (!dateOfBirth) return 0;
  const dob = new Date(dateOfBirth);
  if (isNaN(dob.getTime())) return 0;
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const monthDiff = today.getMonth() - dob.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) age--;
  return age;
}

function mapPatientRow(row) {
  let medicalProfile = row.medical_profile;
  if (typeof medicalProfile === "string") { try { medicalProfile = JSON.parse(medicalProfile); } catch { medicalProfile = {}; } }
  let currentVisit = row.current_visit;
  if (typeof currentVisit === "string") { try { currentVisit = JSON.parse(currentVisit); } catch { currentVisit = null; } }
  let history = row.history;
  if (typeof history === "string") { try { history = JSON.parse(history); } catch { history = []; } }

  const dobStr = row.date_of_birth ? String(row.date_of_birth) : undefined;

  return {
    id: String(row.id),
    name: row.full_name,
    age: dobStr ? calculateAge(dobStr) : (row.age || 0),
    dateOfBirth: dobStr || undefined,
    gender: row.gender || "male",
    phone: row.phone || "",
    username: row.username || undefined,
    email: row.email || undefined,
    hasAccess: row.has_access ? true : false,
    medicalProfile: medicalProfile && Object.keys(medicalProfile).length > 0 ? medicalProfile : {
      allergies: { exists: false, details: "" }, chronicConditions: { exists: false, details: "" },
      currentMedications: { exists: false, details: "" }, isPregnant: false, notes: row.notes || "",
    },
    currentVisit: currentVisit && Object.keys(currentVisit).length > 0 ? currentVisit : {
      visitId: "", clinicId: "", date: Date.now(), status: "", priority: "normal", reasonForVisit: "",
    },
    history: Array.isArray(history) ? history : [],
    createdAt: row.created_at ? Number(row.created_at) : Date.now(),
    createdBy: row.created_by || "system",
    updatedAt: row.updated_at ? Number(row.updated_at) : Date.now(),
    updatedBy: row.updated_by || "system",
    isArchived: row.is_archived || false,
  };
}

app.get("/", async (c) => {
  try {
    const { results } = await c.env.DB.prepare("SELECT * FROM patients ORDER BY id DESC").all();
    return c.json(results.map(mapPatientRow));
  } catch (err) {
    console.error("GET /patients error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.get("/:id", async (c) => {
  try {
    const row = await c.env.DB.prepare("SELECT * FROM patients WHERE id=? LIMIT 1").bind(c.req.param("id")).first();
    if (!row) return c.json({ error: "Patient not found" }, 404);
    return c.json(mapPatientRow(row));
  } catch (err) {
    console.error("GET /patients/:id error:", err);
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
    const patientName = body.full_name || body.name;
    if (!patientName) return c.json({ error: "full_name required" }, 400);

    const db = c.env.DB;
    let finalUsername = body.username || (body.phone ? makeUsername(body.phone) : null);
    let plainPassword = body.password || makePassword();
    let hashedPassword = await hashPassword(plainPassword);

    const dob = body.date_of_birth || body.dateOfBirth || null;
    const age = dob ? calculateAge(dob) : 0;
    const medProfile = body.medical_profile || body.medicalProfile || {};
    const visit = body.current_visit || body.currentVisit || {};
    const hist = body.history || [];
    const access = body.has_access !== undefined ? body.has_access : (body.hasAccess !== undefined ? body.hasAccess : false);

    const patientId = "pat_" + Date.now();
    const now = new Date().toISOString();

    try {
      await db.prepare(
        `INSERT INTO patients (id, full_name, age, date_of_birth, gender, phone, username, email, password, has_access,
          notes, medical_profile, current_visit, history, created_at, updated_at, created_by, updated_by, is_archived)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'system', 'system', 0)`
      ).bind(
        patientId, patientName, age, dob, body.gender || "male", body.phone || "",
        finalUsername, body.email || null, hashedPassword, access ? 1 : 0,
        body.notes || medProfile?.notes || "",
        JSON.stringify(medProfile), JSON.stringify(visit), JSON.stringify(hist), now, now
      ).run();

      return c.json({
        patient: mapPatientRow({ id: patientId, full_name: patientName, medical_profile: medProfile, current_visit: visit, history: hist }),
        credentials: { username: finalUsername, password: plainPassword },
      }, 201);
    } catch (err) {
      if (err.message?.includes("UNIQUE") && finalUsername) {
        finalUsername = finalUsername + "-" + Math.floor(1000 + Math.random() * 9000);
        plainPassword = makePassword();
        hashedPassword = await hashPassword(plainPassword);
        const retryId = "pat_" + Date.now() + "_" + Math.floor(Math.random() * 1000);

        await db.prepare(
          `INSERT INTO patients (id, full_name, age, date_of_birth, gender, phone, username, email, password, has_access,
            notes, medical_profile, current_visit, history, created_at, updated_at, created_by, updated_by, is_archived)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'system', 'system', 0)`
        ).bind(
          retryId, patientName, age, dob, body.gender || "male", body.phone || "",
          finalUsername, body.email || null, hashedPassword, access ? 1 : 0,
          body.notes || medProfile?.notes || "",
          JSON.stringify(medProfile), JSON.stringify(visit), JSON.stringify(hist), now, now
        ).run();

        return c.json({
          patient: { id: retryId, full_name: patientName, phone: body.phone, username: finalUsername },
          credentials: { username: finalUsername, password: plainPassword },
        }, 201);
      }
      throw err;
    }
  } catch (err) {
    console.error("POST /patients error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.put("/:id", async (c) => {
  try {
    const patientId = c.req.param("id");
    const body = await c.req.json();
    const db = c.env.DB;

    const sets = ["updated_at=datetime('now')"];
    const params = [];

    const patientName = body.full_name || body.name;
    if (patientName !== undefined) { sets.push("full_name=?"); params.push(patientName); }

    const dob = body.date_of_birth || body.dateOfBirth;
    if (dob !== undefined) {
      sets.push("date_of_birth=?"); params.push(dob);
      sets.push("age=?"); params.push(calculateAge(dob));
    } else if (body.age !== undefined) {
      sets.push("age=?"); params.push(body.age);
    }

    if (body.gender !== undefined) { sets.push("gender=?"); params.push(body.gender); }
    if (body.phone !== undefined) { sets.push("phone=?"); params.push(body.phone); }
    if (body.username !== undefined) { sets.push("username=?"); params.push(body.username || null); }
    if (body.email !== undefined) { sets.push("email=?"); params.push(body.email || null); }
    if (body.password !== undefined && body.password !== "") {
      const hashed = await hashPassword(body.password);
      sets.push("password=?"); params.push(hashed);
    }

    const accessValue = body.has_access !== undefined ? body.has_access : body.hasAccess;
    if (accessValue !== undefined) { sets.push("has_access=?"); params.push(accessValue ? 1 : 0); }

    const medProfile = body.medical_profile || body.medicalProfile;
    if (medProfile !== undefined) { sets.push("medical_profile=?"); params.push(JSON.stringify(medProfile)); }

    const visit = body.current_visit || body.currentVisit;
    if (visit !== undefined) { sets.push("current_visit=?"); params.push(JSON.stringify(visit)); }

    if (body.history !== undefined) { sets.push("history=?"); params.push(JSON.stringify(body.history)); }

    params.push(patientId);
    await db.prepare(`UPDATE patients SET ${sets.join(", ")} WHERE id=?`).bind(...params).run();

    return c.json({ success: true });
  } catch (err) {
    console.error("PUT /patients/:id error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.delete("/:id", async (c) => {
  try {
    const user = c.get("user");
    if (user.role !== "admin") return c.json({ error: "Forbidden" }, 403);
    await c.env.DB.prepare("DELETE FROM patients WHERE id=?").bind(c.req.param("id")).run();
    return c.json({ success: true });
  } catch (err) {
    console.error("DELETE /patients/:id error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

export default app;
