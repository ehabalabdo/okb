import { Hono } from "hono";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import PDFDocument from "pdfkit";
import { authMiddleware } from "../middleware/auth.js";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";

const app = new Hono();

// ============================================================
//  PDF route BEFORE global auth — handles its own token via header
// ============================================================

app.get("/payslips/:id/pdf", async (c) => {
  try {
    const header = c.req.header("Authorization");
    const token = header && header.startsWith("Bearer ") ? header.split(" ")[1] : null;
    if (!token) return c.json({ error: "No token provided" }, 401);

    let decoded;
    try {
      decoded = jwt.verify(token, c.env.JWT_SECRET);
    } catch {
      return c.json({ error: "Invalid token" }, 401);
    }

    const { role, type, hr_employee_id } = decoded;
    const id = c.req.param("id");
    const db = c.env.DB;

    if (role !== "admin" && type !== "hr_employee") {
      return c.json({ error: "Forbidden" }, 403);
    }

    const row = await db.prepare(
      `SELECT p.*, e.full_name AS employee_name, e.department, e.job_title
       FROM hr_payslips p
       JOIN hr_employees e ON e.id = p.employee_id
       WHERE p.id=?`
    ).bind(id).first();

    if (!row) return c.json({ error: "Payslip not found" }, 404);

    if (type === "hr_employee" && row.employee_id !== hr_employee_id) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const clientName = '\u0645\u0631\u0643\u0632 \u062f. \u0637\u0627\u0631\u0642 \u062e\u0631\u064a\u0633';
    const monthDate = new Date(row.month);
    const monthLabel = monthDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long' });

    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    const pdfPromise = new Promise(resolve => doc.on('end', () => resolve(Buffer.concat(chunks))));

    const num = (v) => parseFloat(v) || 0;
    const p = row;
    const basicSalary = num(p.basic_salary);
    const employeeSs = num(p.employee_ss);
    const employerSs = num(p.employer_ss);
    const lateAmount = num(p.final_late_amount);
    const absenceAmount = num(p.final_absence_amount);
    const overtimeAmount = num(p.final_overtime_amount) * num(p.overtime_multiplier);
    const manualDeductions = num(p.manual_deductions_total);
    const netSalary = num(p.net_salary);

    // Header
    doc.fontSize(20).font('Helvetica-Bold').text(clientName.toUpperCase(), { align: 'center' });
    doc.fontSize(10).font('Helvetica').text('Payslip / Salary Statement', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(12).font('Helvetica-Bold').text(monthLabel, { align: 'center' });
    doc.moveDown(1);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#cccccc');
    doc.moveDown(0.5);

    // Employee Info
    doc.fontSize(11).font('Helvetica-Bold').text('Employee Information', { underline: true });
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(10);
    const infoY = doc.y;
    doc.text(`Name: ${p.employee_name}`, 50, infoY);
    doc.text(`Department: ${p.department || '-'}`, 300, infoY);
    doc.text(`Job Title: ${p.job_title || '-'}`, 50, infoY + 18);
    doc.text(`Status: ${(p.status || 'draft').toUpperCase()}`, 300, infoY + 18);
    doc.moveDown(2.5);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#cccccc');
    doc.moveDown(0.5);

    // Attendance Summary
    doc.fontSize(11).font('Helvetica-Bold').text('Attendance Summary', { underline: true });
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(10);
    const attY = doc.y;
    doc.text(`Days Worked: ${p.days_worked || 0}`, 50, attY);
    doc.text(`Absent Days: ${p.suggested_absent_days || 0}`, 200, attY);
    doc.text(`Late Minutes: ${p.suggested_late_minutes || 0}`, 350, attY);
    doc.text(`OT Minutes: ${p.suggested_overtime_minutes || 0}`, 50, attY + 18);
    doc.text(`Break Minutes: ${p.total_break_minutes || 0}`, 200, attY + 18);
    doc.moveDown(2.5);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#cccccc');
    doc.moveDown(0.5);

    // Financial Breakdown
    doc.fontSize(11).font('Helvetica-Bold').text('Financial Breakdown', { underline: true });
    doc.moveDown(0.5);

    const tableX = 60;
    const valX = 420;
    let rowY = doc.y;
    const rowH = 22;

    function drawRow(label, value, bold, color) {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10);
      if (color) doc.fillColor(color);
      doc.text(label, tableX, rowY);
      doc.text(value, valX, rowY, { align: 'right', width: 100 });
      doc.fillColor('#000000');
      rowY += rowH;
    }

    doc.rect(tableX - 5, rowY - 3, 480, rowH).fill('#f1f5f9');
    doc.fillColor('#000000');
    drawRow('Description', 'Amount (JOD)', true);
    drawRow('Basic Salary', basicSalary.toFixed(2), false);
    drawRow('Social Security (Employee 7.5%)', `- ${employeeSs.toFixed(2)}`, false, '#dc2626');
    drawRow('Social Security (Employer 14.25%)', employerSs.toFixed(2), false, '#6b7280');
    doc.moveTo(tableX, rowY - 5).lineTo(tableX + 470, rowY - 5).stroke('#e2e8f0');
    if (lateAmount > 0) drawRow('Late Deduction', `- ${lateAmount.toFixed(2)}`, false, '#dc2626');
    if (absenceAmount > 0) drawRow('Absence Deduction', `- ${absenceAmount.toFixed(2)}`, false, '#dc2626');
    if (manualDeductions > 0) drawRow('Manual Deductions', `- ${manualDeductions.toFixed(2)}`, false, '#dc2626');
    if (overtimeAmount > 0) drawRow('Overtime Bonus', `+ ${overtimeAmount.toFixed(2)}`, false, '#059669');
    doc.moveTo(tableX, rowY - 3).lineTo(tableX + 470, rowY - 3).stroke('#334155');
    doc.moveTo(tableX, rowY - 1).lineTo(tableX + 470, rowY - 1).stroke('#334155');
    rowY += 4;

    doc.rect(tableX - 5, rowY - 3, 480, rowH + 6).fill('#f0fdf4');
    doc.fillColor('#059669');
    doc.font('Helvetica-Bold').fontSize(13);
    doc.text('Net Salary', tableX, rowY + 2);
    doc.text(`${netSalary.toFixed(2)} JOD`, valX - 20, rowY + 2, { align: 'right', width: 120 });
    doc.fillColor('#000000');

    doc.fontSize(8).font('Helvetica').fillColor('#94a3b8');
    doc.text(`Generated by MED LOOP HR System \u2014 ${new Date().toISOString().slice(0, 10)}`, 50, 770, { align: 'center' });
    doc.end();

    const pdfBuffer = await pdfPromise;
    return new Response(pdfBuffer, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="payslip-${id}-${monthLabel.replace(/\s/g, '-')}.pdf"`,
      },
    });
  } catch (err) {
    console.error("GET /hr/payslips/:id/pdf error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

// Global auth for all other routes
app.use("*", authMiddleware);

// ============================================================
//  CONSTANTS / HELPERS
// ============================================================

const RP_NAME = "TKC HR";

const ALLOWED_ORIGINS = [
  "https://okf-nine.vercel.app",
  "https://tkc-clinic.netlify.app",
  "https://med.loopjo.com",
  "https://tkc-frontend.pages.dev",
];

function rpConfig(c) {
  const origin = c.req.header("origin");
  if (origin && origin.startsWith("http://localhost")) {
    const url = new URL(origin);
    return { rpID: url.hostname, rpName: RP_NAME, origin };
  }
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    const url = new URL(origin);
    return { rpID: url.hostname, rpName: RP_NAME, origin };
  }
  if (origin && origin.endsWith(".tkc-frontend.pages.dev")) {
    const url = new URL(origin);
    return { rpID: url.hostname, rpName: RP_NAME, origin };
  }
  const fallbackUrl = new URL(ALLOWED_ORIGINS[0]);
  return { rpID: fallbackUrl.hostname, rpName: RP_NAME, origin: ALLOWED_ORIGINS[0] };
}

function haversineMetres(lat1, lng1, lat2, lng2) {
  const R = 6_371_000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function requireAdmin(c) {
  if (c.get("user").role !== "admin") return false;
  return true;
}

function requireHrEmployee(c) {
  if (c.get("user").type !== "hr_employee") return false;
  return true;
}

async function validateGeoFence(db, latitude, longitude) {
  const { results } = await db.prepare(
    `SELECT id, name, latitude, longitude, allowed_radius_meters
     FROM clinics WHERE latitude IS NOT NULL AND longitude IS NOT NULL`
  ).all();
  if (!results.length) {
    return { ok: false, error: "NO_CLINIC_LOCATION", message: "No clinic location configured. Ask admin to set clinic location." };
  }
  for (const clinic of results) {
    const dist = haversineMetres(latitude, longitude, clinic.latitude, clinic.longitude);
    if (dist <= clinic.allowed_radius_meters) {
      return { ok: true, clinic, distance: Math.round(dist) };
    }
  }
  const nearest = results[0];
  const dist = haversineMetres(latitude, longitude, nearest.latitude, nearest.longitude);
  return {
    ok: false, error: "OUTSIDE_RANGE",
    message: `You are ${Math.round(dist)}m from ${nearest.name}. Max allowed: ${nearest.allowed_radius_meters}m.`,
    distance: Math.round(dist),
  };
}

async function getScheduleForDate(db, employeeId, date) {
  const row = await db.prepare(
    `SELECT * FROM hr_work_schedules
     WHERE employee_id=? AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)
     ORDER BY effective_from DESC LIMIT 1`
  ).bind(employeeId, date, date).first();
  return row || null;
}

function computeAttendance(checkIn, checkOut, schedule) {
  if (!checkIn || !checkOut || !schedule) return {};

  const ciDate = new Date(checkIn);
  const coDate = new Date(checkOut);

  const [sh, sm] = schedule.start_time.split(":").map(Number);
  const [eh, em] = schedule.end_time.split(":").map(Number);

  const schedStart = new Date(ciDate);
  schedStart.setHours(sh, sm, 0, 0);
  const schedEnd = new Date(ciDate);
  schedEnd.setHours(eh, em, 0, 0);

  const totalMinutes = Math.max(0, Math.round((coDate - ciDate) / 60000));

  const lateMs = ciDate - schedStart;
  const lateRaw = Math.round(lateMs / 60000);
  const lateMinutes = Math.max(0, lateRaw - (schedule.grace_minutes || 0));

  const earlyLeaveMs = schedEnd - coDate;
  const earlyLeaveMinutes = earlyLeaveMs > 0 ? Math.round(earlyLeaveMs / 60000) : 0;

  const overtimeMs = coDate - schedEnd;
  const overtimeMinutes = schedule.overtime_enabled && overtimeMs > 0 ? Math.round(overtimeMs / 60000) : 0;

  let status = "normal";
  if (lateMinutes > 0) status = "late";

  return { totalMinutes, lateMinutes, earlyLeaveMinutes, overtimeMinutes, status };
}

// ============================================================
//  1. CLINIC LOCATION  (admin)
// ============================================================

app.patch("/clinic/location", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "Admin access required" }, 403);
  try {
    const db = c.env.DB;
    const { clinic_id, latitude, longitude, allowed_radius_meters } = await c.req.json();
    if (latitude == null || longitude == null) {
      return c.json({ error: "latitude and longitude required" }, 400);
    }
    const radius = allowed_radius_meters ?? 100;

    let result;
    if (clinic_id) {
      const { results } = await db.prepare(
        `UPDATE clinics SET latitude=?, longitude=?, allowed_radius_meters=?,
         location_updated_at=datetime('now') WHERE id=? RETURNING *`
      ).bind(latitude, longitude, radius, clinic_id).all();
      result = results;
    } else {
      const { results } = await db.prepare(
        `UPDATE clinics SET latitude=?, longitude=?, allowed_radius_meters=?,
         location_updated_at=datetime('now') WHERE id=(SELECT id FROM clinics ORDER BY id LIMIT 1)
         RETURNING *`
      ).bind(latitude, longitude, radius).all();
      result = results;
    }

    if (!result.length) return c.json({ error: "Clinic not found" }, 404);
    return c.json({
      clinic_id: result[0].id,
      latitude: result[0].latitude,
      longitude: result[0].longitude,
      allowed_radius_meters: result[0].allowed_radius_meters,
    });
  } catch (err) {
    console.error("PATCH /hr/clinic/location error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.get("/clinic/location", async (c) => {
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT id, name, latitude, longitude, allowed_radius_meters FROM clinics ORDER BY id`
    ).all();
    return c.json(results);
  } catch (err) {
    console.error("GET /hr/clinic/location error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

// ============================================================
//  2. EMPLOYEES CRUD  (admin)
// ============================================================

app.get("/employees", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "Admin access required" }, 403);
  try {
    const db = c.env.DB;
    const { results } = await db.prepare(
      `SELECT e.*,
              (SELECT COUNT(*) FROM hr_biometric_credentials bc WHERE bc.employee_id=e.id) AS bio_count,
              s.work_days, s.start_time, s.end_time, s.grace_minutes, s.overtime_enabled
       FROM hr_employees e
       LEFT JOIN hr_work_schedules s ON s.id = (
         SELECT ws.id FROM hr_work_schedules ws
         WHERE ws.employee_id=e.id AND ws.effective_from <= date('now')
           AND (ws.effective_to IS NULL OR ws.effective_to >= date('now'))
         ORDER BY ws.effective_from DESC LIMIT 1
       )
       ORDER BY e.created_at DESC`
    ).all();

    return c.json(
      results.map((r) => ({
        id: r.id,
        fullName: r.full_name,
        username: r.username,
        phone: r.phone,
        email: r.email,
        status: r.status,
        basicSalary: parseFloat(r.basic_salary) || 0,
        role: r.role || 'HR_EMPLOYEE',
        bioRegistered: Number(r.bio_count) > 0,
        schedule: r.work_days
          ? {
              workDays: r.work_days,
              startTime: r.start_time,
              endTime: r.end_time,
              graceMinutes: r.grace_minutes,
              overtimeEnabled: r.overtime_enabled,
            }
          : null,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }))
    );
  } catch (err) {
    console.error("GET /hr/employees error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.post("/employees", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "Admin access required" }, 403);
  try {
    const db = c.env.DB;
    const {
      full_name, username, password, phone, email,
      work_days, start_time, end_time, grace_minutes,
      overtime_enabled, basic_salary, role,
    } = await c.req.json();

    if (!full_name || !username || !password) {
      return c.json({ error: "full_name, username, password required" }, 400);
    }

    const dup = await db.prepare(
      `SELECT id FROM hr_employees WHERE username=?`
    ).bind(username).first();
    if (dup) {
      return c.json({ error: "Username already exists" }, 409);
    }

    const hash = await bcrypt.hash(password, 10);

    const { results } = await db.prepare(
      `INSERT INTO hr_employees (full_name, username, password, phone, email, basic_salary, role)
       VALUES (?,?,?,?,?,?,?) RETURNING *`
    ).bind(full_name, username, hash, phone || null, email || null, basic_salary || 0, role || 'HR_EMPLOYEE').all();

    const empId = results[0].id;

    await db.prepare(
      `INSERT INTO hr_work_schedules
         (employee_id, work_days, start_time, end_time, grace_minutes, overtime_enabled)
       VALUES (?,?,?,?,?,?)`
    ).bind(
      empId,
      JSON.stringify(work_days || [1, 2, 3, 4, 5]),
      start_time || "09:00",
      end_time || "17:00",
      grace_minutes ?? 10,
      overtime_enabled !== false ? 1 : 0,
    ).run();

    return c.json({ id: empId, username: results[0].username }, 201);
  } catch (err) {
    console.error("POST /hr/employees error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.put("/employees/:id", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "Admin access required" }, 403);
  try {
    const db = c.env.DB;
    const id = c.req.param("id");
    const { full_name, phone, email, status, work_days, start_time, end_time, grace_minutes, overtime_enabled, basic_salary, role } =
      await c.req.json();

    const { results } = await db.prepare(
      `UPDATE hr_employees SET
         full_name=COALESCE(?, full_name),
         phone=COALESCE(?, phone),
         email=COALESCE(?, email),
         status=COALESCE(?, status),
         basic_salary=COALESCE(?, basic_salary),
         role=COALESCE(?, role),
         updated_at=datetime('now')
       WHERE id=? RETURNING *`
    ).bind(full_name, phone, email, status, basic_salary, role, id).all();

    if (!results.length) return c.json({ error: "Employee not found" }, 404);

    if (work_days || start_time || end_time || grace_minutes != null || overtime_enabled != null) {
      await db.prepare(
        `UPDATE hr_work_schedules SET effective_to=date('now')
         WHERE employee_id=? AND effective_to IS NULL`
      ).bind(id).run();

      await db.prepare(
        `INSERT INTO hr_work_schedules
           (employee_id, work_days, start_time, end_time, grace_minutes, overtime_enabled)
         VALUES (?,?,?,?,?,?)`
      ).bind(
        id,
        JSON.stringify(work_days || [1, 2, 3, 4, 5]),
        start_time || "09:00",
        end_time || "17:00",
        grace_minutes ?? 10,
        overtime_enabled !== false ? 1 : 0,
      ).run();
    }

    return c.json({ message: "Updated" });
  } catch (err) {
    console.error("PUT /hr/employees/:id error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.delete("/employees/:id", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "Admin access required" }, 403);
  try {
    const id = c.req.param("id");
    const { results } = await c.env.DB.prepare(
      `UPDATE hr_employees SET status='inactive', updated_at=datetime('now')
       WHERE id=? RETURNING id`
    ).bind(id).all();
    if (!results.length) return c.json({ error: "Employee not found" }, 404);
    return c.json({ message: "Deactivated" });
  } catch (err) {
    console.error("DELETE /hr/employees/:id error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.post("/employees/:id/reset-password", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "Admin access required" }, 403);
  try {
    const id = c.req.param("id");
    const body = await c.req.json();
    const newPass = body.password || crypto.randomBytes(6).toString("base64url");
    const hash = await bcrypt.hash(newPass, 10);
    const { results } = await c.env.DB.prepare(
      `UPDATE hr_employees SET password=?, updated_at=datetime('now')
       WHERE id=? RETURNING id`
    ).bind(hash, id).all();
    if (!results.length) return c.json({ error: "Employee not found" }, 404);
    return c.json({ password: newPass });
  } catch (err) {
    console.error("POST /hr/employees/:id/reset-password error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

// ============================================================
//  3. EMPLOYEE SELF  (hr_employee)
// ============================================================

app.get("/me", async (c) => {
  if (!requireHrEmployee(c)) return c.json({ error: "HR employee access required" }, 403);
  try {
    const db = c.env.DB;
    const { hr_employee_id } = c.get("user");

    const e = await db.prepare(
      `SELECT * FROM hr_employees WHERE id=?`
    ).bind(hr_employee_id).first();
    if (!e) return c.json({ error: "Not found" }, 404);

    const sched = await db.prepare(
      `SELECT * FROM hr_work_schedules
       WHERE employee_id=? AND effective_from <= date('now')
         AND (effective_to IS NULL OR effective_to >= date('now'))
       ORDER BY effective_from DESC LIMIT 1`
    ).bind(hr_employee_id).first();

    const hasPIN = !!e.pin_hash;

    const bioRow = await db.prepare(
      `SELECT COUNT(*) AS cnt FROM hr_biometric_credentials WHERE employee_id=?`
    ).bind(hr_employee_id).first();

    const todayAtt = await db.prepare(
      `SELECT * FROM hr_attendance WHERE employee_id=? AND work_date=date('now')`
    ).bind(hr_employee_id).first();

    const result = {
      id: e.id,
      fullName: e.full_name,
      username: e.username,
      phone: e.phone,
      email: e.email,
      status: e.status,
      pinSet: hasPIN,
      bioRegistered: Number(bioRow?.cnt || 0) > 0,
      bioCount: Number(bioRow?.cnt || 0),
      schedule: sched
        ? {
            workDays: sched.work_days,
            startTime: sched.start_time,
            endTime: sched.end_time,
            graceMinutes: sched.grace_minutes,
            overtimeEnabled: sched.overtime_enabled,
          }
        : null,
      role: e.role || 'HR_EMPLOYEE',
      basicSalary: parseFloat(e.basic_salary) || 0,
    };

    let onBreak = false;
    if (todayAtt && todayAtt.check_in && !todayAtt.check_out) {
      const lastEvt = await db.prepare(
        `SELECT event_type FROM hr_attendance_events
         WHERE employee_id=? AND work_date=date('now')
         ORDER BY event_time DESC LIMIT 1`
      ).bind(hr_employee_id).first();
      if (lastEvt && lastEvt.event_type === 'break_out') {
        onBreak = true;
      }
    }

    result.todayAttendance = todayAtt
      ? {
          checkIn: todayAtt.check_in,
          checkOut: todayAtt.check_out,
          totalMinutes: todayAtt.total_minutes,
          lateMinutes: todayAtt.late_minutes,
          overtimeMinutes: todayAtt.overtime_minutes,
          totalBreakMinutes: todayAtt.total_break_minutes || 0,
          netWorkMinutes: todayAtt.net_work_minutes || 0,
          onBreak,
          status: todayAtt.status,
        }
      : null;

    return c.json(result);
  } catch (err) {
    console.error("GET /hr/me error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

// ============================================================
//  4. PIN CODE  (hr_employee)
// ============================================================

app.post("/me/set-pin", async (c) => {
  if (!requireHrEmployee(c)) return c.json({ error: "HR employee access required" }, 403);
  try {
    const { hr_employee_id } = c.get("user");
    const { pin } = await c.req.json();
    if (!pin || !/^\d{4,6}$/.test(pin)) {
      return c.json({ error: "PIN must be 4-6 digits" }, 400);
    }
    const hash = await bcrypt.hash(pin, 10);
    await c.env.DB.prepare(
      `UPDATE hr_employees SET pin_hash=?, updated_at=datetime('now') WHERE id=?`
    ).bind(hash, hr_employee_id).run();
    return c.json({ success: true, message: "PIN set successfully" });
  } catch (err) {
    console.error("POST /hr/me/set-pin error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

// ============================================================
//  4b. WEBAUTHN REGISTER  (hr_employee)
// ============================================================

app.post("/webauthn/register/options", async (c) => {
  if (!requireHrEmployee(c)) return c.json({ error: "HR employee access required" }, 403);
  try {
    const db = c.env.DB;
    const { hr_employee_id } = c.get("user");
    const { rpID, rpName } = rpConfig(c);

    const e = await db.prepare(
      `SELECT id, full_name, username FROM hr_employees WHERE id=?`
    ).bind(hr_employee_id).first();
    if (!e) return c.json({ error: "Not found" }, 404);

    const { results: existing } = await db.prepare(
      `SELECT credential_id FROM hr_biometric_credentials WHERE employee_id=?`
    ).bind(hr_employee_id).all();

    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userID: new TextEncoder().encode(String(e.id)),
      userName: e.username,
      userDisplayName: e.full_name,
      excludeCredentials: existing.map((r) => ({
        id: r.credential_id,
        type: "public-key",
      })),
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        userVerification: "required",
        residentKey: "preferred",
      },
      attestationType: "none",
    });

    console.log("[WebAuthn Reg Options] rpID:", rpID, "employee:", e.username);

    await db.prepare(
      `DELETE FROM hr_webauthn_challenges WHERE employee_id=? AND type='register'`
    ).bind(hr_employee_id).run();
    await db.prepare(
      `INSERT INTO hr_webauthn_challenges (employee_id, challenge, type)
       VALUES (?, ?, 'register')`
    ).bind(hr_employee_id, options.challenge).run();

    return c.json(options);
  } catch (err) {
    console.error("POST /hr/webauthn/register/options error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.post("/webauthn/register/verify", async (c) => {
  if (!requireHrEmployee(c)) return c.json({ error: "HR employee access required" }, 403);
  try {
    const db = c.env.DB;
    const { hr_employee_id } = c.get("user");
    const { rpID, origin } = rpConfig(c);

    const ch = await db.prepare(
      `SELECT challenge FROM hr_webauthn_challenges
       WHERE employee_id=? AND type='register' AND expires_at > datetime('now')
       ORDER BY created_at DESC LIMIT 1`
    ).bind(hr_employee_id).first();
    if (!ch) return c.json({ error: "Challenge expired" }, 400);

    const body = await c.req.json();
    const verification = await verifyRegistrationResponse({
      response: body,
      expectedChallenge: ch.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
    });

    console.log("[WebAuthn Reg Verify] verified:", verification.verified, "rpID:", rpID, "origin:", origin);

    if (!verification.verified || !verification.registrationInfo) {
      return c.json({ error: "Verification failed" }, 400);
    }

    const { credential, credentialDeviceType } = verification.registrationInfo;
    const credIdB64 = typeof credential.id === "string"
      ? credential.id
      : Buffer.from(credential.id).toString("base64url");
    const pubKeyB64 = Buffer.from(credential.publicKey).toString("base64url");

    await db.prepare(
      `INSERT INTO hr_biometric_credentials
         (employee_id, credential_id, public_key, counter, transports, device_name)
       VALUES (?,?,?,?,?,?)`
    ).bind(
      hr_employee_id,
      credIdB64,
      pubKeyB64,
      credential.counter,
      JSON.stringify((body.response?.transports || []).filter(t => t !== "hybrid")),
      body.deviceName || credentialDeviceType || "Unknown",
    ).run();

    await db.prepare(
      `DELETE FROM hr_webauthn_challenges WHERE employee_id=? AND type='register'`
    ).bind(hr_employee_id).run();

    console.log("[WebAuthn Reg Verify] SUCCESS — credential saved for employee:", hr_employee_id);
    return c.json({ verified: true });
  } catch (err) {
    console.error("POST /hr/webauthn/register/verify error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

// ============================================================
//  4c. RESET BIOMETRIC  (hr_employee)
// ============================================================

app.delete("/webauthn/reset", async (c) => {
  if (!requireHrEmployee(c)) return c.json({ error: "HR employee access required" }, 403);
  try {
    const db = c.env.DB;
    const { hr_employee_id } = c.get("user");
    const del = await db.prepare(
      `DELETE FROM hr_biometric_credentials WHERE employee_id=?`
    ).bind(hr_employee_id).run();
    await db.prepare(
      `DELETE FROM hr_webauthn_challenges WHERE employee_id=?`
    ).bind(hr_employee_id).run();
    console.log("[WebAuthn Reset] Cleared credentials for employee:", hr_employee_id);
    return c.json({ cleared: del.meta?.changes || 0 });
  } catch (err) {
    console.error("DELETE /hr/webauthn/reset error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

// ============================================================
//  5. WEBAUTHN AUTHENTICATE  (hr_employee)
// ============================================================

app.post("/webauthn/authenticate/options", async (c) => {
  if (!requireHrEmployee(c)) return c.json({ error: "HR employee access required" }, 403);
  try {
    const db = c.env.DB;
    const { hr_employee_id } = c.get("user");
    const { rpID } = rpConfig(c);

    const { results: creds } = await db.prepare(
      `SELECT credential_id, transports FROM hr_biometric_credentials WHERE employee_id=?`
    ).bind(hr_employee_id).all();
    if (!creds.length) {
      return c.json({ error: "No biometric registered", code: "NO_BIOMETRIC" }, 400);
    }

    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials: creds.map((r) => ({
        id: r.credential_id,
        type: "public-key",
        transports: ["internal"],
      })),
      userVerification: "required",
    });

    console.log("[WebAuthn Auth Options] rpID:", rpID, "creds:", creds.length, "employee:", hr_employee_id);

    await db.prepare(
      `DELETE FROM hr_webauthn_challenges WHERE employee_id=? AND type='authenticate'`
    ).bind(hr_employee_id).run();
    await db.prepare(
      `INSERT INTO hr_webauthn_challenges (employee_id, challenge, type)
       VALUES (?, ?, 'authenticate')`
    ).bind(hr_employee_id, options.challenge).run();

    return c.json(options);
  } catch (err) {
    console.error("POST /hr/webauthn/authenticate/options error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.post("/webauthn/authenticate/verify", async (c) => {
  if (!requireHrEmployee(c)) return c.json({ error: "HR employee access required" }, 403);
  try {
    const db = c.env.DB;
    const { hr_employee_id } = c.get("user");
    const { rpID, origin } = rpConfig(c);

    const ch = await db.prepare(
      `SELECT challenge FROM hr_webauthn_challenges
       WHERE employee_id=? AND type='authenticate' AND expires_at > datetime('now')
       ORDER BY created_at DESC LIMIT 1`
    ).bind(hr_employee_id).first();
    if (!ch) return c.json({ error: "Challenge expired" }, 400);

    const body = await c.req.json();
    const credIdFromBody = body.id;
    console.log("[WebAuthn Auth Verify] Looking for credential:", credIdFromBody?.slice(0, 30));

    const storedCred = await db.prepare(
      `SELECT * FROM hr_biometric_credentials
       WHERE employee_id=? AND credential_id=?`
    ).bind(hr_employee_id, credIdFromBody).first();

    if (!storedCred) {
      const { results: allCreds } = await db.prepare(
        `SELECT credential_id FROM hr_biometric_credentials WHERE employee_id=?`
      ).bind(hr_employee_id).all();
      console.error("[WebAuthn Auth Verify] Credential NOT FOUND. Body id:", credIdFromBody);
      console.error("[WebAuthn Auth Verify] Stored credentials:", allCreds.map(r => r.credential_id));
      return c.json({ error: "Credential not found", code: "CRED_NOT_FOUND" }, 400);
    }

    console.log("[WebAuthn Auth Verify] Found credential id:", storedCred.id, "counter:", storedCred.counter);

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: body,
        expectedChallenge: ch.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: {
          id: storedCred.credential_id,
          publicKey: Buffer.from(storedCred.public_key, "base64url"),
          counter: Number(storedCred.counter),
          transports: storedCred.transports || [],
        },
      });
    } catch (verifyErr) {
      console.error("[WebAuthn Auth Verify] VERIFY THREW ERROR:", verifyErr.message);
      console.error("[WebAuthn Auth Verify] rpID:", rpID, "origin:", origin);
      return c.json({ error: "Biometric verification failed" }, 400);
    }

    console.log("[WebAuthn Auth Verify] verified:", verification.verified);

    if (!verification.verified) {
      return c.json({ error: "Biometric verification failed" }, 400);
    }

    await db.prepare(
      `UPDATE hr_biometric_credentials SET counter=? WHERE id=?`
    ).bind(verification.authenticationInfo.newCounter, storedCred.id).run();

    await db.prepare(
      `DELETE FROM hr_webauthn_challenges WHERE employee_id=? AND type='authenticate'`
    ).bind(hr_employee_id).run();

    const bioToken = crypto.randomUUID();
    await db.prepare(
      `INSERT INTO hr_webauthn_challenges (employee_id, challenge, type, expires_at)
       VALUES (?, ?, 'bio_token', datetime('now', '+2 minutes'))`
    ).bind(hr_employee_id, bioToken).run();

    return c.json({ verified: true, bioToken });
  } catch (err) {
    console.error("POST /hr/webauthn/authenticate/verify error:", err);
    return c.json({ error: "Server error", message: err?.message || "Unknown auth verify error" }, 500);
  }
});

// ============================================================
//  6. ATTENDANCE CHECK-IN / CHECK-OUT
// ============================================================

app.post("/attendance/check-in", async (c) => {
  if (!requireHrEmployee(c)) return c.json({ error: "HR employee access required" }, 403);
  try {
    const db = c.env.DB;
    const { hr_employee_id } = c.get("user");
    const { latitude, longitude, device_info, bioToken } = await c.req.json();

    if (latitude == null || longitude == null) {
      return c.json({ error: "GPS_REQUIRED", message: "Location is required for check-in" }, 400);
    }

    const geo = await validateGeoFence(db, latitude, longitude);
    if (!geo.ok) {
      return c.json({ error: geo.error, message: geo.message, distance: geo.distance }, 400);
    }

    if (!bioToken) {
      return c.json({ error: "AUTH_REQUIRED", message: "Biometric verification required" }, 400);
    }
    const { results: tokenResults } = await db.prepare(
      `DELETE FROM hr_webauthn_challenges
       WHERE employee_id=? AND challenge=? AND type='bio_token' AND expires_at > datetime('now')
       RETURNING id`
    ).bind(hr_employee_id, bioToken).all();
    if (!tokenResults.length) {
      return c.json({ error: "INVALID_TOKEN", message: "Biometric token expired or invalid. Please verify again." }, 401);
    }

    const existing = await db.prepare(
      `SELECT * FROM hr_attendance WHERE employee_id=? AND work_date=date('now')`
    ).bind(hr_employee_id).first();

    if (existing && existing.check_in) {
      return c.json({ error: "ALREADY_CHECKED_IN", message: "Already checked in today" }, 409);
    }

    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);

    const schedule = await getScheduleForDate(db, hr_employee_id, todayStr);
    const dayOfWeek = now.getDay() === 0 ? 7 : now.getDay();
    const workDays = schedule?.work_days ? (typeof schedule.work_days === 'string' ? JSON.parse(schedule.work_days) : schedule.work_days) : [];
    const isWorkDay = schedule && workDays.includes(dayOfWeek);
    const initialStatus = isWorkDay === false ? "weekend" : "incomplete";

    if (existing) {
      await db.prepare(
        `UPDATE hr_attendance SET check_in=?, check_in_lat=?, check_in_lng=?,
         device_info=?, status=?, updated_at=datetime('now')
         WHERE id=?`
      ).bind(now.toISOString(), latitude, longitude, device_info, initialStatus, existing.id).run();
    } else {
      await db.prepare(
        `INSERT INTO hr_attendance
           (employee_id, work_date, check_in, check_in_lat, check_in_lng, device_info, status)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT (employee_id, work_date) DO UPDATE
         SET check_in = EXCLUDED.check_in, check_in_lat = EXCLUDED.check_in_lat,
             check_in_lng = EXCLUDED.check_in_lng, device_info = EXCLUDED.device_info,
             status = EXCLUDED.status, updated_at = datetime('now')
         WHERE hr_attendance.check_in IS NULL`
      ).bind(hr_employee_id, todayStr, now.toISOString(), latitude, longitude, device_info, initialStatus).run();
    }

    return c.json({ message: "Checked in", time: now.toISOString(), clinicName: geo.clinic.name });
  } catch (err) {
    console.error("POST /hr/attendance/check-in error:", err);
    return c.json({ error: "Server error", message: err?.message || "Unknown check-in error" }, 500);
  }
});

app.post("/attendance/check-out", async (c) => {
  if (!requireHrEmployee(c)) return c.json({ error: "HR employee access required" }, 403);
  try {
    const db = c.env.DB;
    const { hr_employee_id } = c.get("user");
    const { latitude, longitude, device_info, bioToken } = await c.req.json();

    if (latitude == null || longitude == null) {
      return c.json({ error: "GPS_REQUIRED", message: "Location is required for check-out" }, 400);
    }

    const geo = await validateGeoFence(db, latitude, longitude);
    if (!geo.ok) {
      return c.json({ error: geo.error, message: geo.message, distance: geo.distance }, 400);
    }

    if (!bioToken) {
      return c.json({ error: "AUTH_REQUIRED", message: "Biometric verification required" }, 400);
    }
    const { results: tokenResults } = await db.prepare(
      `DELETE FROM hr_webauthn_challenges
       WHERE employee_id=? AND challenge=? AND type='bio_token' AND expires_at > datetime('now')
       RETURNING id`
    ).bind(hr_employee_id, bioToken).all();
    if (!tokenResults.length) {
      return c.json({ error: "INVALID_TOKEN", message: "Biometric token expired or invalid. Please verify again." }, 401);
    }

    const existing = await db.prepare(
      `SELECT * FROM hr_attendance WHERE employee_id=? AND work_date=date('now')`
    ).bind(hr_employee_id).first();
    if (!existing || !existing.check_in) {
      return c.json({ error: "NOT_CHECKED_IN", message: "Must check in first" }, 400);
    }
    if (existing.check_out) {
      return c.json({ error: "ALREADY_CHECKED_OUT", message: "Already checked out today" }, 409);
    }

    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const schedule = await getScheduleForDate(db, hr_employee_id, todayStr);
    const metrics = computeAttendance(existing.check_in, now, schedule);

    await db.prepare(
      `UPDATE hr_attendance SET
         check_out=?, check_out_lat=?, check_out_lng=?,
         total_minutes=?, late_minutes=?, early_leave_minutes=?, overtime_minutes=?,
         status=?, updated_at=datetime('now')
       WHERE id=?`
    ).bind(
      now.toISOString(),
      latitude,
      longitude,
      metrics.totalMinutes || 0,
      metrics.lateMinutes || 0,
      metrics.earlyLeaveMinutes || 0,
      metrics.overtimeMinutes || 0,
      metrics.status || "normal",
      existing.id,
    ).run();

    return c.json({
      message: "Checked out",
      time: now.toISOString(),
      totalMinutes: metrics.totalMinutes,
      lateMinutes: metrics.lateMinutes,
      overtimeMinutes: metrics.overtimeMinutes,
    });
  } catch (err) {
    console.error("POST /hr/attendance/check-out error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

// ============================================================
//  7. ATTENDANCE LIST  (admin)
// ============================================================

app.get("/attendance", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "Admin access required" }, 403);
  try {
    const db = c.env.DB;
    const from = c.req.query("from");
    const to = c.req.query("to");
    const employee_id = c.req.query("employee_id");
    const status = c.req.query("status");

    let query = `SELECT a.*, e.full_name AS employee_name
                 FROM hr_attendance a
                 JOIN hr_employees e ON e.id = a.employee_id
                 WHERE 1=1`;
    const params = [];

    if (from) { query += ` AND a.work_date >= ?`; params.push(from); }
    if (to) { query += ` AND a.work_date <= ?`; params.push(to); }
    if (employee_id) { query += ` AND a.employee_id = ?`; params.push(employee_id); }
    if (status) { query += ` AND a.status = ?`; params.push(status); }

    query += " ORDER BY a.work_date DESC, e.full_name";

    const { results } = await db.prepare(query).bind(...params).all();
    return c.json(
      results.map((r) => ({
        id: r.id,
        employeeId: r.employee_id,
        employeeName: r.employee_name,
        workDate: r.work_date,
        checkIn: r.check_in,
        checkOut: r.check_out,
        totalMinutes: r.total_minutes,
        lateMinutes: r.late_minutes,
        earlyLeaveMinutes: r.early_leave_minutes,
        overtimeMinutes: r.overtime_minutes,
        totalBreakMinutes: r.total_break_minutes || 0,
        netWorkMinutes: r.net_work_minutes || r.total_minutes || 0,
        status: r.status,
      }))
    );
  } catch (err) {
    console.error("GET /hr/attendance error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

// ============================================================
//  8. REPORTS
// ============================================================

app.get("/reports/monthly", async (c) => {
  try {
    const { role, type, hr_employee_id } = c.get("user");
    let employee_id = c.req.query("employee_id");
    const month = c.req.query("month");

    if (type === "hr_employee") {
      employee_id = hr_employee_id;
    } else if (role !== "admin") {
      return c.json({ error: "Forbidden" }, 403);
    }

    if (!employee_id || !month) {
      return c.json({ error: "employee_id and month (YYYY-MM) required" }, 400);
    }

    const startDate = `${month}-01`;
    const [y, m] = month.split("-").map(Number);
    const endDate = new Date(y, m, 0).toISOString().slice(0, 10);

    const { results } = await c.env.DB.prepare(
      `SELECT * FROM hr_attendance
       WHERE employee_id=? AND work_date BETWEEN ? AND ?
       ORDER BY work_date`
    ).bind(employee_id, startDate, endDate).all();

    const summary = {
      daysPresent: 0, totalWorkMinutes: 0, totalLateMinutes: 0,
      totalOvertimeMinutes: 0, totalEarlyLeaveMinutes: 0,
    };

    const days = results.map((r) => {
      if (r.check_in) summary.daysPresent++;
      summary.totalWorkMinutes += r.total_minutes || 0;
      summary.totalLateMinutes += r.late_minutes || 0;
      summary.totalOvertimeMinutes += r.overtime_minutes || 0;
      summary.totalEarlyLeaveMinutes += r.early_leave_minutes || 0;
      return {
        workDate: r.work_date, checkIn: r.check_in, checkOut: r.check_out,
        totalMinutes: r.total_minutes, lateMinutes: r.late_minutes,
        earlyLeaveMinutes: r.early_leave_minutes, overtimeMinutes: r.overtime_minutes,
        status: r.status,
      };
    });

    return c.json({ month, employeeId: Number(employee_id), summary, days });
  } catch (err) {
    console.error("GET /hr/reports/monthly error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.get("/reports/my-monthly", async (c) => {
  if (!requireHrEmployee(c)) return c.json({ error: "HR employee access required" }, 403);
  try {
    const { hr_employee_id } = c.get("user");
    const month = c.req.query("month");
    if (!month) return c.json({ error: "month (YYYY-MM) required" }, 400);

    const startDate = `${month}-01`;
    const [y, m] = month.split("-").map(Number);
    const endDate = new Date(y, m, 0).toISOString().slice(0, 10);

    const { results } = await c.env.DB.prepare(
      `SELECT * FROM hr_attendance
       WHERE employee_id=? AND work_date BETWEEN ? AND ?
       ORDER BY work_date`
    ).bind(hr_employee_id, startDate, endDate).all();

    const summary = { daysPresent: 0, totalWorkMinutes: 0, totalLateMinutes: 0, totalOvertimeMinutes: 0, totalEarlyLeaveMinutes: 0 };
    const days = results.map((r) => {
      if (r.check_in) summary.daysPresent++;
      summary.totalWorkMinutes += r.total_minutes || 0;
      summary.totalLateMinutes += r.late_minutes || 0;
      summary.totalOvertimeMinutes += r.overtime_minutes || 0;
      summary.totalEarlyLeaveMinutes += r.early_leave_minutes || 0;
      return {
        workDate: r.work_date, checkIn: r.check_in, checkOut: r.check_out,
        totalMinutes: r.total_minutes, lateMinutes: r.late_minutes,
        earlyLeaveMinutes: r.early_leave_minutes, overtimeMinutes: r.overtime_minutes,
        status: r.status,
      };
    });

    return c.json({ month, employeeId: hr_employee_id, summary, days });
  } catch (err) {
    console.error("GET /hr/reports/my-monthly error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

// ============================================================
//  9. BREAK OUT / BREAK IN  (hr_employee)
// ============================================================

app.post("/attendance/break-out", async (c) => {
  if (!requireHrEmployee(c)) return c.json({ error: "HR employee access required" }, 403);
  try {
    const db = c.env.DB;
    const { hr_employee_id } = c.get("user");
    const { latitude, longitude, device_info, bioToken } = await c.req.json();

    if (latitude == null || longitude == null) {
      return c.json({ error: "GPS_REQUIRED", message: "Location is required" }, 400);
    }

    const geo = await validateGeoFence(db, latitude, longitude);
    if (!geo.ok) {
      return c.json({ error: geo.error, message: geo.message, distance: geo.distance }, 400);
    }

    if (!bioToken) {
      return c.json({ error: "AUTH_REQUIRED", message: "Biometric verification required" }, 400);
    }
    const { results: tokenResults } = await db.prepare(
      `DELETE FROM hr_webauthn_challenges
       WHERE employee_id=? AND challenge=? AND type='bio_token' AND expires_at > datetime('now')
       RETURNING id`
    ).bind(hr_employee_id, bioToken).all();
    if (!tokenResults.length) {
      return c.json({ error: "INVALID_TOKEN", message: "Biometric token expired or invalid." }, 401);
    }

    const att = await db.prepare(
      `SELECT * FROM hr_attendance WHERE employee_id=? AND work_date=date('now')`
    ).bind(hr_employee_id).first();
    if (!att || !att.check_in) {
      return c.json({ error: "NOT_CHECKED_IN", message: "Must check in first" }, 400);
    }
    if (att.check_out) {
      return c.json({ error: "ALREADY_CHECKED_OUT", message: "Already checked out" }, 409);
    }

    const lastEvent = await db.prepare(
      `SELECT event_type FROM hr_attendance_events
       WHERE employee_id=? AND work_date=date('now')
       ORDER BY event_time DESC LIMIT 1`
    ).bind(hr_employee_id).first();
    if (lastEvent && lastEvent.event_type === 'break_out') {
      return c.json({ error: "ALREADY_ON_BREAK", message: "Already on break" }, 409);
    }

    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);

    await db.prepare(
      `INSERT INTO hr_attendance_events (employee_id, work_date, event_type, event_time, latitude, longitude, device_info)
       VALUES (?,?,'break_out',?,?,?,?)`
    ).bind(hr_employee_id, todayStr, now.toISOString(), latitude, longitude, device_info ? JSON.stringify(device_info) : null).run();

    return c.json({ message: "Break started", time: now.toISOString() });
  } catch (err) {
    console.error("POST /hr/attendance/break-out error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.post("/attendance/break-in", async (c) => {
  if (!requireHrEmployee(c)) return c.json({ error: "HR employee access required" }, 403);
  try {
    const db = c.env.DB;
    const { hr_employee_id } = c.get("user");
    const { latitude, longitude, device_info, bioToken } = await c.req.json();

    if (latitude == null || longitude == null) {
      return c.json({ error: "GPS_REQUIRED", message: "Location is required" }, 400);
    }

    const geo = await validateGeoFence(db, latitude, longitude);
    if (!geo.ok) {
      return c.json({ error: geo.error, message: geo.message, distance: geo.distance }, 400);
    }

    if (!bioToken) {
      return c.json({ error: "AUTH_REQUIRED", message: "Biometric verification required" }, 400);
    }
    const { results: tokenResults } = await db.prepare(
      `DELETE FROM hr_webauthn_challenges
       WHERE employee_id=? AND challenge=? AND type='bio_token' AND expires_at > datetime('now')
       RETURNING id`
    ).bind(hr_employee_id, bioToken).all();
    if (!tokenResults.length) {
      return c.json({ error: "INVALID_TOKEN", message: "Biometric token expired or invalid." }, 401);
    }

    const lastEvent = await db.prepare(
      `SELECT event_type, event_time FROM hr_attendance_events
       WHERE employee_id=? AND work_date=date('now')
       ORDER BY event_time DESC LIMIT 1`
    ).bind(hr_employee_id).first();
    if (!lastEvent || lastEvent.event_type !== 'break_out') {
      return c.json({ error: "NOT_ON_BREAK", message: "Not currently on break" }, 400);
    }

    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);

    const breakStartTime = new Date(lastEvent.event_time);
    const breakMinutes = Math.round((now - breakStartTime) / 60000);

    await db.prepare(
      `INSERT INTO hr_attendance_events (employee_id, work_date, event_type, event_time, latitude, longitude, device_info)
       VALUES (?,?,'break_in',?,?,?,?)`
    ).bind(hr_employee_id, todayStr, now.toISOString(), latitude, longitude, device_info ? JSON.stringify(device_info) : null).run();

    await db.prepare(
      `UPDATE hr_attendance SET total_break_minutes = COALESCE(total_break_minutes,0) + ?,
       updated_at=datetime('now')
       WHERE employee_id=? AND work_date=date('now')`
    ).bind(breakMinutes, hr_employee_id).run();

    return c.json({ message: "Break ended", time: now.toISOString(), breakMinutes });
  } catch (err) {
    console.error("POST /hr/attendance/break-in error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.get("/attendance/:employeeId/timeline", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "Admin access required" }, 403);
  try {
    const employeeId = c.req.param("employeeId");
    const date = c.req.query("date");
    if (!date) return c.json({ error: "date query param required" }, 400);

    const { results } = await c.env.DB.prepare(
      `SELECT id, event_type, event_time, latitude, longitude, device_info
       FROM hr_attendance_events
       WHERE employee_id=? AND work_date=?
       ORDER BY event_time ASC`
    ).bind(employeeId, date).all();

    return c.json(results.map(r => ({
      id: r.id,
      eventType: r.event_type,
      timestamp: r.event_time,
      latitude: r.latitude,
      longitude: r.longitude,
      deviceInfo: r.device_info,
    })));
  } catch (err) {
    console.error("GET /hr/attendance/:id/timeline error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

// ============================================================
//  10. DEDUCTIONS  (admin)
// ============================================================

app.get("/deductions", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "Admin access required" }, 403);
  try {
    const db = c.env.DB;
    const month = c.req.query("month");
    const employee_id = c.req.query("employee_id");

    let query = `SELECT d.*, e.full_name AS employee_name
                 FROM hr_deductions d
                 JOIN hr_employees e ON e.id = d.employee_id
                 WHERE 1=1`;
    const params = [];

    if (month) { query += ` AND d.month = ?`; params.push(month + '-01'); }
    if (employee_id) { query += ` AND d.employee_id = ?`; params.push(employee_id); }

    query += " ORDER BY d.created_at DESC";

    const { results } = await db.prepare(query).bind(...params).all();
    return c.json(results.map(r => ({
      id: r.id,
      employeeId: r.employee_id,
      employeeName: r.employee_name,
      month: r.month,
      amount: parseFloat(r.amount),
      reason: r.reason,
      createdAt: r.created_at,
    })));
  } catch (err) {
    console.error("GET /hr/deductions error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.post("/deductions", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "Admin access required" }, 403);
  try {
    const db = c.env.DB;
    const { id: userId } = c.get("user");
    const { employee_id, month, amount, reason } = await c.req.json();

    if (!employee_id || !month || !amount) {
      return c.json({ error: "employee_id, month, amount required" }, 400);
    }

    const monthDate = month.length === 7 ? month + '-01' : month;

    const { results } = await db.prepare(
      `INSERT INTO hr_deductions (employee_id, month, amount, reason, created_by)
       VALUES (?,?,?,?,?) RETURNING *`
    ).bind(employee_id, monthDate, amount, reason || null, userId || null).all();

    return c.json({
      id: results[0].id,
      employeeId: results[0].employee_id,
      month: results[0].month,
      amount: parseFloat(results[0].amount),
      reason: results[0].reason,
      createdAt: results[0].created_at,
    }, 201);
  } catch (err) {
    console.error("POST /hr/deductions error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.delete("/deductions/:id", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "Admin access required" }, 403);
  try {
    const id = c.req.param("id");
    const { results } = await c.env.DB.prepare(
      `DELETE FROM hr_deductions WHERE id=? RETURNING id`
    ).bind(id).all();
    if (!results.length) return c.json({ error: "Not found" }, 404);
    return c.json({ deleted: true });
  } catch (err) {
    console.error("DELETE /hr/deductions/:id error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

// ============================================================
//  11. WARNINGS  (admin)
// ============================================================

app.get("/warnings", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "Admin access required" }, 403);
  try {
    const db = c.env.DB;
    const employee_id = c.req.query("employee_id");

    let query = `SELECT w.*, e.full_name AS employee_name
                 FROM hr_warnings w
                 JOIN hr_employees e ON e.id = w.employee_id
                 WHERE 1=1`;
    const params = [];

    if (employee_id) { query += ` AND w.employee_id = ?`; params.push(employee_id); }

    query += " ORDER BY w.issued_at DESC";

    const { results } = await db.prepare(query).bind(...params).all();
    return c.json(results.map(r => ({
      id: r.id,
      employeeId: r.employee_id,
      employeeName: r.employee_name,
      level: r.level,
      reason: r.reason,
      issuedAt: r.issued_at,
    })));
  } catch (err) {
    console.error("GET /hr/warnings error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.post("/warnings", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "Admin access required" }, 403);
  try {
    const db = c.env.DB;
    const { id: userId } = c.get("user");
    const { employee_id, level, reason } = await c.req.json();

    if (!employee_id || !level) {
      return c.json({ error: "employee_id, level required" }, 400);
    }
    if (!['verbal', 'written', 'final'].includes(level)) {
      return c.json({ error: "level must be verbal, written, or final" }, 400);
    }

    const { results } = await db.prepare(
      `INSERT INTO hr_warnings (employee_id, level, reason, issued_by)
       VALUES (?,?,?,?) RETURNING *`
    ).bind(employee_id, level, reason || null, userId || null).all();

    return c.json({
      id: results[0].id,
      employeeId: results[0].employee_id,
      level: results[0].level,
      reason: results[0].reason,
      issuedAt: results[0].issued_at,
    }, 201);
  } catch (err) {
    console.error("POST /hr/warnings error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

// ============================================================
//  12. NOTIFICATIONS  (admin sends, employee reads)
// ============================================================

app.get("/notifications", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "Admin access required" }, 403);
  try {
    const db = c.env.DB;
    const employee_id = c.req.query("employee_id");

    let query = `SELECT n.*, e.full_name AS employee_name
                 FROM hr_notifications n
                 JOIN hr_employees e ON e.id = n.employee_id
                 WHERE 1=1`;
    const params = [];

    if (employee_id) { query += ` AND n.employee_id = ?`; params.push(employee_id); }

    query += " ORDER BY n.created_at DESC";

    const { results } = await db.prepare(query).bind(...params).all();
    return c.json(results.map(r => ({
      id: r.id,
      employeeId: r.employee_id,
      employeeName: r.employee_name,
      message: r.message,
      isRead: r.is_read,
      createdAt: r.created_at,
    })));
  } catch (err) {
    console.error("GET /hr/notifications error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.post("/notifications", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "Admin access required" }, 403);
  try {
    const db = c.env.DB;
    const { hr_employee_id } = c.get("user");
    const { employee_id, message } = await c.req.json();

    if (!employee_id || !message) {
      return c.json({ error: "employee_id, message required" }, 400);
    }

    const createdBy = hr_employee_id ? parseInt(hr_employee_id) : null;

    const { results } = await db.prepare(
      `INSERT INTO hr_notifications (employee_id, message, created_by)
       VALUES (?,?,?) RETURNING *`
    ).bind(employee_id, message, createdBy).all();

    return c.json({
      id: results[0].id,
      employeeId: results[0].employee_id,
      message: results[0].message,
      isRead: results[0].is_read,
      createdAt: results[0].created_at,
    }, 201);
  } catch (err) {
    console.error("POST /hr/notifications error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.get("/notifications/my", async (c) => {
  if (!requireHrEmployee(c)) return c.json({ error: "HR employee access required" }, 403);
  try {
    const { hr_employee_id } = c.get("user");
    const { results } = await c.env.DB.prepare(
      `SELECT * FROM hr_notifications WHERE employee_id=? ORDER BY created_at DESC`
    ).bind(hr_employee_id).all();
    return c.json(results.map(r => ({
      id: r.id,
      message: r.message,
      isRead: r.is_read,
      createdAt: r.created_at,
    })));
  } catch (err) {
    console.error("GET /hr/notifications/my error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.patch("/notifications/:id/read", async (c) => {
  if (!requireHrEmployee(c)) return c.json({ error: "HR employee access required" }, 403);
  try {
    const { hr_employee_id } = c.get("user");
    const id = c.req.param("id");
    const { results } = await c.env.DB.prepare(
      `UPDATE hr_notifications SET is_read=1 WHERE id=? AND employee_id=? RETURNING id`
    ).bind(id, hr_employee_id).all();
    if (!results.length) return c.json({ error: "Not found" }, 404);
    return c.json({ success: true });
  } catch (err) {
    console.error("PATCH /hr/notifications/:id/read error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

// ============================================================
//  13. SOCIAL SECURITY SETTINGS  (admin)
// ============================================================

app.get("/social-security", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "Admin access required" }, 403);
  try {
    const row = await c.env.DB.prepare(
      `SELECT * FROM hr_social_security_settings LIMIT 1`
    ).first();
    if (!row) {
      return c.json({ employeeRate: 7.50, employerRate: 14.25, enabled: true });
    }
    return c.json({
      employeeRate: parseFloat(row.employee_rate_percent),
      employerRate: parseFloat(row.employer_rate_percent),
      enabled: row.enabled,
    });
  } catch (err) {
    console.error("GET /hr/social-security error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.patch("/social-security", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "Admin access required" }, 403);
  try {
    const { employeeRate, employerRate, enabled } = await c.req.json();
    await c.env.DB.prepare(
      `INSERT INTO hr_social_security_settings (id, employee_rate_percent, employer_rate_percent, enabled)
       VALUES (1, ?, ?, ?)
       ON CONFLICT (id)
       DO UPDATE SET employee_rate_percent=EXCLUDED.employee_rate_percent,
                     employer_rate_percent=EXCLUDED.employer_rate_percent,
                     enabled=EXCLUDED.enabled,
                     updated_at=datetime('now')`
    ).bind(employeeRate ?? 7.50, employerRate ?? 14.25, enabled !== false ? 1 : 0).run();
    return c.json({ success: true });
  } catch (err) {
    console.error("PATCH /hr/social-security error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

// ============================================================
//  14. PAYROLL  (admin)
// ============================================================

app.post("/payroll/generate", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "Admin access required" }, 403);
  try {
    const db = c.env.DB;
    const { id: userId } = c.get("user");
    const { month } = await c.req.json();
    if (!month) return c.json({ error: "month (YYYY-MM) required" }, 400);

    const monthDate = month + '-01';
    const [y, m] = month.split("-").map(Number);
    const endDate = new Date(y, m, 0).toISOString().slice(0, 10);
    const daysInMonth = new Date(y, m, 0).getDate();

    // Check existing payroll run
    const existingRun = await db.prepare(
      `SELECT * FROM hr_payroll_runs WHERE month=?`
    ).bind(monthDate).first();

    if (existingRun && existingRun.status === 'closed') {
      return c.json({ error: "Month already closed" }, 409);
    }

    let runId;
    if (!existingRun) {
      const { results } = await db.prepare(
        `INSERT INTO hr_payroll_runs (month, status, created_by) VALUES (?,'draft',?) RETURNING id`
      ).bind(monthDate, userId || null).all();
      runId = results[0].id;
    } else {
      runId = existingRun.id;
      // Delete existing payslips for recalculation
      await db.prepare(
        `DELETE FROM hr_payslips WHERE payroll_run_id=?`
      ).bind(runId).run();
    }

    // Get social security settings
    const ssRow = await db.prepare(
      `SELECT * FROM hr_social_security_settings LIMIT 1`
    ).first();
    const ssEmployeeRate = ssRow ? parseFloat(ssRow.employee_rate_percent) / 100 : 0.075;
    const ssEmployerRate = ssRow ? parseFloat(ssRow.employer_rate_percent) / 100 : 0.1425;
    const ssEnabled = ssRow ? ssRow.enabled : true;

    // Get all active employees
    const { results: employees } = await db.prepare(
      `SELECT id, full_name, basic_salary FROM hr_employees WHERE status='active'`
    ).all();

    // Batch-fetch attendance and deductions
    const { results: allAttendance } = await db.prepare(
      `SELECT * FROM hr_attendance WHERE work_date BETWEEN ? AND ?`
    ).bind(monthDate, endDate).all();
    const attendanceByEmp = {};
    for (const att of allAttendance) {
      if (!attendanceByEmp[att.employee_id]) attendanceByEmp[att.employee_id] = [];
      attendanceByEmp[att.employee_id].push(att);
    }

    const { results: allDeductions } = await db.prepare(
      `SELECT employee_id, COALESCE(SUM(amount),0) AS total FROM hr_deductions WHERE month=? GROUP BY employee_id`
    ).bind(monthDate).all();
    const deductionsByEmp = {};
    for (const d of allDeductions) deductionsByEmp[d.employee_id] = parseFloat(d.total) || 0;

    // Generate payslips using batch for atomicity
    const payslips = [];
    const insertStatements = [];

    for (const emp of employees) {
      const basicSalary = parseFloat(emp.basic_salary) || 0;
      const dailyRate = daysInMonth > 0 ? basicSalary / daysInMonth : 0;
      const hourlyRate = dailyRate / 8;

      const empAttendance = attendanceByEmp[emp.id] || [];

      let daysWorked = 0, totalWorkMinutes = 0, totalLateMinutes = 0;
      let totalOvertimeMinutes = 0, totalBreakMins = 0, absentDays = 0;

      for (const att of empAttendance) {
        if (att.check_in) daysWorked++;
        totalWorkMinutes += att.total_minutes || 0;
        totalLateMinutes += att.late_minutes || 0;
        totalOvertimeMinutes += att.overtime_minutes || 0;
        totalBreakMins += att.total_break_minutes || 0;
        if (!att.check_in && att.status !== 'weekend') absentDays++;
      }

      const lateAmount = totalLateMinutes > 0 ? Math.round(totalLateMinutes * (hourlyRate / 60) * 100) / 100 : 0;
      const overtimeAmount = totalOvertimeMinutes > 0 ? Math.round(totalOvertimeMinutes * (hourlyRate / 60) * 100) / 100 : 0;
      const absenceAmount = absentDays > 0 ? Math.round(absentDays * dailyRate * 100) / 100 : 0;
      const lateThreshold = totalLateMinutes > 180;

      const employeeSS = ssEnabled ? Math.round(basicSalary * ssEmployeeRate * 100) / 100 : 0;
      const employerSS = ssEnabled ? Math.round(basicSalary * ssEmployerRate * 100) / 100 : 0;

      const manualDeductionsTotal = deductionsByEmp[emp.id] || 0;

      const netSalary = Math.round((basicSalary - employeeSS - lateAmount - absenceAmount - manualDeductionsTotal + overtimeAmount) * 100) / 100;

      insertStatements.push(
        db.prepare(
          `INSERT INTO hr_payslips (
            payroll_run_id, employee_id, month,
            basic_salary, employee_ss, employer_ss,
            suggested_late_minutes, suggested_late_amount, final_late_amount, late_threshold_exceeded,
            suggested_overtime_minutes, overtime_multiplier, suggested_overtime_amount, final_overtime_amount,
            suggested_absent_days, suggested_absence_amount, final_absence_amount,
            total_break_minutes, manual_deductions_total, net_salary,
            days_worked, total_work_minutes, status
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft')`
        ).bind(
          runId, emp.id, monthDate,
          basicSalary, employeeSS, employerSS,
          totalLateMinutes, lateAmount, lateAmount, lateThreshold ? 1 : 0,
          totalOvertimeMinutes, 1.00, overtimeAmount, overtimeAmount,
          absentDays, absenceAmount, absenceAmount,
          totalBreakMins, manualDeductionsTotal, netSalary,
          daysWorked, totalWorkMinutes,
        )
      );

      payslips.push({ employeeId: emp.id, employeeName: emp.full_name, netSalary });
    }

    // Execute all inserts in a batch (atomic)
    if (insertStatements.length > 0) {
      await db.batch(insertStatements);
    }

    return c.json({ runId, month, status: 'draft', totalEmployees: payslips.length, payslips });
  } catch (err) {
    console.error("POST /hr/payroll/generate error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.get("/payroll/run", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "Admin access required" }, 403);
  try {
    const db = c.env.DB;
    const month = c.req.query("month");
    if (!month) return c.json({ error: "month required" }, 400);

    const monthDate = month + '-01';

    const run = await db.prepare(
      `SELECT * FROM hr_payroll_runs WHERE month=?`
    ).bind(monthDate).first();
    if (!run) return c.json(null);

    const { results: payslipRows } = await db.prepare(
      `SELECT p.*, e.full_name AS employee_name
       FROM hr_payslips p
       JOIN hr_employees e ON e.id = p.employee_id
       WHERE p.payroll_run_id=? ORDER BY e.full_name`
    ).bind(run.id).all();

    return c.json({
      id: run.id,
      month: run.month,
      status: run.status,
      createdAt: run.created_at,
      payslips: payslipRows.map(p => ({
        id: p.id,
        employeeId: p.employee_id,
        employeeName: p.employee_name,
        basicSalary: parseFloat(p.basic_salary),
        employeeSs: parseFloat(p.employee_ss),
        employerSs: parseFloat(p.employer_ss),
        suggestedLateMinutes: p.suggested_late_minutes,
        suggestedLateAmount: parseFloat(p.suggested_late_amount),
        finalLateAmount: parseFloat(p.final_late_amount),
        lateThresholdExceeded: p.late_threshold_exceeded,
        suggestedOvertimeMinutes: p.suggested_overtime_minutes,
        overtimeMultiplier: parseFloat(p.overtime_multiplier),
        suggestedOvertimeAmount: parseFloat(p.suggested_overtime_amount),
        finalOvertimeAmount: parseFloat(p.final_overtime_amount),
        suggestedAbsentDays: p.suggested_absent_days,
        suggestedAbsenceAmount: parseFloat(p.suggested_absence_amount),
        finalAbsenceAmount: parseFloat(p.final_absence_amount),
        totalBreakMinutes: p.total_break_minutes,
        manualDeductionsTotal: parseFloat(p.manual_deductions_total),
        netSalary: parseFloat(p.net_salary),
        daysWorked: p.days_worked,
        totalWorkMinutes: p.total_work_minutes,
        status: p.status,
        rejectReason: p.reject_reason,
        pdfUrl: p.pdf_url,
      })),
    });
  } catch (err) {
    console.error("GET /hr/payroll/run error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.get("/payslips/:id", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "Admin access required" }, 403);
  try {
    const id = c.req.param("id");
    const p = await c.env.DB.prepare(
      `SELECT p.*, e.full_name AS employee_name
       FROM hr_payslips p
       JOIN hr_employees e ON e.id = p.employee_id
       WHERE p.id=?`
    ).bind(id).first();
    if (!p) return c.json({ error: "Payslip not found" }, 404);
    return c.json({
      id: p.id,
      employeeId: p.employee_id,
      employeeName: p.employee_name,
      basicSalary: parseFloat(p.basic_salary),
      employeeSs: parseFloat(p.employee_ss),
      employerSs: parseFloat(p.employer_ss),
      suggestedLateMinutes: p.suggested_late_minutes,
      suggestedLateAmount: parseFloat(p.suggested_late_amount),
      finalLateAmount: parseFloat(p.final_late_amount),
      lateThresholdExceeded: p.late_threshold_exceeded,
      suggestedOvertimeMinutes: p.suggested_overtime_minutes,
      overtimeMultiplier: parseFloat(p.overtime_multiplier),
      suggestedOvertimeAmount: parseFloat(p.suggested_overtime_amount),
      finalOvertimeAmount: parseFloat(p.final_overtime_amount),
      suggestedAbsentDays: p.suggested_absent_days,
      suggestedAbsenceAmount: parseFloat(p.suggested_absence_amount),
      finalAbsenceAmount: parseFloat(p.final_absence_amount),
      totalBreakMinutes: p.total_break_minutes,
      manualDeductionsTotal: parseFloat(p.manual_deductions_total),
      netSalary: parseFloat(p.net_salary),
      daysWorked: p.days_worked,
      totalWorkMinutes: p.total_work_minutes,
      status: p.status,
      rejectReason: p.reject_reason,
      pdfUrl: p.pdf_url,
    });
  } catch (err) {
    console.error("GET /hr/payslips/:id error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.patch("/payslips/:id", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "Admin access required" }, 403);
  try {
    const db = c.env.DB;
    const id = c.req.param("id");
    const { final_late_amount, final_overtime_amount, final_absence_amount, overtime_multiplier } = await c.req.json();

    const current = await db.prepare(
      `SELECT * FROM hr_payslips WHERE id=?`
    ).bind(id).first();
    if (!current) return c.json({ error: "Not found" }, 404);
    if (current.status !== 'draft') return c.json({ error: "Can only edit draft payslips" }, 400);

    const newLate = final_late_amount ?? parseFloat(current.final_late_amount);
    const newOT = final_overtime_amount ?? parseFloat(current.final_overtime_amount);
    const newAbsence = final_absence_amount ?? parseFloat(current.final_absence_amount);
    const newMultiplier = overtime_multiplier ?? parseFloat(current.overtime_multiplier);
    const adjustedOT = newOT * newMultiplier;

    const basicSalary = parseFloat(current.basic_salary);
    const employeeSS = parseFloat(current.employee_ss);
    const manualDeductions = parseFloat(current.manual_deductions_total);
    const netSalary = Math.round((basicSalary - employeeSS - newLate - newAbsence - manualDeductions + adjustedOT) * 100) / 100;

    await db.prepare(
      `UPDATE hr_payslips SET
         final_late_amount=?, final_overtime_amount=?, final_absence_amount=?,
         overtime_multiplier=?, net_salary=?, updated_at=datetime('now')
       WHERE id=?`
    ).bind(newLate, newOT, newAbsence, newMultiplier, netSalary, id).run();

    return c.json({ success: true, netSalary });
  } catch (err) {
    console.error("PATCH /hr/payslips/:id error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.post("/payslips/:id/approve", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "Admin access required" }, 403);
  try {
    const { id: userId } = c.get("user");
    const id = c.req.param("id");
    const { results } = await c.env.DB.prepare(
      `UPDATE hr_payslips SET status='approved', approved_by=?, approved_at=datetime('now'), updated_at=datetime('now')
       WHERE id=? AND status='draft' RETURNING id`
    ).bind(userId || null, id).all();
    if (!results.length) return c.json({ error: "Not found or not draft" }, 404);
    return c.json({ success: true });
  } catch (err) {
    console.error("POST /hr/payslips/:id/approve error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.post("/payslips/:id/reject", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "Admin access required" }, 403);
  try {
    const id = c.req.param("id");
    const { reason } = await c.req.json();
    const { results } = await c.env.DB.prepare(
      `UPDATE hr_payslips SET status='rejected', reject_reason=?, updated_at=datetime('now')
       WHERE id=? AND status='draft' RETURNING id`
    ).bind(reason || null, id).all();
    if (!results.length) return c.json({ error: "Not found or not draft" }, 404);
    return c.json({ success: true });
  } catch (err) {
    console.error("POST /hr/payslips/:id/reject error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.post("/payroll/close-month", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "Admin access required" }, 403);
  try {
    const db = c.env.DB;
    const { month } = await c.req.json();
    if (!month) return c.json({ error: "month required" }, 400);

    const monthDate = month + '-01';

    const pending = await db.prepare(
      `SELECT COUNT(*) AS cnt FROM hr_payslips
       WHERE month=? AND status='draft'`
    ).bind(monthDate).first();
    if (parseInt(pending.cnt) > 0) {
      return c.json({ error: "All payslips must be approved or rejected before closing" }, 400);
    }

    await db.prepare(
      `UPDATE hr_payroll_runs SET status='closed' WHERE month=?`
    ).bind(monthDate).run();

    return c.json({ success: true });
  } catch (err) {
    console.error("POST /hr/payroll/close-month error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

// ============================================================
//  LEAVE MANAGEMENT
// ============================================================

app.post("/leaves", async (c) => {
  if (!requireHrEmployee(c)) return c.json({ error: "HR employee access required" }, 403);
  try {
    const db = c.env.DB;
    const { hr_employee_id } = c.get("user");
    const { leave_type, start_date, end_date, reason } = await c.req.json();

    if (!leave_type || !start_date || !end_date) {
      return c.json({ error: "leave_type, start_date, end_date are required" }, 400);
    }
    if (!["annual", "sick"].includes(leave_type)) {
      return c.json({ error: "leave_type must be 'annual' or 'sick'" }, 400);
    }

    const s = new Date(start_date);
    const e = new Date(end_date);
    if (isNaN(s.getTime()) || isNaN(e.getTime()) || e < s) {
      return c.json({ error: "Invalid date range" }, 400);
    }
    const duration_days = Math.round((e - s) / 86400000) + 1;

    const now = Date.now();
    const { results } = await db.prepare(
      `INSERT INTO hr_leave_requests (employee_id, leave_type, start_date, end_date, duration_days, reason, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)
       RETURNING *`
    ).bind(hr_employee_id, leave_type, start_date, end_date, duration_days, reason || null, now, now).all();

    const r = results[0];
    return c.json({
      id: r.id,
      employeeId: r.employee_id,
      leaveType: r.leave_type,
      startDate: r.start_date,
      endDate: r.end_date,
      durationDays: r.duration_days,
      reason: r.reason,
      status: r.status,
      createdAt: Number(r.created_at),
    }, 201);
  } catch (err) {
    console.error("POST /hr/leaves error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.get("/leaves/me", async (c) => {
  if (!requireHrEmployee(c)) return c.json({ error: "HR employee access required" }, 403);
  try {
    const { hr_employee_id } = c.get("user");
    const { results } = await c.env.DB.prepare(
      `SELECT lr.*, e.full_name AS approved_by_name
       FROM hr_leave_requests lr
       LEFT JOIN hr_employees e ON e.id = lr.approved_by
       WHERE lr.employee_id=?
       ORDER BY lr.created_at DESC`
    ).bind(hr_employee_id).all();
    return c.json(results.map(r => ({
      id: r.id,
      employeeId: r.employee_id,
      leaveType: r.leave_type,
      startDate: r.start_date,
      endDate: r.end_date,
      durationDays: r.duration_days,
      reason: r.reason,
      status: r.status,
      rejectionReason: r.rejection_reason,
      approvedByName: r.approved_by_name,
      approvedAt: r.approved_at ? Number(r.approved_at) : null,
      createdAt: Number(r.created_at),
    })));
  } catch (err) {
    console.error("GET /hr/leaves/me error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.delete("/leaves/:id", async (c) => {
  if (!requireHrEmployee(c)) return c.json({ error: "HR employee access required" }, 403);
  try {
    const db = c.env.DB;
    const { hr_employee_id } = c.get("user");
    const id = c.req.param("id");
    const row = await db.prepare(
      `SELECT * FROM hr_leave_requests WHERE id=? AND employee_id=?`
    ).bind(id, hr_employee_id).first();
    if (!row) return c.json({ error: "Not found" }, 404);
    if (row.status !== "pending") {
      return c.json({ error: "Can only cancel pending requests" }, 400);
    }
    await db.prepare(
      `UPDATE hr_leave_requests SET status='cancelled', updated_at=? WHERE id=?`
    ).bind(Date.now(), id).run();
    return c.json({ success: true });
  } catch (err) {
    console.error("DELETE /hr/leaves/:id error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.get("/leaves", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "Admin access required" }, 403);
  try {
    const db = c.env.DB;
    const status = c.req.query("status");
    const employee_id = c.req.query("employee_id");

    let sql = `SELECT lr.*, e.full_name AS employee_name
               FROM hr_leave_requests lr
               JOIN hr_employees e ON e.id = lr.employee_id
               WHERE 1=1`;
    const params = [];

    if (status) { sql += ` AND lr.status=?`; params.push(status); }
    if (employee_id) { sql += ` AND lr.employee_id=?`; params.push(employee_id); }
    sql += ` ORDER BY lr.created_at DESC`;

    const { results } = await db.prepare(sql).bind(...params).all();
    return c.json(results.map(r => ({
      id: r.id,
      employeeId: r.employee_id,
      employeeName: r.employee_name,
      leaveType: r.leave_type,
      startDate: r.start_date,
      endDate: r.end_date,
      durationDays: r.duration_days,
      reason: r.reason,
      status: r.status,
      rejectionReason: r.rejection_reason,
      createdAt: Number(r.created_at),
    })));
  } catch (err) {
    console.error("GET /hr/leaves error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.post("/leaves/:id/approve", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "Admin access required" }, 403);
  try {
    const db = c.env.DB;
    const { uid } = c.get("user");
    const id = c.req.param("id");
    const row = await db.prepare(
      `SELECT * FROM hr_leave_requests WHERE id=?`
    ).bind(id).first();
    if (!row) return c.json({ error: "Not found" }, 404);
    if (row.status !== "pending") {
      return c.json({ error: "Can only approve pending requests" }, 400);
    }
    const now = Date.now();
    await db.prepare(
      `UPDATE hr_leave_requests SET status='approved', approved_by=?, approved_at=?, updated_at=? WHERE id=?`
    ).bind(uid, now, now, id).run();
    return c.json({ success: true });
  } catch (err) {
    console.error("POST /hr/leaves/:id/approve error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.post("/leaves/:id/reject", async (c) => {
  if (!requireAdmin(c)) return c.json({ error: "Admin access required" }, 403);
  try {
    const db = c.env.DB;
    const id = c.req.param("id");
    const { reason } = await c.req.json();
    const row = await db.prepare(
      `SELECT * FROM hr_leave_requests WHERE id=?`
    ).bind(id).first();
    if (!row) return c.json({ error: "Not found" }, 404);
    if (row.status !== "pending") {
      return c.json({ error: "Can only reject pending requests" }, 400);
    }
    await db.prepare(
      `UPDATE hr_leave_requests SET status='rejected', rejection_reason=?, updated_at=? WHERE id=?`
    ).bind(reason || null, Date.now(), id).run();
    return c.json({ success: true });
  } catch (err) {
    console.error("POST /hr/leaves/:id/reject error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.get("/leaves/balance/:employeeId", async (c) => {
  try {
    const { role, type, hr_employee_id } = c.get("user");
    const empId = parseInt(c.req.param("employeeId"));

    if (role !== "admin" && (type !== "hr_employee" || hr_employee_id !== empId)) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const year = new Date().getFullYear();
    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;

    const { results } = await c.env.DB.prepare(
      `SELECT leave_type,
              COALESCE(SUM(duration_days), 0) AS used_days
       FROM hr_leave_requests
       WHERE employee_id=?
         AND status='approved'
         AND start_date >= ? AND start_date <= ?
       GROUP BY leave_type`
    ).bind(empId, yearStart, yearEnd).all();

    const annualUsed = Number(results.find(r => r.leave_type === 'annual')?.used_days || 0);
    const sickUsed = Number(results.find(r => r.leave_type === 'sick')?.used_days || 0);

    return c.json({
      year,
      annual: { quota: 14, used: annualUsed, remaining: 14 - annualUsed },
      sick: { quota: 14, used: sickUsed, remaining: 14 - sickUsed },
    });
  } catch (err) {
    console.error("GET /hr/leaves/balance error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

export default app;
