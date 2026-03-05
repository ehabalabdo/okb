import express from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import pool from "../db.js";

const router = express.Router();

/**
 * POST /auth/login
 * Accepts { username, password, client_id? }
 * Checks users table then patients table
 * Returns JWT with user info
 */
router.post("/login", async (req, res) => {
  try {
    const { username, password, client_id } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: "username and password required" });
    }

    // 1) Check users table (staff: admin, doctor, receptionist, etc.)
    const staffQuery = client_id
      ? `SELECT uid, name, email, password, role, clinic_ids, client_id, is_active
         FROM users
         WHERE (name=$1 OR email=$1)
           AND client_id=$2
         LIMIT 1`
      : `SELECT uid, name, email, password, role, clinic_ids, client_id, is_active
         FROM users
         WHERE (name=$1 OR email=$1)
         LIMIT 1`;

    const staffParams = client_id ? [username, client_id] : [username];
    const staff = await pool.query(staffQuery, staffParams);

    if (staff.rows.length) {
      const user = staff.rows[0];

      if (user.is_active === false) {
        return res.status(403).json({ error: "Account is deactivated" });
      }

      // Verify password (bcrypt or auto-migrate plaintext → bcrypt)
      let passwordValid = false;
      if (user.password && user.password.startsWith("$2")) {
        passwordValid = await bcrypt.compare(password, user.password);
      } else if (password === user.password) {
        passwordValid = true;
        // Auto-migrate: hash the plaintext password and save it
        const hashed = await bcrypt.hash(password, 10);
        pool.query("UPDATE users SET password=$1 WHERE uid=$2", [hashed, user.uid]).catch(() => {});
      }

      if (!passwordValid) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      // Parse clinic_ids
      let clinicIds = [];
      try {
        clinicIds = typeof user.clinic_ids === "string"
          ? JSON.parse(user.clinic_ids)
          : user.clinic_ids || [];
      } catch { clinicIds = []; }

      const token = jwt.sign(
        {
          id: user.uid,
          uid: user.uid,
          role: user.role,
          type: "staff",
          client_id: user.client_id,
        },
        process.env.JWT_SECRET,
        { expiresIn: "8h" }
      );

      return res.json({
        token,
        type: "staff",
        user: {
          uid: String(user.uid),
          name: user.name,
          email: user.email,
          role: user.role,
          clinicIds,
          clientId: user.client_id,
          isActive: user.is_active !== false,
        },
      });
    }

    // 2) Check patients table
    const patientQuery = client_id
      ? `SELECT id, full_name, phone, email, username, password, has_access, client_id,
                date_of_birth, gender, age, medical_profile, current_visit, history
         FROM patients
         WHERE (username=$1 OR phone=$1 OR full_name=$1 OR email=$1)
           AND has_access=true
           AND client_id=$2
         LIMIT 1`
      : `SELECT id, full_name, phone, email, username, password, has_access, client_id,
                date_of_birth, gender, age, medical_profile, current_visit, history
         FROM patients
         WHERE (username=$1 OR phone=$1 OR full_name=$1 OR email=$1)
           AND has_access=true
         LIMIT 1`;

    const patientParams = client_id ? [username, client_id] : [username];
    const patient = await pool.query(patientQuery, patientParams);

    if (patient.rows.length) {
      const p = patient.rows[0];

      // Verify password (bcrypt or auto-migrate plaintext → bcrypt)
      let passwordValid = false;
      if (p.password && p.password.startsWith("$2")) {
        passwordValid = await bcrypt.compare(password, p.password);
      } else if (password === p.password) {
        passwordValid = true;
        const hashed = await bcrypt.hash(password, 10);
        pool.query("UPDATE patients SET password=$1 WHERE id=$2", [hashed, p.id]).catch(() => {});
      }

      if (!passwordValid) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const token = jwt.sign(
        {
          patient_id: p.id,
          type: "patient",
          client_id: p.client_id,
        },
        process.env.JWT_SECRET,
        { expiresIn: "8h" }
      );

      return res.json({
        token,
        type: "patient",
        patient: {
          id: String(p.id),
          name: p.full_name,
          phone: p.phone,
          email: p.email,
          username: p.username,
          clientId: p.client_id,
        },
      });
    }

    res.status(401).json({ error: "Invalid credentials" });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /auth/super-admin/login
 * For platform super admin login
 */
