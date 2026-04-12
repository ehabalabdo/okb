import express from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import pool from "../db.js";

const router = express.Router();

/**
 * POST /auth/login
 * Accepts { username, password }
 * Checks users table
 * Returns JWT with user info
 */
router.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: "username and password required" });
    }

    // Check users table (staff: admin, doctor, receptionist, etc.)
    const staff = await pool.query(
      `SELECT uid, name, email, password, role, clinic_ids, is_active
       FROM users
       WHERE (name=$1 OR email=$1)
       LIMIT 1`,
      [username]
    );

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
          isActive: user.is_active !== false,
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
 * POST /auth/hr-login
 * HR Employee login
 */
router.post("/hr-login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: "username and password required" });
    }

    const result = await pool.query(
      `SELECT id, full_name, username, password, status
       FROM hr_employees
       WHERE (username=$1 OR email=$1)
       LIMIT 1`,
      [username]
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
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { ignoreExpiration: true });
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
