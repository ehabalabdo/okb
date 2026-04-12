import pkg from "pg";
const { Pool } = pkg;
import bcryptPkg from "bcrypt";

if (!process.env.DATABASE_URL) {
  console.error("FATAL: DATABASE_URL environment variable is not set");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => {
  console.error("Unexpected pool error:", err.message);
});

// Auto-create invoice_overrides table for accountant overlay system
pool.query(`
  CREATE TABLE IF NOT EXISTS invoice_overrides (
    id SERIAL PRIMARY KEY,
    invoice_id TEXT NOT NULL UNIQUE,
    is_deleted BOOLEAN DEFAULT false,
    override_data JSONB,
    modified_by TEXT NOT NULL DEFAULT 'system',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )
`).then(() => console.log("invoice_overrides table ready"))
  .catch(err => console.error("invoice_overrides migration error:", err.message));

// Seed accountant accounts if they don't exist
async function seedAccountants() {
  try {
    const accounts = [
      { uid: "accountant_1", name: "محاسب", email: "accountant", password: "accountant@2026", role: "accountant" },
      { uid: "senior_accountant_1", name: "محاسب أول", email: "senior", password: "senior@2026", role: "senior_accountant" }
    ];
    for (const acc of accounts) {
      const { rows } = await pool.query("SELECT uid FROM users WHERE uid=$1", [acc.uid]);
      if (rows.length === 0) {
        const hashed = await bcryptPkg.hash(acc.password, 10);
        await pool.query(
          `INSERT INTO users (uid, name, email, password, role, is_active)
           VALUES ($1, $2, $3, $4, $5, true)`,
          [acc.uid, acc.name, acc.email, hashed, acc.role]
        );
        console.log(`Created ${acc.role} account: ${acc.name}`);
      }
    }
  } catch (err) {
    console.error("Seed accountants error:", err.message);
  }
}
seedAccountants();

export default pool;
