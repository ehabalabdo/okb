import { z } from "zod";

export const createAppointmentSchema = z.object({
  patient_id: z.number().int().positive().optional(),
  patientId: z.union([z.number(), z.string()]).optional(),
  patient_name: z.string().max(200).optional(),
  patientName: z.string().max(200).optional(),
  doctor_id: z.number().int().positive().optional(),
  doctorId: z.union([z.number(), z.string()]).optional(),
  clinic_id: z.number().int().positive().optional(),
  clinicId: z.union([z.number(), z.string()]).optional(),
  start_time: z.string().optional(),
  date: z.union([z.string(), z.number()]).optional(),
  end_time: z.string().optional(),
  reason: z.string().max(500).optional(),
  status: z.enum(["pending", "waiting", "in-progress", "completed", "cancelled", "no-show"]).optional(),
}).refine(
  (d) => (d.patient_id || d.patientId) && (d.start_time || d.date),
  { message: "patient_id and start_time/date are required" }
);