router.post("/super-admin/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: "username and password required" });
    }

    const result = await pool.query(
      "SELECT id, username, name, password FROM super_admins WHERE username=$1 LIMIT 1",
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const admin = result.rows[0];

    // Verify password (bcrypt or auto-migrate plaintext → bcrypt)
    let passwordValid = false;
    if (admin.password && admin.password.startsWith("$2")) {
      passwordValid = await bcrypt.compare(password, admin.password);
    } else if (password === admin.password) {
      passwordValid = true;
      const hashed = await bcrypt.hash(password, 10);
      pool.query("UPDATE super_admins SET password=$1 WHERE id=$2", [hashed, admin.id]).catch(() => {});
    }

    if (!passwordValid) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = jwt.sign(
      { id: admin.id, type: "super_admin", role: "super_admin" },
      process.env.JWT_SECRET,
      { expiresIn: "8h" }
    );

    return res.json({
      token,
      type: "super_admin",
      admin: { id: admin.id, username: admin.username, name: admin.name },
    });
  } catch (err) {
    console.error("Super admin login error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /auth/hr-login
 * HR Employee login (separate from staff login)
 */
router.post("/hr-login", async (req, res) => {
  try {
    const { username, password, client_id } = req.body;
    if (!username || !password || !client_id) {
      return res.status(400).json({ error: "username, password, client_id required" });
    }

    const result = await pool.query(
      `SELECT id, client_id, full_name, username, password, status
       FROM hr_employees
       WHERE (username=$1 OR email=$1) AND client_id=$2
       LIMIT 1`,
      [username, client_id]
    );

    if (!result.rows.length) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const emp = result.rows[0];
    if (emp.status !== "active") {
      return res.status(403).json({ error: "Account is deactivated" });
    }

    // Verify password (bcrypt or auto-migrate plaintext → bcrypt)
    let passwordValid = false;
    if (emp.password && emp.password.startsWith("$2")) {
      passwordValid = await bcrypt.compare(password, emp.password);
    } else if (password === emp.password) {
      passwordValid = true;
      const hashed = await bcrypt.hash(password, 10);
      pool.query("UPDATE hr_employees SET password=$1 WHERE id=$2", [hashed, emp.id]).catch(() => {});
    }
    if (!passwordValid) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = jwt.sign(
      {
        id: emp.id,
        hr_employee_id: emp.id,
        role: "employee",
        type: "hr_employee",
        client_id: emp.client_id,
      },
      process.env.JWT_SECRET,
      { expiresIn: "12h" }
    );

    return res.json({
      token,
      type: "hr_employee",
      employee: {
        id: emp.id,
        fullName: emp.full_name,
        username: emp.username,
        clientId: emp.client_id,
      },
    });
  } catch (err) {
    console.error("HR login error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /auth/refresh
 * Refresh a JWT token (accepts recently-expired tokens up to 24h)
 */
router.post("/refresh", (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "token required" });
  try {
    // Allow expired tokens (up to 24h old) to be refreshed
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { ignoreExpiration: true });
    // Reject tokens expired more than 24 hours ago
    if (decoded.exp && (Date.now() / 1000 - decoded.exp) > 86400) {
      return res.status(401).json({ error: "Token too old to refresh" });
    }
    const { iat, exp, ...payload } = decoded;
    const newAccess = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: "8h",
    });
    res.json({ token: newAccess });
  } catch {
    res.status(401).json({ error: "Invalid refresh token" });
  }
});

export default router;
