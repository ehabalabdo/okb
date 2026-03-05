import dotenv from 'dotenv';
dotenv.config();
import pool from './src/db.js';
import PDFDocument from 'pdfkit';
import { Writable } from 'stream';

try {
  const { rows } = await pool.query(
    `SELECT p.*, e.full_name AS employee_name, e.department, e.job_title
     FROM hr_payslips p
     JOIN hr_employees e ON e.id = p.employee_id
     WHERE p.client_id=3 LIMIT 1`
  );
  if (!rows.length) { console.log('No payslip found'); process.exit(1); }
  const p = rows[0];
  console.log('Payslip columns:', Object.keys(p).join(', '));
  console.log('basic_salary:', p.basic_salary, typeof p.basic_salary);
  console.log('employee_ss:', p.employee_ss);
  console.log('final_late_amount:', p.final_late_amount);
  console.log('final_overtime_amount:', p.final_overtime_amount);
  console.log('overtime_multiplier:', p.overtime_multiplier);
  console.log('manual_deductions_total:', p.manual_deductions_total);
  console.log('net_salary:', p.net_salary);
  console.log('month:', p.month, typeof p.month);
  console.log('status:', p.status);

  // Now try generating the PDF
  const clientRes = await pool.query(`SELECT name FROM clients WHERE id=3`);
  const clientName = clientRes.rows.length ? clientRes.rows[0].name : 'MED LOOP';

  const monthDate = new Date(p.month);
  const monthLabel = monthDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
  console.log('monthLabel:', monthLabel);

  const num = (v) => parseFloat(v) || 0;
  const basicSalary = num(p.basic_salary);
  const employeeSs = num(p.employee_ss);
  const employerSs = num(p.employer_ss);
  const lateAmount = num(p.final_late_amount);
  const absenceAmount = num(p.final_absence_amount);
  const overtimeAmount = num(p.final_overtime_amount) * num(p.overtime_multiplier);
  const manualDeductions = num(p.manual_deductions_total);
  const netSalary = num(p.net_salary);

  console.log('Parsed values:', { basicSalary, employeeSs, employerSs, lateAmount, absenceAmount, overtimeAmount, manualDeductions, netSalary });

  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const chunks = [];
  const ws = new Writable({
    write(chunk, enc, cb) { chunks.push(chunk); cb(); }
  });
  doc.pipe(ws);

  // Header
  doc.fontSize(20).font('Helvetica-Bold').text(clientName.toUpperCase(), { align: 'center' });
  doc.fontSize(10).font('Helvetica').text('Payslip / Salary Statement', { align: 'center' });
  doc.moveDown(0.5);
  doc.fontSize(12).font('Helvetica-Bold').text(monthLabel, { align: 'center' });
  doc.moveDown(1);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#cccccc');
  doc.moveDown(0.5);

  // Employee Info
  doc.fontSize(11).font('Helvetica-Bold').text('Employee Information', { underline: true });
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(10);
  const infoY = doc.y;
  doc.text(`Name: ${p.employee_name}`, 50, infoY);
  doc.text(`Department: ${p.department || '-'}`, 300, infoY);
  doc.text(`Job Title: ${p.job_title || '-'}`, 50, infoY + 18);
  doc.text(`Status: ${(p.status || 'draft').toUpperCase()}`, 300, infoY + 18);
  doc.moveDown(2.5);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#cccccc');
  doc.moveDown(0.5);

  // Attendance
  doc.fontSize(11).font('Helvetica-Bold').text('Attendance Summary', { underline: true });
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(10);
  const attY = doc.y;
  doc.text(`Days Worked: ${p.days_worked || 0}`, 50, attY);
  doc.text(`Absent Days: ${p.suggested_absent_days || 0}`, 200, attY);
  doc.text(`Late Minutes: ${p.suggested_late_minutes || 0}`, 350, attY);
  doc.text(`OT Minutes: ${p.suggested_overtime_minutes || 0}`, 50, attY + 18);
  doc.text(`Break Minutes: ${p.total_break_minutes || 0}`, 200, attY + 18);
  doc.moveDown(2.5);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#cccccc');
  doc.moveDown(0.5);

  // Financial
  doc.fontSize(11).font('Helvetica-Bold').text('Financial Breakdown', { underline: true });
  doc.moveDown(0.5);

  const tableX = 60;
  const valX = 420;
  let rowY = doc.y;
  const rowH = 22;

  function drawRow(label, value, bold, color) {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10);
    if (color) doc.fillColor(color);
    doc.text(label, tableX, rowY);
    doc.text(value, valX, rowY, { align: 'right', width: 100 });
    doc.fillColor('#000000');
    rowY += rowH;
  }

  doc.rect(tableX - 5, rowY - 3, 480, rowH).fill('#f1f5f9');
  doc.fillColor('#000000');
  drawRow('Description', 'Amount (JOD)', true);
  drawRow('Basic Salary', basicSalary.toFixed(2), false);
  drawRow('Social Security (Employee 7.5%)', `- ${employeeSs.toFixed(2)}`, false, '#dc2626');
  drawRow('Social Security (Employer 14.25%)', employerSs.toFixed(2), false, '#6b7280');
  doc.moveTo(tableX, rowY - 5).lineTo(tableX + 470, rowY - 5).stroke('#e2e8f0');
  if (lateAmount > 0) drawRow('Late Deduction', `- ${lateAmount.toFixed(2)}`, false, '#dc2626');
  if (absenceAmount > 0) drawRow('Absence Deduction', `- ${absenceAmount.toFixed(2)}`, false, '#dc2626');
  if (manualDeductions > 0) drawRow('Manual Deductions', `- ${manualDeductions.toFixed(2)}`, false, '#dc2626');
  if (overtimeAmount > 0) drawRow('Overtime Bonus', `+ ${overtimeAmount.toFixed(2)}`, false, '#059669');
  doc.moveTo(tableX, rowY - 3).lineTo(tableX + 470, rowY - 3).stroke('#334155');
  doc.moveTo(tableX, rowY - 1).lineTo(tableX + 470, rowY - 1).stroke('#334155');
  rowY += 4;

  doc.rect(tableX - 5, rowY - 3, 480, rowH + 6).fill('#f0fdf4');
  doc.fillColor('#059669');
  doc.font('Helvetica-Bold').fontSize(13);
  doc.text('Net Salary', tableX, rowY + 2);
  doc.text(`${netSalary.toFixed(2)} JOD`, valX - 20, rowY + 2, { align: 'right', width: 120 });
  doc.fillColor('#000000');

  doc.fontSize(8).font('Helvetica').fillColor('#94a3b8');
  doc.text(`Generated by MED LOOP HR System — ${new Date().toISOString().slice(0, 10)}`, 50, 770, { align: 'center' });
  doc.end();

  ws.on('finish', () => {
    const pdf = Buffer.concat(chunks);
    console.log('\n✅ PDF generated successfully! Size:', pdf.length, 'bytes');
    pool.end();
    process.exit(0);
  });

  ws.on('error', (err) => {
    console.error('Stream error:', err);
    pool.end();
    process.exit(1);
  });

} catch (err) {
  console.error('ERROR:', err.message);
  console.error(err.stack);
  pool.end();
  process.exit(1);
}
