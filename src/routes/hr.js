import express from "express";
import bcrypt from "bcrypt";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import PDFDocument from "pdfkit";
import pool from "../db.js";
import { auth } from "../middleware/auth.js";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";

const router = express.Router();

// PDF route BEFORE global auth â€” handles its own token via header
router.get("/payslips/:id/pdf", async (req, res) => {
  try {
    const header = req.headers.authorization;
    const token = header && header.startsWith("Bearer ") ? header.split(" ")[1] : null;
    if (!token) return res.status(401).json({ error: "No token provided" });

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ error: "Invalid token" });
    }

    const { client_id, role, type, hr_employee_id } = decoded;
    const { id } = req.params;

    // Only admin, super_admin, or the employee themselves can download payslips
    if (role !== "admin" && type !== "hr_employee" && type !== "super_admin") {
      return res.status(403).json({ error: "Forbidden" });
    }

    const { rows } = await pool.query(
      `SELECT p.*, e.full_name AS employee_name, e.department, e.job_title
       FROM hr_payslips p
       JOIN hr_employees e ON e.id = p.employee_id
       WHERE p.id=$1 AND p.client_id=$2`,
      [id, client_id]
    );
    if (!rows.length) return res.status(404).json({ error: "Payslip not found" });
    const p = rows[0];

    // HR employees can only download their own payslips
    if (type === "hr_employee" && p.employee_id !== hr_employee_id) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const clientRes = await pool.query(`SELECT name FROM clients WHERE id=$1`, [client_id]);
    const clientName = clientRes.rows.length ? clientRes.rows[0].name : 'MED LOOP';

    const monthDate = new Date(p.month);
    const monthLabel = monthDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long' });

    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="payslip-${id}-${monthLabel.replace(/\s/g, '-')}.pdf"`);
    doc.pipe(res);

    const num = (v) => parseFloat(v) || 0;
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
    doc.text(`Generated by MED LOOP HR System â€” ${new Date().toISOString().slice(0, 10)}`, 50, 770, { align: 'center' });
    doc.end();
  } catch (err) {
    console.error("GET /hr/payslips/:id/pdf error:", err);
    if (!res.headersSent) res.status(500).json({ error: "Server error" });
  }
});

// Global auth for all other routes
router.use(auth);

// ============================================================
//  CONSTANTS / HELPERS
// ============================================================

/** Relying-party config for WebAuthn (must match the HTTPS origin) */
const RP_NAME = "MED LOOP HR";
const RP_ID_PROD = "med.loopjo.com";
const RP_ORIGIN_PROD = "https://med.loopjo.com";
const RP_ID_DEV = "localhost";
const RP_ORIGIN_DEV = "http://localhost:3000";

function rpConfig() {
  const isProd = process.env.NODE_ENV === "production" ||
    !process.env.NODE_ENV; // default to prod on Render
  return {
    rpID: isProd ? RP_ID_PROD : RP_ID_DEV,
    rpName: RP_NAME,
    origin: isProd ? RP_ORIGIN_PROD : RP_ORIGIN_DEV,
  };
}

/** Haversine distance between two lat/lng pairs -> metres */
function haversineMetres(lat1, lng1, lat2, lng2) {
  const R = 6_371_000; // Earth radius in metres
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function requireAdmin(req, res) {
  if (req.user.role !== "admin") {
    res.status(403).json({ error: "Admin access required" });
    return false;
  }
  return true;
}

function requireHrEmployee(req, res) {
  if (req.user.type !== "hr_employee") {
    res.status(403).json({ error: "HR employee access required" });
    return false;
  }
  return true;
}

// ============================================================
//  DEBUG: WebAuthn diagnostic (dev only)
// ============================================================
if (process.env.NODE_ENV !== "production") {
  router.get("/webauthn/debug", async (req, res) => {
    const config = rpConfig();
    const credCount = await pool.query(
      `SELECT COUNT(*) AS cnt FROM hr_biometric_credentials WHERE employee_id=$1`,
      [req.user.hr_employee_id || 0]
    );
    const challengeCount = await pool.query(
      `SELECT type, COUNT(*) AS cnt FROM hr_webauthn_challenges WHERE employee_id=$1 GROUP BY type`,
      [req.user.hr_employee_id || 0]
    );
    res.json({
      rpID: config.rpID,
      expectedOrigin: config.origin,
      rpName: config.rpName,
      yourEmployeeId: req.user.hr_employee_id || null,
      savedCredentials: Number(credCount.rows[0]?.cnt || 0),
      pendingChallenges: challengeCount.rows,
      serverTime: new Date().toISOString(),
    });
  });
}

// ============================================================
//  1. CLINIC LOCATION  (admin)
// ============================================================

/**
 * PATCH /hr/clinic/location
 * Body: { clinic_id, latitude, longitude, allowed_radius_meters }
 */
router.patch("/clinic/location", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { client_id } = req.user;
    const { clinic_id, latitude, longitude, allowed_radius_meters } = req.body;
    if (latitude == null || longitude == null) {
      return res.status(400).json({ error: "latitude and longitude required" });
    }
    const radius = allowed_radius_meters ?? 100;

    // If clinic_id provided, update that clinic; otherwise update first clinic of client
    let query, params;
    if (clinic_id) {
      query = `UPDATE clinics SET latitude=$1, longitude=$2, allowed_radius_meters=$3,
               location_updated_at=NOW() WHERE id=$4 AND client_id=$5 RETURNING *`;
      params = [latitude, longitude, radius, clinic_id, client_id];
    } else {
      query = `UPDATE clinics SET latitude=$1, longitude=$2, allowed_radius_meters=$3,
               location_updated_at=NOW() WHERE client_id=$4 AND id=(SELECT id FROM clinics WHERE client_id=$4 ORDER BY id LIMIT 1)
               RETURNING *`;
      params = [latitude, longitude, radius, client_id];
    }

    const { rows } = await pool.query(query, params);
    if (!rows.length) return res.status(404).json({ error: "Clinic not found" });
    res.json({
      clinic_id: rows[0].id,
      latitude: rows[0].latitude,
      longitude: rows[0].longitude,
      allowed_radius_meters: rows[0].allowed_radius_meters,
    });
  } catch (err) {
    console.error("PATCH /hr/clinic/location error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * GET /hr/clinic/location
 * Returns location of the client's clinics
 */
router.get("/clinic/location", async (req, res) => {
  try {
    const { client_id } = req.user;
    const { rows } = await pool.query(
      `SELECT id, name, latitude, longitude, allowed_radius_meters
       FROM clinics WHERE client_id=$1 ORDER BY id`,
      [client_id]
    );
    res.json(rows);
  } catch (err) {
    console.error("GET /hr/clinic/location error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ============================================================
//  2. EMPLOYEES CRUD  (admin)
// ============================================================

/** GET /hr/employees */
router.get("/employees", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { client_id } = req.user;
    const { rows } = await pool.query(
      `SELECT e.*,
              (SELECT COUNT(*) FROM hr_biometric_credentials bc WHERE bc.employee_id=e.id) AS bio_count,
              s.work_days, s.start_time, s.end_time, s.grace_minutes, s.overtime_enabled
       FROM hr_employees e
       LEFT JOIN LATERAL (
         SELECT * FROM hr_work_schedules ws
         WHERE ws.employee_id=e.id AND ws.effective_from <= CURRENT_DATE
           AND (ws.effective_to IS NULL OR ws.effective_to >= CURRENT_DATE)
         ORDER BY ws.effective_from DESC LIMIT 1
       ) s ON true
       WHERE e.client_id=$1
       ORDER BY e.created_at DESC`,
      [client_id]
    );
    res.json(
      rows.map((r) => ({
        id: r.id,
        clientId: r.client_id,
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
    res.status(500).json({ error: "Server error" });
  }
});

/** POST /hr/employees */
router.post("/employees", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { client_id } = req.user;
    const {
      full_name,
      username,
      password,
      phone,
      email,
      work_days,
      start_time,
      end_time,
      grace_minutes,
      overtime_enabled,
      basic_salary,
      role,
    } = req.body;

    if (!full_name || !username || !password) {
      return res
        .status(400)
        .json({ error: "full_name, username, password required" });
    }

    // Check uniqueness
    const dup = await pool.query(
      `SELECT id FROM hr_employees WHERE client_id=$1 AND username=$2`,
      [client_id, username]
    );
    if (dup.rows.length) {
      return res
        .status(409)
        .json({ error: "Username already exists for this client" });
    }

    const hash = await bcrypt.hash(password, 10);

    const { rows } = await pool.query(
      `INSERT INTO hr_employees (client_id, full_name, username, password, phone, email, basic_salary, role)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [client_id, full_name, username, hash, phone || null, email || null, basic_salary || 0, role || 'HR_EMPLOYEE']
    );

    const empId = rows[0].id;

    // Create initial schedule
    await pool.query(
      `INSERT INTO hr_work_schedules
         (client_id, employee_id, work_days, start_time, end_time, grace_minutes, overtime_enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        client_id,
        empId,
        JSON.stringify(work_days || [1, 2, 3, 4, 5]),
        start_time || "09:00",
        end_time || "17:00",
        grace_minutes ?? 10,
        overtime_enabled !== false,
      ]
    );

    res.status(201).json({ id: empId, username: rows[0].username });
  } catch (err) {
    console.error("POST /hr/employees error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/** PUT /hr/employees/:id */
router.put("/employees/:id", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { client_id } = req.user;
    const { id } = req.params;
    const { full_name, phone, email, status, work_days, start_time, end_time, grace_minutes, overtime_enabled, basic_salary, role } =
      req.body;

    // Update employee row
    const { rows } = await pool.query(
      `UPDATE hr_employees SET
         full_name=COALESCE($1, full_name),
         phone=COALESCE($2, phone),
         email=COALESCE($3, email),
         status=COALESCE($4, status),
         basic_salary=COALESCE($5, basic_salary),
         role=COALESCE($6, role),
         updated_at=NOW()
       WHERE id=$7 AND client_id=$8 RETURNING *`,
      [full_name, phone, email, status, basic_salary, role, id, client_id]
    );
    if (!rows.length) return res.status(404).json({ error: "Employee not found" });

    // Update schedule if schedule fields provided
    if (work_days || start_time || end_time || grace_minutes != null || overtime_enabled != null) {
      // Close old schedule
      await pool.query(
        `UPDATE hr_work_schedules SET effective_to=CURRENT_DATE
         WHERE employee_id=$1 AND client_id=$2 AND effective_to IS NULL`,
        [id, client_id]
      );
      // Insert new schedule
      await pool.query(
        `INSERT INTO hr_work_schedules
           (client_id, employee_id, work_days, start_time, end_time, grace_minutes, overtime_enabled)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          client_id,
          id,
          JSON.stringify(work_days || [1, 2, 3, 4, 5]),
          start_time || "09:00",
          end_time || "17:00",
          grace_minutes ?? 10,
          overtime_enabled !== false,
        ]
      );
    }

    res.json({ message: "Updated" });
  } catch (err) {
    console.error("PUT /hr/employees/:id error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/** DELETE /hr/employees/:id  (soft deactivate) */
router.delete("/employees/:id", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { client_id } = req.user;
    const { id } = req.params;
    const { rows } = await pool.query(
      `UPDATE hr_employees SET status='inactive', updated_at=NOW()
       WHERE id=$1 AND client_id=$2 RETURNING id`,
      [id, client_id]
    );
    if (!rows.length) return res.status(404).json({ error: "Employee not found" });
    res.json({ message: "Deactivated" });
  } catch (err) {
    console.error("DELETE /hr/employees/:id error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/** POST /hr/employees/:id/reset-password */
router.post("/employees/:id/reset-password", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { client_id } = req.user;
    const { id } = req.params;
    const { password } = req.body;
    const newPass = password || crypto.randomBytes(6).toString("base64url");
    const hash = await bcrypt.hash(newPass, 10);
    const { rows } = await pool.query(
      `UPDATE hr_employees SET password=$1, updated_at=NOW()
       WHERE id=$2 AND client_id=$3 RETURNING id`,
      [hash, id, client_id]
    );
    if (!rows.length) return res.status(404).json({ error: "Employee not found" });
    res.json({ password: newPass }); // Return plaintext one-time so admin can share
  } catch (err) {
    console.error("POST /hr/employees/:id/reset-password error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ============================================================
//  3. EMPLOYEE SELF  (hr_employee)
// ============================================================

/** GET /hr/me */
router.get("/me", async (req, res) => {
  if (!requireHrEmployee(req, res)) return;
  try {
    const { hr_employee_id, client_id } = req.user;

    const emp = await pool.query(
      `SELECT * FROM hr_employees WHERE id=$1 AND client_id=$2`,
      [hr_employee_id, client_id]
    );
    if (!emp.rows.length) return res.status(404).json({ error: "Not found" });
    const e = emp.rows[0];

    // Current schedule
    const sched = await pool.query(
      `SELECT * FROM hr_work_schedules
       WHERE employee_id=$1 AND client_id=$2
         AND effective_from <= CURRENT_DATE
         AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
       ORDER BY effective_from DESC LIMIT 1`,
      [hr_employee_id, client_id]
    );

    // PIN set?
    const hasPIN = !!e.pin_hash;

    // Biometric count
    const bio = await pool.query(
      `SELECT COUNT(*) AS cnt FROM hr_biometric_credentials
       WHERE employee_id=$1 AND client_id=$2`,
      [hr_employee_id, client_id]
    );

    // Today attendance
    const today = await pool.query(
      `SELECT * FROM hr_attendance
       WHERE employee_id=$1 AND client_id=$2 AND work_date=CURRENT_DATE`,
      [hr_employee_id, client_id]
    );

    const result = {
      id: e.id,
      fullName: e.full_name,
      username: e.username,
      phone: e.phone,
      email: e.email,
      status: e.status,
      pinSet: hasPIN,
      bioRegistered: Number(bio.rows[0].cnt) > 0,
      bioCount: Number(bio.rows[0].cnt),
      schedule: sched.rows[0]
        ? {
            workDays: sched.rows[0].work_days,
            startTime: sched.rows[0].start_time,
            endTime: sched.rows[0].end_time,
            graceMinutes: sched.rows[0].grace_minutes,
            overtimeEnabled: sched.rows[0].overtime_enabled,
          }
        : null,
      role: e.role || 'HR_EMPLOYEE',
      basicSalary: parseFloat(e.basic_salary) || 0,
    };

    // Check if currently on break
    let onBreak = false;
    if (today.rows[0] && today.rows[0].check_in && !today.rows[0].check_out) {
      const lastEvt = await pool.query(
        `SELECT event_type FROM hr_attendance_events
         WHERE employee_id=$1 AND client_id=$2 AND work_date=CURRENT_DATE
         ORDER BY event_time DESC LIMIT 1`,
        [hr_employee_id, client_id]
      );
      if (lastEvt.rows.length && lastEvt.rows[0].event_type === 'break_out') {
        onBreak = true;
      }
    }

    result.todayAttendance = today.rows[0]
      ? {
          checkIn: today.rows[0].check_in,
          checkOut: today.rows[0].check_out,
          totalMinutes: today.rows[0].total_minutes,
          lateMinutes: today.rows[0].late_minutes,
          overtimeMinutes: today.rows[0].overtime_minutes,
          totalBreakMinutes: today.rows[0].total_break_minutes || 0,
          netWorkMinutes: today.rows[0].net_work_minutes || 0,
          onBreak,
          status: today.rows[0].status,
        }
      : null;

    res.json(result);
  } catch (err) {
    console.error("GET /hr/me error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ============================================================
//  4. PIN CODE  (hr_employee)
// ============================================================

/** POST /hr/me/set-pin â€” set/update employee's 4-digit PIN */
router.post("/me/set-pin", async (req, res) => {
  if (!requireHrEmployee(req, res)) return;
  try {
    const { hr_employee_id, client_id } = req.user;
    const { pin } = req.body;
    if (!pin || !/^\d{4,6}$/.test(pin)) {
      return res.status(400).json({ error: "PIN must be 4-6 digits" });
    }
    const hash = await bcrypt.hash(pin, 10);
    await pool.query(
      `UPDATE hr_employees SET pin_hash=$1, updated_at=NOW() WHERE id=$2 AND client_id=$3`,
      [hash, hr_employee_id, client_id]
    );
    res.json({ success: true, message: "PIN set successfully" });
  } catch (err) {
    console.error("POST /hr/me/set-pin error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ============================================================
//  4b. WEBAUTHN  REGISTER  (hr_employee)
// ============================================================

/** POST /hr/webauthn/register/options */
router.post("/webauthn/register/options", async (req, res) => {
  if (!requireHrEmployee(req, res)) return;
  try {
    const { hr_employee_id, client_id } = req.user;
    const { rpID, rpName } = rpConfig();

    const emp = await pool.query(
      `SELECT id, full_name, username FROM hr_employees WHERE id=$1 AND client_id=$2`,
      [hr_employee_id, client_id]
    );
    if (!emp.rows.length) return res.status(404).json({ error: "Not found" });
    const e = emp.rows[0];

    // Existing credentials to exclude
    const existing = await pool.query(
      `SELECT credential_id FROM hr_biometric_credentials WHERE employee_id=$1`,
      [hr_employee_id]
    );

    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userID: new TextEncoder().encode(String(e.id)),
      userName: e.username,
      userDisplayName: e.full_name,
      excludeCredentials: existing.rows.map((r) => ({
        id: r.credential_id,
        type: "public-key",
      })),
      authenticatorSelection: {
        authenticatorAttachment: "platform",   // LOCAL device only (Face ID / Fingerprint)
        userVerification: "required",
        residentKey: "preferred",              // Prefer discoverable but don't fail if not possible
      },
      attestationType: "none",
    });

    console.log("[WebAuthn Reg Options] rpID:", rpID, "employee:", e.username, "challenge:", options.challenge?.slice(0, 10) + "...");

    // Store challenge
    await pool.query(
      `DELETE FROM hr_webauthn_challenges WHERE employee_id=$1 AND type='register'`,
      [hr_employee_id]
    );
    await pool.query(
      `INSERT INTO hr_webauthn_challenges (employee_id, challenge, type)
       VALUES ($1, $2, 'register')`,
      [hr_employee_id, options.challenge]
    );

    res.json(options);
  } catch (err) {
    console.error("POST /hr/webauthn/register/options error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/** POST /hr/webauthn/register/verify */
router.post("/webauthn/register/verify", async (req, res) => {
  if (!requireHrEmployee(req, res)) return;
  try {
    const { hr_employee_id, client_id } = req.user;
    const { rpID, origin } = rpConfig();

    // Retrieve stored challenge
    const ch = await pool.query(
      `SELECT challenge FROM hr_webauthn_challenges
       WHERE employee_id=$1 AND type='register' AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [hr_employee_id]
    );
    if (!ch.rows.length) return res.status(400).json({ error: "Challenge expired" });

    const verification = await verifyRegistrationResponse({
      response: req.body,
      expectedChallenge: ch.rows[0].challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
    });

    console.log("[WebAuthn Reg Verify] verified:", verification.verified, "rpID:", rpID, "origin:", origin);

    if (!verification.verified || !verification.registrationInfo) {
      console.error("[WebAuthn Reg Verify] FAILED â€” verified:", verification.verified);
      return res.status(400).json({ error: "Verification failed" });
    }

    const { credential, credentialDeviceType } = verification.registrationInfo;
    // In @simplewebauthn/server v10+, credential.id is ALREADY a Base64URLString (string).
    // credential.publicKey is Uint8Array and needs Buffer conversion.
    const credIdB64 = typeof credential.id === "string"
      ? credential.id
      : Buffer.from(credential.id).toString("base64url");
    const pubKeyB64 = Buffer.from(credential.publicKey).toString("base64url");
    console.log("[WebAuthn Reg Verify] credentialId:", credIdB64.slice(0, 20) + "...", "type:", credentialDeviceType, "idType:", typeof credential.id);

    await pool.query(
      `INSERT INTO hr_biometric_credentials
         (client_id, employee_id, credential_id, public_key, counter, transports, device_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        client_id,
        hr_employee_id,
        credIdB64,
        pubKeyB64,
        credential.counter,
        JSON.stringify((req.body.response?.transports || []).filter(t => t !== "hybrid")),
        req.body.deviceName || credentialDeviceType || "Unknown",
      ]
    );

    // Cleanup challenge
    await pool.query(
      `DELETE FROM hr_webauthn_challenges WHERE employee_id=$1 AND type='register'`,
      [hr_employee_id]
    );

    console.log("[WebAuthn Reg Verify] SUCCESS â€” credential saved for employee:", hr_employee_id);
    res.json({ verified: true });
  } catch (err) {
    console.error("POST /hr/webauthn/register/verify error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ============================================================
//  4c. RESET BIOMETRIC  (hr_employee)
// ============================================================

/** DELETE /hr/webauthn/reset â€” clears all credentials for this employee */
router.delete("/webauthn/reset", async (req, res) => {
  if (!requireHrEmployee(req, res)) return;
  try {
    const { hr_employee_id } = req.user;
    const del = await pool.query(
      `DELETE FROM hr_biometric_credentials WHERE employee_id=$1`,
      [hr_employee_id]
    );
    await pool.query(
      `DELETE FROM hr_webauthn_challenges WHERE employee_id=$1`,
      [hr_employee_id]
    );
    console.log("[WebAuthn Reset] Cleared", del.rowCount, "credentials for employee:", hr_employee_id);
    res.json({ cleared: del.rowCount });
  } catch (err) {
    console.error("DELETE /hr/webauthn/reset error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ============================================================
//  5. WEBAUTHN  AUTHENTICATE  (hr_employee)
// ============================================================

/** POST /hr/webauthn/authenticate/options */
router.post("/webauthn/authenticate/options", async (req, res) => {
  if (!requireHrEmployee(req, res)) return;
  try {
    const { hr_employee_id } = req.user;
    const { rpID } = rpConfig();

    const creds = await pool.query(
      `SELECT credential_id, transports FROM hr_biometric_credentials WHERE employee_id=$1`,
      [hr_employee_id]
    );
    if (!creds.rows.length) {
      return res.status(400).json({ error: "No biometric registered", code: "NO_BIOMETRIC" });
    }

    const options = await generateAuthenticationOptions({
      rpID,
      // Send stored credential IDs so browser picks ONLY passkeys that exist in our DB
      allowCredentials: creds.rows.map((r) => ({
        id: r.credential_id,
        type: "public-key",
        // ONLY "internal" â€” never "hybrid" which triggers QR popup
        transports: ["internal"],
      })),
      userVerification: "required",
    });

    console.log("[WebAuthn Auth Options] rpID:", rpID, "creds:", creds.rows.length, "employee:", hr_employee_id);

    await pool.query(
      `DELETE FROM hr_webauthn_challenges WHERE employee_id=$1 AND type='authenticate'`,
      [hr_employee_id]
    );
    await pool.query(
      `INSERT INTO hr_webauthn_challenges (employee_id, challenge, type)
       VALUES ($1, $2, 'authenticate')`,
      [hr_employee_id, options.challenge]
    );

    res.json(options);
  } catch (err) {
    console.error("POST /hr/webauthn/authenticate/options error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/** POST /hr/webauthn/authenticate/verify */
router.post("/webauthn/authenticate/verify", async (req, res) => {
  if (!requireHrEmployee(req, res)) return;
  try {
    const { hr_employee_id } = req.user;
    const { rpID, origin } = rpConfig();

    const ch = await pool.query(
      `SELECT challenge FROM hr_webauthn_challenges
       WHERE employee_id=$1 AND type='authenticate' AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [hr_employee_id]
    );
    if (!ch.rows.length) return res.status(400).json({ error: "Challenge expired" });

    // Find credential
    const credIdFromBody = req.body.id; // base64url credential id
    console.log("[WebAuthn Auth Verify] Looking for credential:", credIdFromBody?.slice(0, 30));
    
    const cred = await pool.query(
      `SELECT * FROM hr_biometric_credentials
       WHERE employee_id=$1 AND credential_id=$2`,
      [hr_employee_id, credIdFromBody]
    );
    
    if (!cred.rows.length) {
      // Log all stored credential IDs for debugging
      const allCreds = await pool.query(
        `SELECT credential_id FROM hr_biometric_credentials WHERE employee_id=$1`,
        [hr_employee_id]
      );
      console.error("[WebAuthn Auth Verify] Credential NOT FOUND. Body id:", credIdFromBody);
      console.error("[WebAuthn Auth Verify] Stored credentials:", allCreds.rows.map(r => r.credential_id));
      return res.status(400).json({ error: "Credential not found", code: "CRED_NOT_FOUND" });
    }

    const storedCred = cred.rows[0];
    console.log("[WebAuthn Auth Verify] Found credential id:", storedCred.id, "counter:", storedCred.counter);

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: req.body,
        expectedChallenge: ch.rows[0].challenge,
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
      return res.status(400).json({ error: "Biometric verification failed" });
    }

    console.log("[WebAuthn Auth Verify] verified:", verification.verified);

    if (!verification.verified) {
      return res.status(400).json({ error: "Biometric verification failed" });
    }

    // Update counter
    await pool.query(
      `UPDATE hr_biometric_credentials SET counter=$1 WHERE id=$2`,
      [verification.authenticationInfo.newCounter, storedCred.id]
    );

    // Cleanup authenticate challenge
    await pool.query(
      `DELETE FROM hr_webauthn_challenges WHERE employee_id=$1 AND type='authenticate'`,
      [hr_employee_id]
    );

    // Generate a one-time bioToken (2 min expiry) for use in check-in/check-out
    const bioToken = crypto.randomUUID();
    await pool.query(
      `INSERT INTO hr_webauthn_challenges (employee_id, challenge, type, expires_at)
       VALUES ($1, $2, 'bio_token', NOW() + interval '2 minutes')`,
      [hr_employee_id, bioToken]
    );

    res.json({ verified: true, bioToken });
  } catch (err) {
    console.error("POST /hr/webauthn/authenticate/verify error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ============================================================
//  6. ATTENDANCE CHECK-IN / CHECK-OUT
// ============================================================

/**
 * Shared: validate geo-fence and return clinic location
 */
async function validateGeoFence(client_id, latitude, longitude) {
  // Get clinics with location configured
  const { rows } = await pool.query(
    `SELECT id, name, latitude, longitude, allowed_radius_meters
     FROM clinics WHERE client_id=$1 AND latitude IS NOT NULL AND longitude IS NOT NULL`,
    [client_id]
  );
  if (!rows.length) {
    return { ok: false, error: "NO_CLINIC_LOCATION", message: "No clinic location configured. Ask admin to set clinic location." };
  }

  // Check if inside ANY clinic radius
  for (const clinic of rows) {
    const dist = haversineMetres(latitude, longitude, clinic.latitude, clinic.longitude);
    if (dist <= clinic.allowed_radius_meters) {
      return { ok: true, clinic, distance: Math.round(dist) };
    }
  }

  // Outside all clinics
  const nearest = rows[0];
  const dist = haversineMetres(latitude, longitude, nearest.latitude, nearest.longitude);
  return {
    ok: false,
    error: "OUTSIDE_RANGE",
    message: `You are ${Math.round(dist)}m from ${nearest.name}. Max allowed: ${nearest.allowed_radius_meters}m.`,
    distance: Math.round(dist),
  };
}

/**
 * Get active schedule for employee on a given date
 */
async function getScheduleForDate(employeeId, clientId, date) {
  const { rows } = await pool.query(
    `SELECT * FROM hr_work_schedules
     WHERE employee_id=$1 AND client_id=$2
       AND effective_from <= $3
       AND (effective_to IS NULL OR effective_to >= $3)
     ORDER BY effective_from DESC LIMIT 1`,
    [employeeId, clientId, date]
  );
  return rows[0] || null;
}

/**
 * Compute attendance metrics after check-out
 */
function computeAttendance(checkIn, checkOut, schedule) {
  if (!checkIn || !checkOut || !schedule) return {};

  const ciDate = new Date(checkIn);
  const coDate = new Date(checkOut);

  // Parse schedule times (HH:MM) on the same day as check-in
  const [sh, sm] = schedule.start_time.split(":").map(Number);
  const [eh, em] = schedule.end_time.split(":").map(Number);

  const schedStart = new Date(ciDate);
  schedStart.setHours(sh, sm, 0, 0);
  const schedEnd = new Date(ciDate);
  schedEnd.setHours(eh, em, 0, 0);

  const totalMinutes = Math.max(0, Math.round((coDate - ciDate) / 60000));

  // Late = minutes after start + grace
  const lateMs = ciDate - schedStart;
  const lateRaw = Math.round(lateMs / 60000);
  const lateMinutes = Math.max(0, lateRaw - (schedule.grace_minutes || 0));

  // Early leave
  const earlyLeaveMs = schedEnd - coDate;
  const earlyLeaveMinutes = earlyLeaveMs > 0 ? Math.round(earlyLeaveMs / 60000) : 0;

  // Overtime
  const overtimeMs = coDate - schedEnd;
  const overtimeMinutes = schedule.overtime_enabled && overtimeMs > 0 ? Math.round(overtimeMs / 60000) : 0;

  let status = "normal";
  if (lateMinutes > 0) status = "late";

  return { totalMinutes, lateMinutes, earlyLeaveMinutes, overtimeMinutes, status };
}

/** POST /hr/attendance/check-in */
router.post("/attendance/check-in", async (req, res) => {
  if (!requireHrEmployee(req, res)) return;
  try {
    const { hr_employee_id, client_id } = req.user;
    const { latitude, longitude, device_info } = req.body;

    if (latitude == null || longitude == null) {
      return res.status(400).json({ error: "GPS_REQUIRED", message: "Location is required for check-in" });
    }

    // Geo-fence check
    const geo = await validateGeoFence(client_id, latitude, longitude);
    if (!geo.ok) {
      return res.status(400).json({ error: geo.error, message: geo.message, distance: geo.distance });
    }

    // Verify identity via bioToken (one-time, from WebAuthn authenticate/verify)
    const { bioToken } = req.body;
    if (!bioToken) {
      return res.status(400).json({ error: "AUTH_REQUIRED", message: "Biometric verification required" });
    }
    const tokenCheck = await pool.query(
      `DELETE FROM hr_webauthn_challenges
       WHERE employee_id=$1 AND challenge=$2 AND type='bio_token' AND expires_at > NOW()
       RETURNING id`,
      [hr_employee_id, bioToken]
    );
    if (!tokenCheck.rows.length) {
      return res.status(401).json({ error: "INVALID_TOKEN", message: "Biometric token expired or invalid. Please verify again." });
    }

    // Check if already checked in today
    const existing = await pool.query(
      `SELECT * FROM hr_attendance
       WHERE employee_id=$1 AND client_id=$2 AND work_date=CURRENT_DATE`,
      [hr_employee_id, client_id]
    );

    if (existing.rows.length && existing.rows[0].check_in) {
      return res.status(409).json({ error: "ALREADY_CHECKED_IN", message: "Already checked in today" });
    }

    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);

    // Get schedule to determine weekday status
    const schedule = await getScheduleForDate(hr_employee_id, client_id, todayStr);
    const dayOfWeek = now.getDay() === 0 ? 7 : now.getDay(); // Convert Sun=0 to 7
    const isWorkDay = schedule && schedule.work_days && schedule.work_days.includes(dayOfWeek);

    const initialStatus = isWorkDay === false ? "weekend" : "incomplete";

    if (existing.rows.length) {
      // Row exists but no check_in (shouldn't happen normally, but handle)
      await pool.query(
        `UPDATE hr_attendance SET check_in=$1, check_in_lat=$2, check_in_lng=$3,
         device_info=$4, status=$5, updated_at=NOW()
         WHERE id=$6`,
        [now, latitude, longitude, device_info, initialStatus, existing.rows[0].id]
      );
    } else {
      // Use ON CONFLICT to prevent duplicate rows from concurrent requests
      await pool.query(
        `INSERT INTO hr_attendance
           (client_id, employee_id, work_date, check_in, check_in_lat, check_in_lng, device_info, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (employee_id, client_id, work_date) DO UPDATE
         SET check_in = EXCLUDED.check_in, check_in_lat = EXCLUDED.check_in_lat,
             check_in_lng = EXCLUDED.check_in_lng, device_info = EXCLUDED.device_info,
             status = EXCLUDED.status, updated_at = NOW()
         WHERE hr_attendance.check_in IS NULL`,
        [client_id, hr_employee_id, todayStr, now, latitude, longitude, device_info, initialStatus]
      );
    }

    res.json({ message: "Checked in", time: now.toISOString(), clinicName: geo.clinic.name });
  } catch (err) {
    console.error("POST /hr/attendance/check-in error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/** POST /hr/attendance/check-out */
router.post("/attendance/check-out", async (req, res) => {
  if (!requireHrEmployee(req, res)) return;
  try {
    const { hr_employee_id, client_id } = req.user;
    const { latitude, longitude, device_info } = req.body;

    if (latitude == null || longitude == null) {
      return res.status(400).json({ error: "GPS_REQUIRED", message: "Location is required for check-out" });
    }

    // Geo-fence check
    const geo = await validateGeoFence(client_id, latitude, longitude);
    if (!geo.ok) {
      return res.status(400).json({ error: geo.error, message: geo.message, distance: geo.distance });
    }

    // Verify identity via bioToken (one-time, from WebAuthn authenticate/verify)
    const { bioToken } = req.body;
    if (!bioToken) {
      return res.status(400).json({ error: "AUTH_REQUIRED", message: "Biometric verification required" });
    }
    const tokenCheck = await pool.query(
      `DELETE FROM hr_webauthn_challenges
       WHERE employee_id=$1 AND challenge=$2 AND type='bio_token' AND expires_at > NOW()
       RETURNING id`,
      [hr_employee_id, bioToken]
    );
    if (!tokenCheck.rows.length) {
      return res.status(401).json({ error: "INVALID_TOKEN", message: "Biometric token expired or invalid. Please verify again." });
    }

    // Must have checked in today
    const existing = await pool.query(
      `SELECT * FROM hr_attendance
       WHERE employee_id=$1 AND client_id=$2 AND work_date=CURRENT_DATE`,
      [hr_employee_id, client_id]
    );
    if (!existing.rows.length || !existing.rows[0].check_in) {
      return res.status(400).json({ error: "NOT_CHECKED_IN", message: "Must check in first" });
    }
    if (existing.rows[0].check_out) {
      return res.status(409).json({ error: "ALREADY_CHECKED_OUT", message: "Already checked out today" });
    }

    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const schedule = await getScheduleForDate(hr_employee_id, client_id, todayStr);
    const metrics = computeAttendance(existing.rows[0].check_in, now, schedule);

    await pool.query(
      `UPDATE hr_attendance SET
         check_out=$1, check_out_lat=$2, check_out_lng=$3,
         total_minutes=$4, late_minutes=$5, early_leave_minutes=$6, overtime_minutes=$7,
         status=$8, updated_at=NOW()
       WHERE id=$9`,
      [
        now,
        latitude,
        longitude,
        metrics.totalMinutes || 0,
        metrics.lateMinutes || 0,
        metrics.earlyLeaveMinutes || 0,
        metrics.overtimeMinutes || 0,
        metrics.status || "normal",
        existing.rows[0].id,
      ]
    );

    res.json({
      message: "Checked out",
      time: now.toISOString(),
      totalMinutes: metrics.totalMinutes,
      lateMinutes: metrics.lateMinutes,
      overtimeMinutes: metrics.overtimeMinutes,
    });
  } catch (err) {
    console.error("POST /hr/attendance/check-out error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ============================================================
//  7. ATTENDANCE LIST  (admin)
// ============================================================

/** GET /hr/attendance?from=&to=&employee_id=&status= */
router.get("/attendance", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { client_id } = req.user;
    const { from, to, employee_id, status } = req.query;

    let query = `SELECT a.*, e.full_name AS employee_name
                 FROM hr_attendance a
                 JOIN hr_employees e ON e.id = a.employee_id
                 WHERE a.client_id=$1`;
    const params = [client_id];
    let idx = 2;

    if (from) { query += ` AND a.work_date >= $${idx}`; params.push(from); idx++; }
    if (to) { query += ` AND a.work_date <= $${idx}`; params.push(to); idx++; }
    if (employee_id) { query += ` AND a.employee_id = $${idx}`; params.push(employee_id); idx++; }
    if (status) { query += ` AND a.status = $${idx}`; params.push(status); idx++; }

    query += " ORDER BY a.work_date DESC, e.full_name";

    const { rows } = await pool.query(query, params);
    res.json(
      rows.map((r) => ({
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
    res.status(500).json({ error: "Server error" });
  }
});

// ============================================================
//  8. REPORTS
// ============================================================

/**
 * GET /hr/reports/monthly?employee_id=&month=YYYY-MM
 * Admin: any employee; hr_employee: self only
 */
router.get("/reports/monthly", async (req, res) => {
  try {
    const { client_id, role, type, hr_employee_id } = req.user;
    let { employee_id, month } = req.query;

    // Self-only for hr_employee
    if (type === "hr_employee") {
      employee_id = hr_employee_id;
    } else if (role !== "admin") {
      return res.status(403).json({ error: "Forbidden" });
    }

    if (!employee_id || !month) {
      return res.status(400).json({ error: "employee_id and month (YYYY-MM) required" });
    }

    const startDate = `${month}-01`;
    // End of month
    const [y, m] = month.split("-").map(Number);
    const endDate = new Date(y, m, 0).toISOString().slice(0, 10); // last day

    const { rows } = await pool.query(
      `SELECT * FROM hr_attendance
       WHERE client_id=$1 AND employee_id=$2 AND work_date BETWEEN $3 AND $4
       ORDER BY work_date`,
      [client_id, employee_id, startDate, endDate]
    );

    const summary = {
      daysPresent: 0,
      totalWorkMinutes: 0,
      totalLateMinutes: 0,
      totalOvertimeMinutes: 0,
      totalEarlyLeaveMinutes: 0,
    };

    const days = rows.map((r) => {
      if (r.check_in) summary.daysPresent++;
      summary.totalWorkMinutes += r.total_minutes || 0;
      summary.totalLateMinutes += r.late_minutes || 0;
      summary.totalOvertimeMinutes += r.overtime_minutes || 0;
      summary.totalEarlyLeaveMinutes += r.early_leave_minutes || 0;

      return {
        workDate: r.work_date,
        checkIn: r.check_in,
        checkOut: r.check_out,
        totalMinutes: r.total_minutes,
        lateMinutes: r.late_minutes,
        earlyLeaveMinutes: r.early_leave_minutes,
        overtimeMinutes: r.overtime_minutes,
        status: r.status,
      };
    });

    res.json({ month, employeeId: Number(employee_id), summary, days });
  } catch (err) {
    console.error("GET /hr/reports/monthly error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * GET /hr/reports/my-monthly?month=YYYY-MM
 * Shortcut for employee to get own report
 */
router.get("/reports/my-monthly", async (req, res) => {
  if (!requireHrEmployee(req, res)) return;
  req.query.employee_id = req.user.hr_employee_id;
  req.user.type = "hr_employee"; // ensure self-only logic
  // Delegate to /reports/monthly handler logic
  try {
    const { client_id, hr_employee_id } = req.user;
    const { month } = req.query;
    if (!month) return res.status(400).json({ error: "month (YYYY-MM) required" });

    const startDate = `${month}-01`;
    const [y, m] = month.split("-").map(Number);
    const endDate = new Date(y, m, 0).toISOString().slice(0, 10);

    const { rows } = await pool.query(
      `SELECT * FROM hr_attendance
       WHERE client_id=$1 AND employee_id=$2 AND work_date BETWEEN $3 AND $4
       ORDER BY work_date`,
      [client_id, hr_employee_id, startDate, endDate]
    );

    const summary = { daysPresent: 0, totalWorkMinutes: 0, totalLateMinutes: 0, totalOvertimeMinutes: 0, totalEarlyLeaveMinutes: 0 };
    const days = rows.map((r) => {
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

    res.json({ month, employeeId: hr_employee_id, summary, days });
  } catch (err) {
    console.error("GET /hr/reports/my-monthly error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ============================================================
//  9. BREAK OUT / BREAK IN  (hr_employee)
// ============================================================

/** POST /hr/attendance/break-out */
router.post("/attendance/break-out", async (req, res) => {
  if (!requireHrEmployee(req, res)) return;
  try {
    const { hr_employee_id, client_id } = req.user;
    const { latitude, longitude, device_info, bioToken } = req.body;

    if (latitude == null || longitude == null) {
      return res.status(400).json({ error: "GPS_REQUIRED", message: "Location is required" });
    }

    // Geo-fence
    const geo = await validateGeoFence(client_id, latitude, longitude);
    if (!geo.ok) {
      return res.status(400).json({ error: geo.error, message: geo.message, distance: geo.distance });
    }

    // Bio token
    if (!bioToken) {
      return res.status(400).json({ error: "AUTH_REQUIRED", message: "Biometric verification required" });
    }
    const tokenCheck = await pool.query(
      `DELETE FROM hr_webauthn_challenges
       WHERE employee_id=$1 AND challenge=$2 AND type='bio_token' AND expires_at > NOW()
       RETURNING id`,
      [hr_employee_id, bioToken]
    );
    if (!tokenCheck.rows.length) {
      return res.status(401).json({ error: "INVALID_TOKEN", message: "Biometric token expired or invalid." });
    }

    // Must be checked in today, not already on break, not checked out
    const att = await pool.query(
      `SELECT * FROM hr_attendance WHERE employee_id=$1 AND client_id=$2 AND work_date=CURRENT_DATE`,
      [hr_employee_id, client_id]
    );
    if (!att.rows.length || !att.rows[0].check_in) {
      return res.status(400).json({ error: "NOT_CHECKED_IN", message: "Must check in first" });
    }
    if (att.rows[0].check_out) {
      return res.status(409).json({ error: "ALREADY_CHECKED_OUT", message: "Already checked out" });
    }

    // Check if already on break (last event is break_out without break_in)
    const lastEvent = await pool.query(
      `SELECT event_type FROM hr_attendance_events
       WHERE employee_id=$1 AND client_id=$2 AND work_date=CURRENT_DATE
       ORDER BY event_time DESC LIMIT 1`,
      [hr_employee_id, client_id]
    );
    if (lastEvent.rows.length && lastEvent.rows[0].event_type === 'break_out') {
      return res.status(409).json({ error: "ALREADY_ON_BREAK", message: "Already on break" });
    }

    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);

    await pool.query(
      `INSERT INTO hr_attendance_events (client_id, employee_id, work_date, event_type, event_time, latitude, longitude, device_info)
       VALUES ($1,$2,$3,'break_out',$4,$5,$6,$7)`,
      [client_id, hr_employee_id, todayStr, now, latitude, longitude, device_info ? JSON.stringify(device_info) : null]
    );

    res.json({ message: "Break started", time: now.toISOString() });
  } catch (err) {
    console.error("POST /hr/attendance/break-out error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/** POST /hr/attendance/break-in */
router.post("/attendance/break-in", async (req, res) => {
  if (!requireHrEmployee(req, res)) return;
  try {
    const { hr_employee_id, client_id } = req.user;
    const { latitude, longitude, device_info, bioToken } = req.body;

    if (latitude == null || longitude == null) {
      return res.status(400).json({ error: "GPS_REQUIRED", message: "Location is required" });
    }

    const geo = await validateGeoFence(client_id, latitude, longitude);
    if (!geo.ok) {
      return res.status(400).json({ error: geo.error, message: geo.message, distance: geo.distance });
    }

    if (!bioToken) {
      return res.status(400).json({ error: "AUTH_REQUIRED", message: "Biometric verification required" });
    }
    const tokenCheck = await pool.query(
      `DELETE FROM hr_webauthn_challenges
       WHERE employee_id=$1 AND challenge=$2 AND type='bio_token' AND expires_at > NOW()
       RETURNING id`,
      [hr_employee_id, bioToken]
    );
    if (!tokenCheck.rows.length) {
      return res.status(401).json({ error: "INVALID_TOKEN", message: "Biometric token expired or invalid." });
    }

    // Must be on break (last event is break_out)
    const lastEvent = await pool.query(
      `SELECT event_type, event_time FROM hr_attendance_events
       WHERE employee_id=$1 AND client_id=$2 AND work_date=CURRENT_DATE
       ORDER BY event_time DESC LIMIT 1`,
      [hr_employee_id, client_id]
    );
    if (!lastEvent.rows.length || lastEvent.rows[0].event_type !== 'break_out') {
      return res.status(400).json({ error: "NOT_ON_BREAK", message: "Not currently on break" });
    }

    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);

    // Calculate this break duration
    const breakStartTime = new Date(lastEvent.rows[0].event_time);
    const breakMinutes = Math.round((now - breakStartTime) / 60000);

    await pool.query(
      `INSERT INTO hr_attendance_events (client_id, employee_id, work_date, event_type, event_time, latitude, longitude, device_info)
       VALUES ($1,$2,$3,'break_in',$4,$5,$6,$7)`,
      [client_id, hr_employee_id, todayStr, now, latitude, longitude, device_info ? JSON.stringify(device_info) : null]
    );

    // Update total_break_minutes on hr_attendance
    // net_work_minutes is recalculated at check-out via computeAttendance; only update break totals here
    await pool.query(
      `UPDATE hr_attendance SET total_break_minutes = COALESCE(total_break_minutes,0) + $1,
       updated_at=NOW()
       WHERE employee_id=$2 AND client_id=$3 AND work_date=CURRENT_DATE`,
      [breakMinutes, hr_employee_id, client_id]
    );

    res.json({ message: "Break ended", time: now.toISOString(), breakMinutes });
  } catch (err) {
    console.error("POST /hr/attendance/break-in error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/** GET /hr/attendance/:employeeId/timeline?date=YYYY-MM-DD */
router.get("/attendance/:employeeId/timeline", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { client_id } = req.user;
    const { employeeId } = req.params;
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: "date query param required" });

    const { rows } = await pool.query(
      `SELECT id, event_type, event_time, latitude, longitude, device_info
       FROM hr_attendance_events
       WHERE client_id=$1 AND employee_id=$2 AND work_date=$3
       ORDER BY event_time ASC`,
      [client_id, employeeId, date]
    );

    res.json(rows.map(r => ({
      id: r.id,
      eventType: r.event_type,
      timestamp: r.event_time,
      latitude: r.latitude,
      longitude: r.longitude,
      deviceInfo: r.device_info,
    })));
  } catch (err) {
    console.error("GET /hr/attendance/:id/timeline error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ============================================================
//  10. DEDUCTIONS  (admin)
// ============================================================

/** GET /hr/deductions?month=YYYY-MM&employee_id= */
router.get("/deductions", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { client_id } = req.user;
    const { month, employee_id } = req.query;

    let query = `SELECT d.*, e.full_name AS employee_name
                 FROM hr_deductions d
                 JOIN hr_employees e ON e.id = d.employee_id
                 WHERE d.client_id=$1`;
    const params = [client_id];
    let idx = 2;

    if (month) { query += ` AND d.month = $${idx}::date`; params.push(month + '-01'); idx++; }
    if (employee_id) { query += ` AND d.employee_id = $${idx}`; params.push(employee_id); idx++; }

    query += " ORDER BY d.created_at DESC";

    const { rows } = await pool.query(query, params);
    res.json(rows.map(r => ({
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
    res.status(500).json({ error: "Server error" });
  }
});

/** POST /hr/deductions */
router.post("/deductions", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { client_id, id: userId } = req.user;
    const { employee_id, month, amount, reason } = req.body;

    if (!employee_id || !month || !amount) {
      return res.status(400).json({ error: "employee_id, month, amount required" });
    }

    const monthDate = month.length === 7 ? month + '-01' : month;

    const { rows } = await pool.query(
      `INSERT INTO hr_deductions (client_id, employee_id, month, amount, reason, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [client_id, employee_id, monthDate, amount, reason || null, userId || null]
    );

    res.status(201).json({
      id: rows[0].id,
      employeeId: rows[0].employee_id,
      month: rows[0].month,
      amount: parseFloat(rows[0].amount),
      reason: rows[0].reason,
      createdAt: rows[0].created_at,
    });
  } catch (err) {
    console.error("POST /hr/deductions error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/** DELETE /hr/deductions/:id */
router.delete("/deductions/:id", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { client_id } = req.user;
    const { id } = req.params;
    const { rows } = await pool.query(
      `DELETE FROM hr_deductions WHERE id=$1 AND client_id=$2 RETURNING id`,
      [id, client_id]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json({ deleted: true });
  } catch (err) {
    console.error("DELETE /hr/deductions/:id error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ============================================================
//  11. WARNINGS  (admin)
// ============================================================

/** GET /hr/warnings?employee_id= */
router.get("/warnings", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { client_id } = req.user;
    const { employee_id } = req.query;

    let query = `SELECT w.*, e.full_name AS employee_name
                 FROM hr_warnings w
                 JOIN hr_employees e ON e.id = w.employee_id
                 WHERE w.client_id=$1`;
    const params = [client_id];
    let idx = 2;

    if (employee_id) { query += ` AND w.employee_id = $${idx}`; params.push(employee_id); idx++; }

    query += " ORDER BY w.issued_at DESC";

    const { rows } = await pool.query(query, params);
    res.json(rows.map(r => ({
      id: r.id,
      employeeId: r.employee_id,
      employeeName: r.employee_name,
      level: r.level,
      reason: r.reason,
      issuedAt: r.issued_at,
    })));
  } catch (err) {
    console.error("GET /hr/warnings error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/** POST /hr/warnings */
router.post("/warnings", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { client_id, id: userId } = req.user;
    const { employee_id, level, reason } = req.body;

    if (!employee_id || !level) {
      return res.status(400).json({ error: "employee_id, level required" });
    }
    if (!['verbal', 'written', 'final'].includes(level)) {
      return res.status(400).json({ error: "level must be verbal, written, or final" });
    }

    const { rows } = await pool.query(
      `INSERT INTO hr_warnings (client_id, employee_id, level, reason, issued_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [client_id, employee_id, level, reason || null, userId || null]
    );

    res.status(201).json({
      id: rows[0].id,
      employeeId: rows[0].employee_id,
      level: rows[0].level,
      reason: rows[0].reason,
      issuedAt: rows[0].issued_at,
    });
  } catch (err) {
    console.error("POST /hr/warnings error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ============================================================
//  12. NOTIFICATIONS  (admin sends, employee reads)
// ============================================================

/** GET /hr/notifications?employee_id= (admin) */
router.get("/notifications", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { client_id } = req.user;
    const { employee_id } = req.query;

    let query = `SELECT n.*, e.full_name AS employee_name
                 FROM hr_notifications n
                 JOIN hr_employees e ON e.id = n.employee_id
                 WHERE n.client_id=$1`;
    const params = [client_id];
    let idx = 2;

    if (employee_id) { query += ` AND n.employee_id = $${idx}`; params.push(employee_id); idx++; }

    query += " ORDER BY n.created_at DESC";

    const { rows } = await pool.query(query, params);
    res.json(rows.map(r => ({
      id: r.id,
      employeeId: r.employee_id,
      employeeName: r.employee_name,
      message: r.message,
      isRead: r.is_read,
      createdAt: r.created_at,
    })));
  } catch (err) {
    console.error("GET /hr/notifications error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/** POST /hr/notifications */
router.post("/notifications", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { client_id, hr_employee_id } = req.user;
    const { employee_id, message } = req.body;

    if (!employee_id || !message) {
      return res.status(400).json({ error: "employee_id, message required" });
    }

    // created_by is FK to hr_employees(id) — only set if caller is an HR employee
    const createdBy = hr_employee_id ? parseInt(hr_employee_id) : null;

    const { rows } = await pool.query(
      `INSERT INTO hr_notifications (client_id, employee_id, message, created_by)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [client_id, employee_id, message, createdBy]
    );

    res.status(201).json({
      id: rows[0].id,
      employeeId: rows[0].employee_id,
      message: rows[0].message,
      isRead: rows[0].is_read,
      createdAt: rows[0].created_at,
    });
  } catch (err) {
    console.error("POST /hr/notifications error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/** GET /hr/notifications/my â€” employee's own notifications */
router.get("/notifications/my", async (req, res) => {
  if (!requireHrEmployee(req, res)) return;
  try {
    const { hr_employee_id, client_id } = req.user;
    const { rows } = await pool.query(
      `SELECT * FROM hr_notifications WHERE client_id=$1 AND employee_id=$2 ORDER BY created_at DESC`,
      [client_id, hr_employee_id]
    );
    res.json(rows.map(r => ({
      id: r.id,
      message: r.message,
      isRead: r.is_read,
      createdAt: r.created_at,
    })));
  } catch (err) {
    console.error("GET /hr/notifications/my error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/** PATCH /hr/notifications/:id/read */
router.patch("/notifications/:id/read", async (req, res) => {
  if (!requireHrEmployee(req, res)) return;
  try {
    const { hr_employee_id, client_id } = req.user;
    const { id } = req.params;
    const { rows } = await pool.query(
      `UPDATE hr_notifications SET is_read=true WHERE id=$1 AND client_id=$2 AND employee_id=$3 RETURNING id`,
      [id, client_id, hr_employee_id]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    res.json({ success: true });
  } catch (err) {
    console.error("PATCH /hr/notifications/:id/read error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ============================================================
//  13. SOCIAL SECURITY SETTINGS  (admin)
// ============================================================

/** GET /hr/social-security */
router.get("/social-security", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { client_id } = req.user;
    const { rows } = await pool.query(
      `SELECT * FROM hr_social_security_settings WHERE client_id=$1`,
      [client_id]
    );
    if (!rows.length) {
      // Return defaults
      return res.json({ employeeRate: 7.50, employerRate: 14.25, enabled: true });
    }
    res.json({
      employeeRate: parseFloat(rows[0].employee_rate_percent),
      employerRate: parseFloat(rows[0].employer_rate_percent),
      enabled: rows[0].enabled,
    });
  } catch (err) {
    console.error("GET /hr/social-security error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/** PATCH /hr/social-security */
router.patch("/social-security", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { client_id } = req.user;
    const { employeeRate, employerRate, enabled } = req.body;

    await pool.query(
      `INSERT INTO hr_social_security_settings (client_id, employee_rate_percent, employer_rate_percent, enabled)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (client_id)
       DO UPDATE SET employee_rate_percent=EXCLUDED.employee_rate_percent,
                     employer_rate_percent=EXCLUDED.employer_rate_percent,
                     enabled=EXCLUDED.enabled,
                     updated_at=NOW()`,
      [client_id, employeeRate ?? 7.50, employerRate ?? 14.25, enabled !== false]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("PATCH /hr/social-security error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ============================================================
//  14. PAYROLL  (admin)
// ============================================================

/** POST /hr/payroll/generate â€” generate or recalculate draft payroll for a month */
router.post("/payroll/generate", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const dbClient = await pool.connect();
  try {
    await dbClient.query("BEGIN");
    const { client_id, id: userId } = req.user;
    const { month } = req.body; // "YYYY-MM"
    if (!month) { await dbClient.query("ROLLBACK"); dbClient.release(); return res.status(400).json({ error: "month (YYYY-MM) required" }); }

    const monthDate = month + '-01';
    const [y, m] = month.split("-").map(Number);
    const endDate = new Date(y, m, 0).toISOString().slice(0, 10);
    const daysInMonth = new Date(y, m, 0).getDate();

    // Get or create payroll run
    let run = await dbClient.query(
      `SELECT * FROM hr_payroll_runs WHERE client_id=$1 AND month=$2`,
      [client_id, monthDate]
    );
    if (run.rows.length && run.rows[0].status === 'closed') {
      await dbClient.query("ROLLBACK"); dbClient.release();
      return res.status(409).json({ error: "Month already closed" });
    }

    let runId;
    if (!run.rows.length) {
      const ins = await dbClient.query(
        `INSERT INTO hr_payroll_runs (client_id, month, status, created_by) VALUES ($1,$2,'draft',$3) RETURNING id`,
        [client_id, monthDate, userId || null]
      );
      runId = ins.rows[0].id;
    } else {
      runId = run.rows[0].id;
      // Reset existing payslips to draft for recalculation
      await dbClient.query(
        `DELETE FROM hr_payslips WHERE payroll_run_id=$1`,
        [runId]
      );
    }

    // Get social security settings
    const ssResult = await dbClient.query(
      `SELECT * FROM hr_social_security_settings WHERE client_id=$1`,
      [client_id]
    );
    const ssEmployeeRate = ssResult.rows.length ? parseFloat(ssResult.rows[0].employee_rate_percent) / 100 : 0.075;
    const ssEmployerRate = ssResult.rows.length ? parseFloat(ssResult.rows[0].employer_rate_percent) / 100 : 0.1425;
    const ssEnabled = ssResult.rows.length ? ssResult.rows[0].enabled : true;

    // Get all active employees
    const employees = await dbClient.query(
      `SELECT id, full_name, basic_salary FROM hr_employees WHERE client_id=$1 AND status='active'`,
      [client_id]
    );

    // Batch-fetch attendance and deductions for all employees at once (avoid N+1)
    const allAttendance = await dbClient.query(
      `SELECT * FROM hr_attendance WHERE client_id=$1 AND work_date BETWEEN $2 AND $3`,
      [client_id, monthDate, endDate]
    );
    const attendanceByEmp = {};
    for (const att of allAttendance.rows) {
      if (!attendanceByEmp[att.employee_id]) attendanceByEmp[att.employee_id] = [];
      attendanceByEmp[att.employee_id].push(att);
    }

    const allDeductions = await dbClient.query(
      `SELECT employee_id, COALESCE(SUM(amount),0) AS total FROM hr_deductions WHERE client_id=$1 AND month=$2 GROUP BY employee_id`,
      [client_id, monthDate]
    );
    const deductionsByEmp = {};
    for (const d of allDeductions.rows) deductionsByEmp[d.employee_id] = parseFloat(d.total) || 0;

    const payslips = [];

    for (const emp of employees.rows) {
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

      // Calculate deduction amounts
      const lateAmount = totalLateMinutes > 0 ? Math.round(totalLateMinutes * (hourlyRate / 60) * 100) / 100 : 0;
      const overtimeAmount = totalOvertimeMinutes > 0 ? Math.round(totalOvertimeMinutes * (hourlyRate / 60) * 100) / 100 : 0;
      const absenceAmount = absentDays > 0 ? Math.round(absentDays * dailyRate * 100) / 100 : 0;
      const lateThreshold = totalLateMinutes > 180; // > 3 hours total late

      // Social security from basic salary only
      const employeeSS = ssEnabled ? Math.round(basicSalary * ssEmployeeRate * 100) / 100 : 0;
      const employerSS = ssEnabled ? Math.round(basicSalary * ssEmployerRate * 100) / 100 : 0;

      const manualDeductionsTotal = deductionsByEmp[emp.id] || 0;

      // Net salary = basic - SS - late - absence - manual_deductions + overtime
      const netSalary = Math.round((basicSalary - employeeSS - lateAmount - absenceAmount - manualDeductionsTotal + overtimeAmount) * 100) / 100;

      await dbClient.query(
        `INSERT INTO hr_payslips (
          client_id, payroll_run_id, employee_id, month,
          basic_salary, employee_ss, employer_ss,
          suggested_late_minutes, suggested_late_amount, final_late_amount, late_threshold_exceeded,
          suggested_overtime_minutes, overtime_multiplier, suggested_overtime_amount, final_overtime_amount,
          suggested_absent_days, suggested_absence_amount, final_absence_amount,
          total_break_minutes, manual_deductions_total, net_salary,
          days_worked, total_work_minutes, status
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,'draft')`,
        [
          client_id, runId, emp.id, monthDate,
          basicSalary, employeeSS, employerSS,
          totalLateMinutes, lateAmount, lateAmount, lateThreshold,
          totalOvertimeMinutes, 1.00, overtimeAmount, overtimeAmount,
          absentDays, absenceAmount, absenceAmount,
          totalBreakMins, manualDeductionsTotal, netSalary,
          daysWorked, totalWorkMinutes,
        ]
      );

      payslips.push({ employeeId: emp.id, employeeName: emp.full_name, netSalary });
    }

    await dbClient.query("COMMIT");
    res.json({ runId, month, status: 'draft', totalEmployees: payslips.length, payslips });
  } catch (err) {
    await dbClient.query("ROLLBACK").catch(() => {});
    console.error("POST /hr/payroll/generate error:", err);
    res.status(500).json({ error: "Server error" });
  } finally {
    dbClient.release();
  }
});

/** GET /hr/payroll/run?month=YYYY-MM */
router.get("/payroll/run", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { client_id } = req.user;
    const { month } = req.query;
    if (!month) return res.status(400).json({ error: "month required" });

    const monthDate = month + '-01';

    const run = await pool.query(
      `SELECT * FROM hr_payroll_runs WHERE client_id=$1 AND month=$2`,
      [client_id, monthDate]
    );
    if (!run.rows.length) return res.json(null);

    const payslips = await pool.query(
      `SELECT p.*, e.full_name AS employee_name
       FROM hr_payslips p
       JOIN hr_employees e ON e.id = p.employee_id
       WHERE p.payroll_run_id=$1 ORDER BY e.full_name`,
      [run.rows[0].id]
    );

    res.json({
      id: run.rows[0].id,
      month: run.rows[0].month,
      status: run.rows[0].status,
      createdAt: run.rows[0].created_at,
      payslips: payslips.rows.map(p => ({
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
    res.status(500).json({ error: "Server error" });
  }
});

/** GET /hr/payslips/:id */
router.get("/payslips/:id", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { client_id } = req.user;
    const { id } = req.params;
    const { rows } = await pool.query(
      `SELECT p.*, e.full_name AS employee_name
       FROM hr_payslips p
       JOIN hr_employees e ON e.id = p.employee_id
       WHERE p.id=$1 AND p.client_id=$2`,
      [id, client_id]
    );
    if (!rows.length) return res.status(404).json({ error: "Payslip not found" });
    const p = rows[0];
    res.json({
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
    res.status(500).json({ error: "Server error" });
  }
});

/** PATCH /hr/payslips/:id â€” update final amounts */
router.patch("/payslips/:id", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { client_id } = req.user;
    const { id } = req.params;
    const { final_late_amount, final_overtime_amount, final_absence_amount, overtime_multiplier } = req.body;

    // Get current payslip
    const current = await pool.query(
      `SELECT * FROM hr_payslips WHERE id=$1 AND client_id=$2`,
      [id, client_id]
    );
    if (!current.rows.length) return res.status(404).json({ error: "Not found" });
    if (current.rows[0].status !== 'draft') return res.status(400).json({ error: "Can only edit draft payslips" });

    const p = current.rows[0];
    const newLate = final_late_amount ?? parseFloat(p.final_late_amount);
    const newOT = final_overtime_amount ?? parseFloat(p.final_overtime_amount);
    const newAbsence = final_absence_amount ?? parseFloat(p.final_absence_amount);
    const newMultiplier = overtime_multiplier ?? parseFloat(p.overtime_multiplier);
    const adjustedOT = newOT * newMultiplier;

    // Recalculate net salary
    const basicSalary = parseFloat(p.basic_salary);
    const employeeSS = parseFloat(p.employee_ss);
    const manualDeductions = parseFloat(p.manual_deductions_total);
    const netSalary = Math.round((basicSalary - employeeSS - newLate - newAbsence - manualDeductions + adjustedOT) * 100) / 100;

    await pool.query(
      `UPDATE hr_payslips SET
         final_late_amount=$1, final_overtime_amount=$2, final_absence_amount=$3,
         overtime_multiplier=$4, net_salary=$5, updated_at=NOW()
       WHERE id=$6`,
      [newLate, newOT, newAbsence, newMultiplier, netSalary, id]
    );

    res.json({ success: true, netSalary });
  } catch (err) {
    console.error("PATCH /hr/payslips/:id error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/** POST /hr/payslips/:id/approve */
router.post("/payslips/:id/approve", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { client_id, id: userId } = req.user;
    const { id } = req.params;
    const { rows } = await pool.query(
      `UPDATE hr_payslips SET status='approved', approved_by=$1, approved_at=NOW(), updated_at=NOW()
       WHERE id=$2 AND client_id=$3 AND status='draft' RETURNING id`,
      [userId || null, id, client_id]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found or not draft" });
    res.json({ success: true });
  } catch (err) {
    console.error("POST /hr/payslips/:id/approve error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/** POST /hr/payslips/:id/reject */
router.post("/payslips/:id/reject", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { client_id } = req.user;
    const { id } = req.params;
    const { reason } = req.body;
    const { rows } = await pool.query(
      `UPDATE hr_payslips SET status='rejected', reject_reason=$1, updated_at=NOW()
       WHERE id=$2 AND client_id=$3 AND status='draft' RETURNING id`,
      [reason || null, id, client_id]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found or not draft" });
    res.json({ success: true });
  } catch (err) {
    console.error("POST /hr/payslips/:id/reject error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/** POST /hr/payroll/close-month */
router.post("/payroll/close-month", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { client_id } = req.user;
    const { month } = req.body;
    if (!month) return res.status(400).json({ error: "month required" });

    const monthDate = month + '-01';

    // Check all payslips are approved or rejected
    const pending = await pool.query(
      `SELECT COUNT(*) AS cnt FROM hr_payslips
       WHERE client_id=$1 AND month=$2 AND status='draft'`,
      [client_id, monthDate]
    );
    if (parseInt(pending.rows[0].cnt) > 0) {
      return res.status(400).json({ error: "All payslips must be approved or rejected before closing" });
    }

    await pool.query(
      `UPDATE hr_payroll_runs SET status='closed' WHERE client_id=$1 AND month=$2`,
      [client_id, monthDate]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("POST /hr/payroll/close-month error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
