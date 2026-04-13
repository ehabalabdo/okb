import { Hono } from "hono";
import jwt from "jsonwebtoken";
import { hashPassword, verifyPassword } from "../utils/password.js";

const app = new Hono();

/**
 * POST /login
 */
app.post("/login", async (c) => {
  try {
    const { username, password } = await c.req.json();
    const db = c.env.DB;

    if (!username || !password) {
      return c.json({ error: "username and password required" }, 400);
    }

    const user = await db
      .prepare(
        `SELECT uid, name, email, password, role, clinic_ids, is_active
         FROM users WHERE (name=? OR email=?) LIMIT 1`
      )
      .bind(username, username)
      .first();

    if (user) {
      if (user.is_active === 0 || user.is_active === false) {
        return c.json({ error: "Account is deactivated" }, 403);
      }

      let passwordValid = await verifyPassword(password, user.password);

      // Auto-migrate plaintext â†’ hashed
      if (!passwordValid && password === user.password) {
        passwordValid = true;
      }
      if (passwordValid && user.password && !user.password.startsWith("$2")) {
        const hashed = await hashPassword(password);
        await db.prepare("UPDATE users SET password=? WHERE uid=?").bind(hashed, user.uid).run();
      }

      if (!passwordValid) {
        return c.json({ error: "Invalid credentials" }, 401);
      }

      let clinicIds = [];
      try {
        clinicIds =
          typeof user.clinic_ids === "string"
            ? JSON.parse(user.clinic_ids)
            : user.clinic_ids || [];
      } catch {
        clinicIds = [];
      }

      const token = jwt.sign(
        { id: user.uid, uid: user.uid, role: user.role, type: "staff" },
        c.env.JWT_SECRET,
        { expiresIn: "8h" }
      );

      return c.json({
        token,
        type: "staff",
        user: {
          uid: String(user.uid),
          name: user.name,
          email: user.email,
          role: user.role,
          clinicIds,
          isActive: user.is_active !== false && user.is_active !== 0,
        },
      });
    }

    return c.json({ error: "Invalid credentials" }, 401);
  } catch (err) {
    console.error("Login error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

/**
 * POST /hr-login
 */
app.post("/hr-login", async (c) => {
  try {
    const { username, password } = await c.req.json();
    const db = c.env.DB;

    if (!username || !password) {
      return c.json({ error: "username and password required" }, 400);
    }

    const emp = await db
      .prepare(
        `SELECT id, full_name, username, password, status
         FROM hr_employees WHERE (username=? OR email=?) LIMIT 1`
      )
      .bind(username, username)
      .first();

    if (!emp) {
      return c.json({ error: "Invalid credentials" }, 401);
    }
    if (emp.status !== "active") {
      return c.json({ error: "Account is deactivated" }, 403);
    }

    let passwordValid = await verifyPassword(password, emp.password);
    if (!passwordValid && password === emp.password) {
      passwordValid = true;
    }
    if (passwordValid && emp.password && !emp.password.startsWith("$2")) {
      const hashed = await hashPassword(password);
      await db.prepare("UPDATE hr_employees SET password=? WHERE id=?").bind(hashed, emp.id).run();
    }
    if (!passwordValid) {
      return c.json({ error: "Invalid credentials" }, 401);
    }

    const token = jwt.sign(
      { id: emp.id, hr_employee_id: emp.id, role: "employee", type: "hr_employee" },
      c.env.JWT_SECRET,
      { expiresIn: "12h" }
    );

    return c.json({
      token,
      type: "hr_employee",
      employee: { id: emp.id, fullName: emp.full_name, username: emp.username },
    });
  } catch (err) {
    console.error("HR login error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

/**
 * POST /refresh
 */
app.post("/refresh", async (c) => {
  try {
    const { token } = await c.req.json();
    if (!token) return c.json({ error: "token required" }, 400);

    const decoded = jwt.verify(token, c.env.JWT_SECRET, { ignoreExpiration: true });
    if (decoded.exp && Date.now() / 1000 - decoded.exp > 86400) {
      return c.json({ error: "Token too old to refresh" }, 401);
    }
    const { iat, exp, ...payload } = decoded;
    const newAccess = jwt.sign(payload, c.env.JWT_SECRET, { expiresIn: "8h" });
    return c.json({ token: newAccess });
  } catch {
    return c.json({ error: "Invalid refresh token" }, 401);
  }
});

export default app;
