import { Hono } from "hono";
import { cors } from "hono/cors";
import authRoutes from "./routes/auth.js";
import appointmentsRoutes from "./routes/appointments.js";
import reportsRoutes from "./routes/reports.js";
import patientsRoutes from "./routes/patients.js";
import usersRoutes from "./routes/users.js";
import clinicsRoutes from "./routes/clinics.js";
import invoicesRoutes from "./routes/invoices.js";
import hrRoutes from "./routes/hr.js";
import catalogRoutes from "./routes/catalog.js";
import entFormsRoutes from "./routes/ent-forms.js";

const app = new Hono();

// CORS
const allowedOrigins = [
  "https://okf-nine.vercel.app",
  "https://tkc-clinic.netlify.app",
  "https://med.loopjo.com",
  "https://tkc-frontend.pages.dev",
];

app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return allowedOrigins[0];
      if (allowedOrigins.includes(origin)) return origin;
      if (origin.endsWith(".tkc-frontend.pages.dev")) return origin;
      if (origin.startsWith("http://localhost")) return origin;
      return null;
    },
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);

// Routes
app.route("/api/auth", authRoutes);
app.route("/api/appointments", appointmentsRoutes);
app.route("/api/reports", reportsRoutes);
app.route("/api/patients", patientsRoutes);
app.route("/api/users", usersRoutes);
app.route("/api/clinics", clinicsRoutes);
app.route("/api/invoices", invoicesRoutes);
app.route("/api/hr", hrRoutes);
app.route("/api/catalog", catalogRoutes);
app.route("/api/ent-forms", entFormsRoutes);

// Root
app.get("/", (c) => c.json({ status: "ok", service: "TKC API" }));

// Health check
app.get("/health", (c) => c.json({ status: "ok" }));

export default app;
