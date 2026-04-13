import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth.js";

const app = new Hono();
app.use("*", authMiddleware);

// ===================== SERVICES =====================

function mapService(row) {
  return {
    id: String(row.id),
    serviceName: row.service_name,
    category: row.category || "General",
    price: parseFloat(row.price),
    currency: row.currency || "JOD",
    active: row.active !== 0 && row.active !== false,
    createdAt: row.created_at ? Number(row.created_at) : Date.now(),
    updatedAt: row.updated_at ? Number(row.updated_at) : Date.now(),
  };
}

function mapMedication(row) {
  return {
    id: String(row.id),
    brandName: row.brand_name || "",
    genericName: row.generic_name || "",
    strength: row.strength || "",
    dosageForm: row.dosage_form || "",
    route: row.route || "",
    defaultDose: row.default_dose || "",
    defaultFrequency: row.default_frequency || "",
    defaultDuration: row.default_duration || "",
    notes: row.notes || "",
    active: row.active !== 0 && row.active !== false,
    createdAt: row.created_at ? Number(row.created_at) : Date.now(),
    updatedAt: row.updated_at ? Number(row.updated_at) : Date.now(),
  };
}

app.get("/services", async (c) => {
  try {
    const { results } = await c.env.DB.prepare(
      "SELECT * FROM clinic_services ORDER BY category, service_name"
    ).all();
    return c.json(results.map(mapService));
  } catch (err) {
    console.error("GET /catalog/services error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.post("/services", async (c) => {
  try {
    const user = c.get("user");
    if (user.role !== "admin") return c.json({ error: "Forbidden" }, 403);

    const { serviceName, category, price, currency, active } = await c.req.json();
    if (!serviceName) return c.json({ error: "serviceName required" }, 400);
    if (price == null || isNaN(Number(price))) return c.json({ error: "price required and must be numeric" }, 400);

    const { results } = await c.env.DB.prepare(
      `INSERT INTO clinic_services (service_name, category, price, currency, active)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (service_name) DO UPDATE SET
         category=excluded.category, price=excluded.price, currency=excluded.currency,
         active=excluded.active, updated_at=datetime('now')
       RETURNING *`
    )
      .bind(serviceName, category || "General", Number(price), currency || "JOD", active !== false ? 1 : 0)
      .all();

    return c.json(mapService(results[0]), 201);
  } catch (err) {
    console.error("POST /catalog/services error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.put("/services/:id", async (c) => {
  try {
    const user = c.get("user");
    if (user.role !== "admin") return c.json({ error: "Forbidden" }, 403);

    const id = parseInt(c.req.param("id"));
    const { serviceName, category, price, currency, active } = await c.req.json();
    const db = c.env.DB;

    const sets = ["updated_at=datetime('now')"];
    const params = [];

    if (serviceName !== undefined) { sets.push("service_name=?"); params.push(serviceName); }
    if (category !== undefined) { sets.push("category=?"); params.push(category); }
    if (price !== undefined) { sets.push("price=?"); params.push(Number(price)); }
    if (currency !== undefined) { sets.push("currency=?"); params.push(currency); }
    if (active !== undefined) { sets.push("active=?"); params.push(active ? 1 : 0); }

    params.push(id);
    const { results } = await db.prepare(`UPDATE clinic_services SET ${sets.join(",")} WHERE id=? RETURNING *`).bind(...params).all();
    if (!results.length) return c.json({ error: "Not found" }, 404);
    return c.json(mapService(results[0]));
  } catch (err) {
    console.error("PUT /catalog/services error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.delete("/services/:id", async (c) => {
  try {
    const user = c.get("user");
    if (user.role !== "admin") return c.json({ error: "Forbidden" }, 403);
    await c.env.DB.prepare("DELETE FROM clinic_services WHERE id=?").bind(parseInt(c.req.param("id"))).run();
    return c.json({ success: true });
  } catch (err) {
    console.error("DELETE /catalog/services error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.post("/services/import", async (c) => {
  try {
    const user = c.get("user");
    if (user.role !== "admin") return c.json({ error: "Forbidden" }, 403);

    const { rows: importRows } = await c.req.json();
    if (!Array.isArray(importRows) || importRows.length === 0) return c.json({ error: "No rows provided" }, 400);
    if (importRows.length > 5000) return c.json({ error: "Maximum 5000 rows allowed" }, 400);

    const db = c.env.DB;
    let created = 0, updated = 0, failed = 0;
    const errors = [];

    for (let i = 0; i < importRows.length; i++) {
      const row = importRows[i];
      const rowNum = i + 2;

      if (!row.serviceName || String(row.serviceName).trim() === "") {
        errors.push({ row: rowNum, message: "Missing serviceName" }); failed++; continue;
      }
      if (row.price == null || row.price === "" || isNaN(Number(row.price))) {
        errors.push({ row: rowNum, message: "Missing or invalid price" }); failed++; continue;
      }

      try {
        const existing = await db.prepare("SELECT id FROM clinic_services WHERE service_name=?").bind(String(row.serviceName).trim()).first();
        const isActive = row.active === false || String(row.active).toUpperCase() === "FALSE" ? 0 : 1;

        if (existing) {
          await db.prepare(
            `UPDATE clinic_services SET category=?, price=?, currency=?, active=?, updated_at=datetime('now') WHERE service_name=?`
          ).bind(row.category || "General", Number(row.price), row.currency || "JOD", isActive, String(row.serviceName).trim()).run();
          updated++;
        } else {
          await db.prepare(
            `INSERT INTO clinic_services (service_name, category, price, currency, active) VALUES (?,?,?,?,?)`
          ).bind(String(row.serviceName).trim(), row.category || "General", Number(row.price), row.currency || "JOD", isActive).run();
          created++;
        }
      } catch (rowErr) {
        errors.push({ row: rowNum, message: rowErr.message }); failed++;
      }
    }

    return c.json({ created, updated, failed, errors });
  } catch (err) {
    console.error("POST /catalog/services/import error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

// ===================== MEDICATIONS =====================

app.get("/medications", async (c) => {
  try {
    const { results } = await c.env.DB.prepare(
      "SELECT * FROM clinic_medications ORDER BY COALESCE(brand_name, generic_name)"
    ).all();
    return c.json(results.map(mapMedication));
  } catch (err) {
    console.error("GET /catalog/medications error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.post("/medications", async (c) => {
  try {
    const user = c.get("user");
    if (user.role !== "admin") return c.json({ error: "Forbidden" }, 403);

    const { brandName, genericName, strength, dosageForm, route, defaultDose, defaultFrequency, defaultDuration, notes, active } = await c.req.json();
    if (!brandName && !genericName) return c.json({ error: "At least brandName or genericName required" }, 400);

    const { results } = await c.env.DB.prepare(
      `INSERT INTO clinic_medications (brand_name, generic_name, strength, dosage_form, route, default_dose, default_frequency, default_duration, notes, active)
       VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING *`
    ).bind(
      brandName || null, genericName || null, strength || null, dosageForm || null,
      route || null, defaultDose || null, defaultFrequency || null, defaultDuration || null,
      notes || null, active !== false ? 1 : 0
    ).all();

    return c.json(mapMedication(results[0]), 201);
  } catch (err) {
    if (err.message?.includes("UNIQUE")) return c.json({ error: "Medication already exists with same name/strength/form" }, 409);
    console.error("POST /catalog/medications error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.put("/medications/:id", async (c) => {
  try {
    const user = c.get("user");
    if (user.role !== "admin") return c.json({ error: "Forbidden" }, 403);

    const id = parseInt(c.req.param("id"));
    const { brandName, genericName, strength, dosageForm, route, defaultDose, defaultFrequency, defaultDuration, notes, active } = await c.req.json();
    const db = c.env.DB;

    const sets = ["updated_at=datetime('now')"];
    const params = [];

    if (brandName !== undefined) { sets.push("brand_name=?"); params.push(brandName || null); }
    if (genericName !== undefined) { sets.push("generic_name=?"); params.push(genericName || null); }
    if (strength !== undefined) { sets.push("strength=?"); params.push(strength || null); }
    if (dosageForm !== undefined) { sets.push("dosage_form=?"); params.push(dosageForm || null); }
    if (route !== undefined) { sets.push("route=?"); params.push(route || null); }
    if (defaultDose !== undefined) { sets.push("default_dose=?"); params.push(defaultDose || null); }
    if (defaultFrequency !== undefined) { sets.push("default_frequency=?"); params.push(defaultFrequency || null); }
    if (defaultDuration !== undefined) { sets.push("default_duration=?"); params.push(defaultDuration || null); }
    if (notes !== undefined) { sets.push("notes=?"); params.push(notes || null); }
    if (active !== undefined) { sets.push("active=?"); params.push(active ? 1 : 0); }

    params.push(id);
    const { results } = await db.prepare(`UPDATE clinic_medications SET ${sets.join(",")} WHERE id=? RETURNING *`).bind(...params).all();
    if (!results.length) return c.json({ error: "Not found" }, 404);
    return c.json(mapMedication(results[0]));
  } catch (err) {
    console.error("PUT /catalog/medications error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.delete("/medications/:id", async (c) => {
  try {
    const user = c.get("user");
    if (user.role !== "admin") return c.json({ error: "Forbidden" }, 403);
    await c.env.DB.prepare("DELETE FROM clinic_medications WHERE id=?").bind(parseInt(c.req.param("id"))).run();
    return c.json({ success: true });
  } catch (err) {
    console.error("DELETE /catalog/medications error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.post("/medications/import", async (c) => {
  try {
    const user = c.get("user");
    if (user.role !== "admin") return c.json({ error: "Forbidden" }, 403);

    const { rows: importRows } = await c.req.json();
    if (!Array.isArray(importRows) || importRows.length === 0) return c.json({ error: "No rows provided" }, 400);
    if (importRows.length > 5000) return c.json({ error: "Maximum 5000 rows allowed" }, 400);

    const db = c.env.DB;
    let created = 0, updated = 0, failed = 0;
    const errors = [];

    for (let i = 0; i < importRows.length; i++) {
      const row = importRows[i];
      const rowNum = i + 2;
      const brandName = row.brandName ? String(row.brandName).trim() : null;
      const genericName = row.genericName ? String(row.genericName).trim() : null;
      const strength = row.strength ? String(row.strength).trim() : null;
      const dosageForm = row.dosageForm ? String(row.dosageForm).trim() : null;

      if (!brandName && !genericName) {
        errors.push({ row: rowNum, message: "Missing both brandName and genericName" }); failed++; continue;
      }

      const isActive = row.active === false || String(row.active).toUpperCase() === "FALSE" ? 0 : 1;

      try {
        let existing = null;
        if (brandName) {
          existing = await db.prepare(
            "SELECT id FROM clinic_medications WHERE brand_name=? AND COALESCE(strength,'')=? AND COALESCE(dosage_form,'')=?"
          ).bind(brandName, strength || "", dosageForm || "").first();
        }
        if (!existing && genericName) {
          existing = await db.prepare(
            "SELECT id FROM clinic_medications WHERE generic_name=? AND COALESCE(strength,'')=? AND COALESCE(dosage_form,'')=?"
          ).bind(genericName, strength || "", dosageForm || "").first();
        }

        if (existing) {
          await db.prepare(
            `UPDATE clinic_medications SET brand_name=?, generic_name=?, strength=?, dosage_form=?,
             route=?, default_dose=?, default_frequency=?, default_duration=?, notes=?, active=?, updated_at=datetime('now')
             WHERE id=?`
          ).bind(
            brandName, genericName, strength, dosageForm,
            row.route || null, row.defaultDose || null, row.defaultFrequency || null,
            row.defaultDuration || null, row.notes || null, isActive, existing.id
          ).run();
          updated++;
        } else {
          await db.prepare(
            `INSERT INTO clinic_medications (brand_name, generic_name, strength, dosage_form, route, default_dose, default_frequency, default_duration, notes, active)
             VALUES (?,?,?,?,?,?,?,?,?,?)`
          ).bind(
            brandName, genericName, strength, dosageForm,
            row.route || null, row.defaultDose || null, row.defaultFrequency || null,
            row.defaultDuration || null, row.notes || null, isActive
          ).run();
          created++;
        }
      } catch (rowErr) {
        errors.push({ row: rowNum, message: rowErr.message }); failed++;
      }
    }

    return c.json({ created, updated, failed, errors });
  } catch (err) {
    console.error("POST /catalog/medications/import error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

export default app;
