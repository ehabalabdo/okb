-- ENT Forms Migration for Dr. Tarek Khrais Clinic
-- Creates tables for all 5 ENT medical form types

-- =============================================
-- ENT NEW PATIENT QUESTIONNAIRE
-- =============================================
CREATE TABLE IF NOT EXISTS ent_new_patient_forms (
    id SERIAL PRIMARY KEY,
    patient_id VARCHAR(255) NOT NULL,
    client_id INTEGER,
    chief_complaint TEXT,
    symptom_duration VARCHAR(100),
    symptom_side VARCHAR(20) DEFAULT 'none' CHECK (symptom_side IN ('right', 'left', 'both', 'none')),
    symptoms JSONB DEFAULT '{}',
    previous_ent_treatment BOOLEAN DEFAULT false,
    previous_ent_details TEXT,
    previous_ent_surgery BOOLEAN DEFAULT false,
    previous_ent_surgery_details TEXT,
    notes TEXT,
    created_by VARCHAR(255) DEFAULT 'system',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_ent_new_patient_patient_id ON ent_new_patient_forms(patient_id);
CREATE INDEX idx_ent_new_patient_client_id ON ent_new_patient_forms(client_id);

-- =============================================
-- ENT FOLLOW-UP FORM
-- =============================================
CREATE TABLE IF NOT EXISTS ent_follow_up_forms (
    id SERIAL PRIMARY KEY,
    patient_id VARCHAR(255) NOT NULL,
    client_id INTEGER,
    follow_up_reason TEXT,
    previous_diagnosis TEXT,
    treatment_compliance VARCHAR(20) DEFAULT 'full' CHECK (treatment_compliance IN ('full', 'partial', 'none')),
    symptom_assessment VARCHAR(20) DEFAULT 'same' CHECK (symptom_assessment IN ('improved', 'same', 'worsened', 'new')),
    new_symptoms TEXT,
    medication_effectiveness TEXT,
    side_effects BOOLEAN DEFAULT false,
    side_effect_details TEXT,
    is_surgical_follow_up BOOLEAN DEFAULT false,
    surgical_procedure TEXT,
    wound_healing TEXT,
    complications TEXT,
    next_steps TEXT,
    notes TEXT,
    created_by VARCHAR(255) DEFAULT 'system',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_ent_follow_up_patient_id ON ent_follow_up_forms(patient_id);
CREATE INDEX idx_ent_follow_up_client_id ON ent_follow_up_forms(client_id);

-- =============================================
-- ENT AUDIOGRAMS
-- =============================================
CREATE TABLE IF NOT EXISTS ent_audiograms (
    id SERIAL PRIMARY KEY,
    patient_id VARCHAR(255) NOT NULL,
    client_id INTEGER,
    air_conduction JSONB DEFAULT '{}',
    bone_conduction JSONB DEFAULT '{}',
    speech_audiometry JSONB DEFAULT '{}',
    tympanometry JSONB DEFAULT '{}',
    acoustic_reflexes JSONB DEFAULT '{}',
    oae VARCHAR(20),
    hearing_level VARCHAR(50),
    hearing_loss_type VARCHAR(50),
    recommend_hearing_aid BOOLEAN DEFAULT false,
    notes TEXT,
    created_by VARCHAR(255) DEFAULT 'system',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_ent_audiogram_patient_id ON ent_audiograms(patient_id);
CREATE INDEX idx_ent_audiogram_client_id ON ent_audiograms(client_id);

-- =============================================
-- ENT BALANCE ASSESSMENTS (VNG/BPPV)
-- =============================================
CREATE TABLE IF NOT EXISTS ent_balance_assessments (
    id SERIAL PRIMARY KEY,
    patient_id VARCHAR(255) NOT NULL,
    client_id INTEGER,
    vertigo_assessment JSONB DEFAULT '{}',
    associated_symptoms JSONB DEFAULT '[]',
    vng_tests JSONB DEFAULT '{}',
    dix_hallpike JSONB DEFAULT '{}',
    caloric_test JSONB DEFAULT '{}',
    bppv_diagnosis JSONB DEFAULT '{}',
    vestibular_function VARCHAR(50),
    notes TEXT,
    created_by VARCHAR(255) DEFAULT 'system',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_ent_balance_patient_id ON ent_balance_assessments(patient_id);
CREATE INDEX idx_ent_balance_client_id ON ent_balance_assessments(client_id);

-- =============================================
-- ENT REFERRALS
-- =============================================
CREATE TABLE IF NOT EXISTS ent_referrals (
    id SERIAL PRIMARY KEY,
    patient_id VARCHAR(255) NOT NULL,
    client_id INTEGER,
    referring_doctor VARCHAR(255) DEFAULT 'د. طارق خريس',
    referred_to_specialty VARCHAR(255),
    referred_to_doctor VARCHAR(255),
    referred_to_hospital VARCHAR(255),
    clinical_info JSONB DEFAULT '{}',
    urgency VARCHAR(20) DEFAULT 'routine' CHECK (urgency IN ('routine', 'urgent', 'emergency')),
    notes TEXT,
    created_by VARCHAR(255) DEFAULT 'system',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_ent_referral_patient_id ON ent_referrals(patient_id);
CREATE INDEX idx_ent_referral_client_id ON ent_referrals(client_id);

-- =============================================
-- Update default system settings for Dr. Tarek
-- =============================================
UPDATE system_settings 
SET clinic_name = 'عيادة د. طارق خريس - أنف وأذن وحنجرة',
    phone = '0790904030'
WHERE id = 'settings_default';
