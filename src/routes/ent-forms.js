import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth.js";

const app = new Hono();
app.use("*", authMiddleware);

// =============================================
// ENT New Patient Questionnaire
// =============================================

app.post("/new-patient", async (c) => {
  try {
    const { role } = c.get("user");
    if (!["admin", "secretary", "doctor"].includes(role)) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const { patientId, chiefComplaint, symptomDuration, symptomSide, symptoms, previousENTTreatment, previousENTDetails, previousENTSurgery, previousENTSurgeryDetails, notes } = await c.req.json();

    if (!patientId) return c.json({ error: "patientId required" }, 400);

    const db = c.env.DB;
    const { results } = await db.prepare(
      `INSERT INTO ent_new_patient_forms (
        patient_id, chief_complaint, symptom_duration, symptom_side,
        symptoms, previous_ent_treatment, previous_ent_details,
        previous_ent_surgery, previous_ent_surgery_details, notes,
        created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      RETURNING *`
    ).bind(
      patientId, chiefComplaint || '', symptomDuration || '', symptomSide || 'none',
      JSON.stringify(symptoms || {}), previousENTTreatment || false, previousENTDetails || '',
      previousENTSurgery || false, previousENTSurgeryDetails || '', notes || '',
      c.get("user").uid || 'system'
    ).all();

    return c.json(results[0], 201);
  } catch (err) {
    console.error("POST /ent-forms/new-patient error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.get("/new-patient/:patientId", async (c) => {
  try {
    const patientId = c.req.param("patientId");
    const { results } = await c.env.DB.prepare(
      "SELECT * FROM ent_new_patient_forms WHERE patient_id=? ORDER BY created_at DESC"
    ).bind(patientId).all();
    return c.json(results);
  } catch (err) {
    console.error("GET /ent-forms/new-patient/:patientId error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

// =============================================
// ENT Follow-Up Form
// =============================================

app.post("/follow-up", async (c) => {
  try {
    const { role } = c.get("user");
    if (!["admin", "secretary", "doctor"].includes(role)) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const {
      patientId, followUpReason, previousDiagnosis, treatmentCompliance,
      symptomAssessment, newSymptoms, medicationEffectiveness, sideEffects,
      sideEffectDetails, isSurgicalFollowUp, surgicalProcedure, woundHealing,
      complications, nextSteps, notes
    } = await c.req.json();

    if (!patientId) return c.json({ error: "patientId required" }, 400);

    const db = c.env.DB;
    const { results } = await db.prepare(
      `INSERT INTO ent_follow_up_forms (
        patient_id, follow_up_reason, previous_diagnosis,
        treatment_compliance, symptom_assessment, new_symptoms,
        medication_effectiveness, side_effects, side_effect_details,
        is_surgical_follow_up, surgical_procedure, wound_healing,
        complications, next_steps, notes,
        created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      RETURNING *`
    ).bind(
      patientId, followUpReason || '', previousDiagnosis || '',
      treatmentCompliance || 'full', symptomAssessment || 'same', newSymptoms || '',
      medicationEffectiveness || '', sideEffects || false, sideEffectDetails || '',
      isSurgicalFollowUp || false, surgicalProcedure || '', woundHealing || '',
      complications || '', nextSteps || '', notes || '',
      c.get("user").uid || 'system'
    ).all();

    return c.json(results[0], 201);
  } catch (err) {
    console.error("POST /ent-forms/follow-up error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.get("/follow-up/:patientId", async (c) => {
  try {
    const patientId = c.req.param("patientId");
    const { results } = await c.env.DB.prepare(
      "SELECT * FROM ent_follow_up_forms WHERE patient_id=? ORDER BY created_at DESC"
    ).bind(patientId).all();
    return c.json(results);
  } catch (err) {
    console.error("GET /ent-forms/follow-up/:patientId error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

// =============================================
// Audiogram
// =============================================

app.post("/audiogram", async (c) => {
  try {
    const { role } = c.get("user");
    if (!["admin", "doctor", "technician"].includes(role)) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const {
      patientId, airConduction, boneConduction, speechAudiometry,
      tympanometry, acousticReflexes, oae, hearingLevel, hearingLossType,
      recommendHearingAid, notes
    } = await c.req.json();

    if (!patientId) return c.json({ error: "patientId required" }, 400);

    const db = c.env.DB;
    const { results } = await db.prepare(
      `INSERT INTO ent_audiograms (
        patient_id, air_conduction, bone_conduction,
        speech_audiometry, tympanometry, acoustic_reflexes, oae,
        hearing_level, hearing_loss_type, recommend_hearing_aid, notes,
        created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      RETURNING *`
    ).bind(
      patientId,
      JSON.stringify(airConduction || {}), JSON.stringify(boneConduction || {}),
      JSON.stringify(speechAudiometry || {}), JSON.stringify(tympanometry || {}),
      JSON.stringify(acousticReflexes || {}), oae || '',
      hearingLevel || '', hearingLossType || '', recommendHearingAid || false,
      notes || '', c.get("user").uid || 'system'
    ).all();

    return c.json(results[0], 201);
  } catch (err) {
    console.error("POST /ent-forms/audiogram error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.get("/audiogram/:patientId", async (c) => {
  try {
    const patientId = c.req.param("patientId");
    const { results } = await c.env.DB.prepare(
      "SELECT * FROM ent_audiograms WHERE patient_id=? ORDER BY created_at DESC"
    ).bind(patientId).all();
    return c.json(results);
  } catch (err) {
    console.error("GET /ent-forms/audiogram/:patientId error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

// =============================================
// Balance Assessment (VNG/BPPV)
// =============================================

app.post("/balance-assessment", async (c) => {
  try {
    const { role } = c.get("user");
    if (!["admin", "doctor", "technician"].includes(role)) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const {
      patientId, vertigoAssessment, associatedSymptoms, vngTests,
      dixHallpike, caloricTest, bppvDiagnosis, vestibularFunction, notes
    } = await c.req.json();

    if (!patientId) return c.json({ error: "patientId required" }, 400);

    const db = c.env.DB;
    const { results } = await db.prepare(
      `INSERT INTO ent_balance_assessments (
        patient_id, vertigo_assessment, associated_symptoms,
        vng_tests, dix_hallpike, caloric_test, bppv_diagnosis,
        vestibular_function, notes,
        created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      RETURNING *`
    ).bind(
      patientId,
      JSON.stringify(vertigoAssessment || {}), JSON.stringify(associatedSymptoms || []),
      JSON.stringify(vngTests || {}), JSON.stringify(dixHallpike || {}),
      JSON.stringify(caloricTest || {}), JSON.stringify(bppvDiagnosis || {}),
      vestibularFunction || '', notes || '', c.get("user").uid || 'system'
    ).all();

    return c.json(results[0], 201);
  } catch (err) {
    console.error("POST /ent-forms/balance-assessment error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.get("/balance-assessment/:patientId", async (c) => {
  try {
    const patientId = c.req.param("patientId");
    const { results } = await c.env.DB.prepare(
      "SELECT * FROM ent_balance_assessments WHERE patient_id=? ORDER BY created_at DESC"
    ).bind(patientId).all();
    return c.json(results);
  } catch (err) {
    console.error("GET /ent-forms/balance-assessment/:patientId error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

// =============================================
// Referral Form
// =============================================

app.post("/referral", async (c) => {
  try {
    const { role } = c.get("user");
    if (!["admin", "doctor"].includes(role)) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const {
      patientId, referringDoctor, referredToSpecialty, referredToDoctor,
      referredToHospital, clinicalInfo, urgency, notes
    } = await c.req.json();

    if (!patientId) return c.json({ error: "patientId required" }, 400);

    const db = c.env.DB;
    const { results } = await db.prepare(
      `INSERT INTO ent_referrals (
        patient_id, referring_doctor, referred_to_specialty,
        referred_to_doctor, referred_to_hospital, clinical_info,
        urgency, notes,
        created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      RETURNING *`
    ).bind(
      patientId, referringDoctor || '',
      referredToSpecialty || '', referredToDoctor || '', referredToHospital || '',
      JSON.stringify(clinicalInfo || {}), urgency || 'routine',
      notes || '', c.get("user").uid || 'system'
    ).all();

    return c.json(results[0], 201);
  } catch (err) {
    console.error("POST /ent-forms/referral error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

app.get("/referral/:patientId", async (c) => {
  try {
    const patientId = c.req.param("patientId");
    const { results } = await c.env.DB.prepare(
      "SELECT * FROM ent_referrals WHERE patient_id=? ORDER BY created_at DESC"
    ).bind(patientId).all();
    return c.json(results);
  } catch (err) {
    console.error("GET /ent-forms/referral/:patientId error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

// =============================================
// Get ALL forms for a patient (summary)
// =============================================

app.get("/patient/:patientId/all", async (c) => {
  try {
    const patientId = c.req.param("patientId");
    const db = c.env.DB;

    const [newPatient, followUp, audiogram, balance, referral] = await Promise.all([
      db.prepare("SELECT id, created_at, chief_complaint FROM ent_new_patient_forms WHERE patient_id=? ORDER BY created_at DESC").bind(patientId).all(),
      db.prepare("SELECT id, created_at, follow_up_reason FROM ent_follow_up_forms WHERE patient_id=? ORDER BY created_at DESC").bind(patientId).all(),
      db.prepare("SELECT id, created_at, hearing_level FROM ent_audiograms WHERE patient_id=? ORDER BY created_at DESC").bind(patientId).all(),
      db.prepare("SELECT id, created_at, vestibular_function FROM ent_balance_assessments WHERE patient_id=? ORDER BY created_at DESC").bind(patientId).all(),
      db.prepare("SELECT id, created_at, referred_to_specialty, urgency FROM ent_referrals WHERE patient_id=? ORDER BY created_at DESC").bind(patientId).all(),
    ]);

    return c.json({
      newPatientForms: newPatient.results,
      followUpForms: followUp.results,
      audiograms: audiogram.results,
      balanceAssessments: balance.results,
      referrals: referral.results,
    });
  } catch (err) {
    console.error("GET /ent-forms/patient/:patientId/all error:", err);
    return c.json({ error: "Server error" }, 500);
  }
});

export default app;
