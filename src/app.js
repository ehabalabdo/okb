import express from "express";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import authRoutes from "./routes/auth.js";
import appointmentsRouter from "./routes/appointments.js";
import reportsRouter from "./routes/reports.js";
import patientsRouter from "./routes/patients.js";
import usersRouter from "./routes/users.js";
import clinicsRouter from "./routes/clinics.js";
import clientsRouter from "./routes/clients.js";
import invoicesRouter from "./routes/invoices.js";
import hrRouter from "./routes/hr.js";
import catalogRouter from "./routes/catalog.js";
import entFormsRouter from "./routes/ent-forms.js";

dotenv.config();

const app = express();

// Rate limiting
const globalLimiter = rateLimit({ windowMs: 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false });
const authLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, message: { error: "Too many login attempts, try again later" } });

app.use(globalLimiter);
app.use(helmet());

// CORS: Production origins + localhost only in dev
const allowedOrigins = ["https://okf-nine.vercel.app", "https://okf.vercel.app"];
if (process.env.NODE_ENV !== "production") {
  allowedOrigins.push("http://localhost:5173", "http://localhost:3000");
}

const corsOptions = {
  origin: allowedOrigins,
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.use(express.json({ limit: '1mb' }));

// Public routes (no auth) — with stricter rate limit on login
app.use("/auth", authLimiter, authRoutes);

// Protected routes (require JWT via router-level middleware)
app.use("/appointments", appointmentsRouter);
app.use("/reports", reportsRouter);
app.use("/patients", patientsRouter);
app.use("/users", usersRouter);
app.use("/clinics", clinicsRouter);
app.use("/clients", clientsRouter);
app.use("/invoices", invoicesRouter);
app.use("/hr", hrRouter);
app.use("/catalog", catalogRouter);
app.use("/ent-forms", entFormsRouter);

app.get("/", (_, res) => res.send("OKB API running - Dr. Tarek Khrais ENT Clinic"));

// Health check endpoint for keep-alive pings
app.get("/health", (_, res) => res.json({ status: "ok", uptime: process.uptime() }));

// Self keep-alive: ping ourselves every 14 minutes to prevent Render cold starts
const SELF_PING_INTERVAL = 14 * 60 * 1000;
function selfPing() {
  const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
  fetch(`${url}/health`).catch(() => {});
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
  if (process.env.NODE_ENV === "production") {
    setInterval(selfPing, SELF_PING_INTERVAL);
    console.log("Keep-alive self-ping enabled (every 14 min)");
  }
});
