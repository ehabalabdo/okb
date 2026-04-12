import express from "express";
import pool from "../db.js";
import { auth } from "../middleware/auth.js";

const router = express.Router();
router.use(auth);

// =============================================
// ENT New Patient Questionnaire
// =============================================

// POST /ent-forms/new-patient
router.post("/new-patient", async (req, res) => {
  try {
    const { role } = req.user;
    if (!["admin", "secretary", "doctor"].includes(role)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const { patientId, chiefComplaint, symptomDuration, symptomSide, symptoms, previousENTTreatment, previousENTDetails, previousENTSurgery, previousENTSurgeryDetails, notes } = req.body;

    if (!patientId) return res.status(400).json({ error: "patientId required" });

    const { rows } = await pool.query(
      `INSERT INTO ent_new_patient_forms (
        patient_id, chief_complaint, symptom_duration, symptom_side,
        symptoms, previous_ent_treatment, previous_ent_details,
        previous_ent_surgery, previous_ent_surgery_details, notes,
        created_by, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, NOW(), NOW())
      RETURNING *`,
      [
        patientId, chiefComplaint || '', symptomDuration || '', symptomSide || 'none',
        JSON.stringify(symptoms || {}), previousENTTreatment || false, previousENTDetails || '',
        previousENTSurgery || false, previousENTSurgeryDetails || '', notes || '',
        req.user.uid || 'system'
      ]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("POST /ent-forms/new-patient error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /ent-forms/new-patient/:patientId
router.get("/new-patient/:patientId", async (req, res) => {
  try {
    const { patientId } = req.params;
    const { rows } = await pool.query(
      "SELECT * FROM ent_new_patient_forms WHERE patient_id=$1 ORDER BY created_at DESC",
      [patientId]
    );
    res.json(rows);
  } catch (err) {
    console.error("GET /ent-forms/new-patient/:patientId error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// =============================================
// ENT Follow-Up Form
// =============================================

// POST /ent-forms/follow-up
router.post("/follow-up", async (req, res) => {
  try {
    const { role } = req.user;
    if (!["admin", "secretary", "doctor"].includes(role)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const {
      patientId, followUpReason, previousDiagnosis, treatmentCompliance,
      symptomAssessment, newSymptoms, medicationEffectiveness, sideEffects,
      sideEffectDetails, isSurgicalFollowUp, surgicalProcedure, woundHealing,
      complications, nextSteps, notes
    } = req.body;

    if (!patientId) return res.status(400).json({ error: "patientId required" });

    const { rows } = await pool.query(
      `INSERT INTO ent_follow_up_forms (
        patient_id, follow_up_reason, previous_diagnosis,
        treatment_compliance, symptom_assessment, new_symptoms,
        medication_effectiveness, side_effects, side_effect_details,
        is_surgical_follow_up, surgical_procedure, wound_healing,
        complications, next_steps, notes,
        created_by, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW(), NOW())
      RETURNING *`,
      [
        patientId, followUpReason || '', previousDiagnosis || '',
        treatmentCompliance || 'full', symptomAssessment || 'same', newSymptoms || '',
        medicationEffectiveness || '', sideEffects || false, sideEffectDetails || '',
        isSurgicalFollowUp || false, surgicalProcedure || '', woundHealing || '',
        complications || '', nextSteps || '', notes || '',
        req.user.uid || 'system'
      ]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("POST /ent-forms/follow-up error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /ent-forms/follow-up/:patientId
router.get("/follow-up/:patientId", async (req, res) => {
  try {
    const { patientId } = req.params;
    const { rows } = await pool.query(
      "SELECT * FROM ent_follow_up_forms WHERE patient_id=$1 ORDER BY created_at DESC",
      [patientId]
    );
    res.json(rows);
  } catch (err) {
    console.error("GET /ent-forms/follow-up/:patientId error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// =============================================
// Audiogram
// =============================================

// POST /ent-forms/audiogram
router.post("/audiogram", async (req, res) => {
  try {
    const { role } = req.user;
    if (!["admin", "doctor", "technician"].includes(role)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const {
      patientId, airConduction, boneConduction, speechAudiometry,
      tympanometry, acousticReflexes, oae, hearingLevel, hearingLossType,
      recommendHearingAid, notes
    } = req.body;

    if (!patientId) return res.status(400).json({ error: "patientId required" });

    const { rows } = await pool.query(
      `INSERT INTO ent_audiograms (
        patient_id, air_conduction, bone_conduction,
        speech_audiometry, tympanometry, acoustic_reflexes, oae,
        hearing_level, hearing_loss_type, recommend_hearing_aid, notes,
        created_by, created_at, updated_at
      ) VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11, $12, NOW(), NOW())
      RETURNING *`,
      [
        patientId,
        JSON.stringify(airConduction || {}), JSON.stringify(boneConduction || {}),
        JSON.stringify(speechAudiometry || {}), JSON.stringify(tympanometry || {}),
        JSON.stringify(acousticReflexes || {}), oae || '',
        hearingLevel || '', hearingLossType || '', recommendHearingAid || false,
        notes || '', req.user.uid || 'system'
      ]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("POST /ent-forms/audiogram error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /ent-forms/audiogram/:patientId
router.get("/audiogram/:patientId", async (req, res) => {
  try {
    const { patientId } = req.params;
    const { rows } = await pool.query(
      "SELECT * FROM ent_audiograms WHERE patient_id=$1 ORDER BY created_at DESC",
      [patientId]
    );
    res.json(rows);
  } catch (err) {
    console.error("GET /ent-forms/audiogram/:patientId error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// =============================================
// Balance Assessment (VNG/BPPV)
// =============================================

// POST /ent-forms/balance-assessment
router.post("/balance-assessment", async (req, res) => {
  try {
    const { role } = req.user;
    if (!["admin", "doctor", "technician"].includes(role)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const {
      patientId, vertigoAssessment, associatedSymptoms, vngTests,
      dixHallpike, caloricTest, bppvDiagnosis, vestibularFunction, notes
    } = req.body;

    if (!patientId) return res.status(400).json({ error: "patientId required" });

    const { rows } = await pool.query(
      `INSERT INTO ent_balance_assessments (
        patient_id, vertigo_assessment, associated_symptoms,
        vng_tests, dix_hallpike, caloric_test, bppv_diagnosis,
        vestibular_function, notes,
        created_by, created_at, updated_at
      ) VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $10, NOW(), NOW())
      RETURNING *`,
      [
        patientId,
        JSON.stringify(vertigoAssessment || {}), JSON.stringify(associatedSymptoms || []),
        JSON.stringify(vngTests || {}), JSON.stringify(dixHallpike || {}),
        JSON.stringify(caloricTest || {}), JSON.stringify(bppvDiagnosis || {}),
        vestibularFunction || '', notes || '', req.user.uid || 'system'
      ]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("POST /ent-forms/balance-assessment error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /ent-forms/balance-assessment/:patientId
router.get("/balance-assessment/:patientId", async (req, res) => {
  try {
    const { patientId } = req.params;
    const { rows } = await pool.query(
      "SELECT * FROM ent_balance_assessments WHERE patient_id=$1 ORDER BY created_at DESC",
      [patientId]
    );
    res.json(rows);
  } catch (err) {
    console.error("GET /ent-forms/balance-assessment/:patientId error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// =============================================
// Referral Form
// =============================================

// POST /ent-forms/referral
router.post("/referral", async (req, res) => {
  try {
    const { role } = req.user;
    if (!["admin", "doctor"].includes(role)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const {
      patientId, referringDoctor, referredToSpecialty, referredToDoctor,
      referredToHospital, clinicalInfo, urgency, notes
    } = req.body;

    if (!patientId) return res.status(400).json({ error: "patientId required" });

    const { rows } = await pool.query(
      `INSERT INTO ent_referrals (
        patient_id, referring_doctor, referred_to_specialty,
        referred_to_doctor, referred_to_hospital, clinical_info,
        urgency, notes,
        created_by, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, NOW(), NOW())
      RETURNING *`,
      [
        patientId, referringDoctor || '',
        referredToSpecialty || '', referredToDoctor || '', referredToHospital || '',
        JSON.stringify(clinicalInfo || {}), urgency || 'routine',
        notes || '', req.user.uid || 'system'
      ]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("POST /ent-forms/referral error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /ent-forms/referral/:patientId
router.get("/referral/:patientId", async (req, res) => {
  try {
    const { patientId } = req.params;
    const { rows } = await pool.query(
      "SELECT * FROM ent_referrals WHERE patient_id=$1 ORDER BY created_at DESC",
      [patientId]
    );
    res.json(rows);
  } catch (err) {
    console.error("GET /ent-forms/referral/:patientId error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// =============================================
// Get ALL forms for a patient (summary)
// =============================================

router.get("/patient/:patientId/all", async (req, res) => {
  try {
    const { patientId } = req.params;

    const [newPatient, followUp, audiogram, balance, referral] = await Promise.all([
      pool.query(`SELECT id, created_at, chief_complaint FROM ent_new_patient_forms WHERE patient_id=$1 ORDER BY created_at DESC`, [patientId]),
      pool.query(`SELECT id, created_at, follow_up_reason FROM ent_follow_up_forms WHERE patient_id=$1 ORDER BY created_at DESC`, [patientId]),
      pool.query(`SELECT id, created_at, hearing_level FROM ent_audiograms WHERE patient_id=$1 ORDER BY created_at DESC`, [patientId]),
      pool.query(`SELECT id, created_at, vestibular_function FROM ent_balance_assessments WHERE patient_id=$1 ORDER BY created_at DESC`, [patientId]),
      pool.query(`SELECT id, created_at, referred_to_specialty, urgency FROM ent_referrals WHERE patient_id=$1 ORDER BY created_at DESC`, [patientId]),
    ]);

    res.json({
      newPatientForms: newPatient.rows,
      followUpForms: followUp.rows,
      audiograms: audiogram.rows,
      balanceAssessments: balance.rows,
      referrals: referral.rows,
    });
  } catch (err) {
    console.error("GET /ent-forms/patient/:patientId/all error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
