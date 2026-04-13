import jwt from "jsonwebtoken";

export function authMiddleware(c, next) {
  const header = c.req.header("Authorization");

  if (!header || !header.startsWith("Bearer ")) {
    return c.json({ error: "No token provided" }, 401);
  }

  const token = header.split(" ")[1];

  try {
    const decoded = jwt.verify(token, c.env.JWT_SECRET);
    c.set("user", decoded);
    return next();
  } catch {
    return c.json({ error: "Invalid token" }, 401);
  }
}
