/**
 * PRINASA benchmark — SQL-side questions (categories shared with the standard
 * benchmark taxonomy). 260 questions; the remaining 240 hybrid/cross-source
 * + robustness questions live in prinasa-hybrid.ts.
 *
 * Ground truth was verified against the PRINASA snapshot (52 tables;
 * participants=5044 DH=5023/SUBCON=20/VISITOR=1, permits=32 ACTIVE=23/
 * EXPIRED=9 MINE_PERMIT=23/KIMPER=2/SIMPER=7, mcu_registrations=28,
 * training_batches=14, induction_batches=31, tags=8, departments=239,
 * sites=10, companies=13, equipment_models=850, employee_profiles=5020).
 *
 * Bilingual (EN/ID mix) — exercises the router's language handling.
 * PascalCase quoted identifiers match the live schema exactly.
 */
import type { BenchmarkQuestion } from '../types'

function q(
  id: string,
  category: BenchmarkQuestion['category'],
  difficulty: BenchmarkQuestion['difficulty'],
  question: string,
  groundTruthSql: string,
  expectedAnswerContains: string[],
  expectedColumns: string[],
): BenchmarkQuestion {
  return { id, category, difficulty, question, groundTruthSql, expectedAnswerContains, expectedColumns, integrationId: 'int-prinasa-001', tags: [] }
}

export const prinasaSqlQuestions: BenchmarkQuestion[] = [
  // ═════════ simple_select (40) ═════════
  q('prin-001', 'simple_select', 'easy', 'Berapa jumlah peserta (participants) yang terdaftar dalam sistem?', 'SELECT COUNT(*) AS total FROM participants', ['5044'], ['total']),
  q('prin-002', 'simple_select', 'easy', 'How many permits have been issued in total?', 'SELECT COUNT(*) AS total FROM permits', ['32'], ['total']),
  q('prin-003', 'simple_select', 'easy', 'Berapa banyak perusahaan (companies) terdaftar sebagai vendor?', 'SELECT COUNT(*) AS total FROM companies', ['13'], ['total']),
  q('prin-004', 'simple_select', 'easy', 'How many sites are configured in the system?', 'SELECT COUNT(*) AS total FROM sites', ['10'], ['total']),
  q('prin-005', 'simple_select', 'easy', 'Berapa jumlah department yang aktif?', 'SELECT COUNT(*) AS total FROM departments WHERE "IsActive" = true', [], ['total']),
  q('prin-006', 'simple_select', 'easy', 'How many MCU (medical check-up) registrations exist?', 'SELECT COUNT(*) AS total FROM mcu_registrations', ['28'], ['total']),
  q('prin-007', 'simple_select', 'easy', 'Berapa jumlah batch pelatihan (training batches) yang ada?', 'SELECT COUNT(*) AS total FROM training_batches', ['14'], ['total']),
  q('prin-008', 'simple_select', 'easy', 'How many induction batches are recorded?', 'SELECT COUNT(*) AS total FROM induction_batches', ['31'], ['total']),
  q('prin-009', 'simple_select', 'easy', 'Sebutkan semua tipe peserta (participant types) yang ada.', 'SELECT DISTINCT "ParticipantType" FROM participants', ['DH', 'SUBCON', 'VISITOR'], ['ParticipantType']),
  q('prin-010', 'simple_select', 'easy', 'What are the distinct permit statuses?', 'SELECT DISTINCT "Status" FROM permits ORDER BY "Status"', ['ACTIVE', 'EXPIRED'], ['Status']),
  q('prin-011', 'simple_select', 'easy', 'Berapa jumlah karyawan (employee profiles) yang tercatat?', 'SELECT COUNT(*) AS total FROM employee_profiles', ['5020'], ['total']),
  q('prin-012', 'simple_select', 'easy', 'How many equipment models are registered?', 'SELECT COUNT(*) AS total FROM equipment_models', ['850'], ['total']),
  q('prin-013', 'simple_select', 'easy', 'Sebutkan kode dan nama semua site.', 'SELECT "Code", "Name" FROM sites ORDER BY "Code"', ['ACP', 'BANJARBARU', 'JKT'], ['Code', 'Name']),
  q('prin-014', 'simple_select', 'easy', 'List all company codes and names.', 'SELECT "Code", "Name" FROM companies ORDER BY "Code"', ['DH', 'PT DARMA HENWA'], ['Code', 'Name']),
  q('prin-015', 'simple_select', 'easy', 'Apa saja tipe permit yang diterbitkan?', 'SELECT DISTINCT "PermitType" FROM permits', ['MINE_PERMIT', 'KIMPER', 'SIMPER'], ['PermitType']),
  q('prin-016', 'simple_select', 'easy', 'What are the distinct MCU result statuses?', 'SELECT DISTINCT "ResultStatus" FROM mcu_results', [], ['ResultStatus']),
  q('prin-017', 'simple_select', 'easy', 'Berapa jumlah trainer yang terdaftar?', 'SELECT COUNT(*) AS total FROM trainers', ['6'], ['total']),
  q('prin-018', 'simple_select', 'easy', 'How many clinics are registered?', 'SELECT COUNT(*) AS total FROM clinics', ['8'], ['total']),
  q('prin-019', 'simple_select', 'easy', 'Sebutkan nama semua training types yang aktif.', 'SELECT "Name" FROM training_types WHERE "IsActive" = true', ['HI', 'MTR', 'PLH'], ['Name']),
  q('prin-020', 'simple_select', 'easy', 'How many vehicle types exist?', 'SELECT COUNT(*) AS total FROM vehicle_types', ['5'], ['total']),
  q('prin-021', 'simple_select', 'easy', 'Berapa jumlah workpits yang terdaftar?', 'SELECT COUNT(*) AS total FROM workpits', [], ['total']),
  q('prin-022', 'simple_select', 'easy', 'List all MCU category names.', 'SELECT "Name" FROM mcu_categories ORDER BY "Name"', [], ['Name']),
  q('prin-023', 'simple_select', 'easy', 'Berapa jumlah tag (safety tags) yang pernah diterbitkan?', 'SELECT COUNT(*) AS total FROM tags', ['8'], ['total']),
  q('prin-024', 'simple_select', 'easy', 'Berapa peserta bertipe DH (direct hire)?', 'SELECT COUNT(*) AS total FROM participants WHERE "ParticipantType" = \'DH\'', ['5023'], ['total']),
  q('prin-025', 'simple_select', 'easy', 'How many participants are SUBCON?', 'SELECT COUNT(*) AS total FROM participants WHERE "ParticipantType" = \'SUBCON\'', ['20'], ['total']),
  q('prin-026', 'simple_select', 'easy', 'Sebutkan nama site yang berlokasi di kota Banjarmasin jika ada.', 'SELECT "Name", "Location" FROM sites WHERE "Location" ILIKE \'%banjarmasin%\'', [], ['Name', 'Location']),
  q('prin-027', 'simple_select', 'easy', 'Which sites require MCU HE input date?', 'SELECT "Name" FROM sites WHERE "RequireMcuHeInputDate" = true', [], ['Name']),
  q('prin-028', 'simple_select', 'easy', 'Berapa jumlah peserta yang memiliki email terdaftar?', 'SELECT COUNT(*) AS total FROM participants WHERE "Email" IS NOT NULL AND "Email" <> \'\'', [], ['total']),
  q('prin-029', 'simple_select', 'easy', 'Tampilkan 10 department pertama secara alfabetis.', 'SELECT "Name" FROM departments ORDER BY "Name" LIMIT 10', [], ['Name']),
  q('prin-030', 'simple_select', 'easy', 'What is the total number of induction modules?', 'SELECT COUNT(*) AS total FROM induction_modules', ['16'], ['total']),
  q('prin-031', 'simple_select', 'easy', 'Berapa jumlah audit log yang tercatat?', 'SELECT COUNT(*) AS total FROM audit_logs', [], ['total']),
  q('prin-032', 'simple_select', 'easy', 'How many users exist in the system?', 'SELECT COUNT(*) AS total FROM users', [], ['total']),
  q('prin-033', 'simple_select', 'easy', 'Sebutkan nama-nama trainer.', 'SELECT "Name" FROM trainers ORDER BY "Name"', [], ['Name']),
  q('prin-034', 'simple_select', 'easy', 'List induction types by name.', 'SELECT "Name" FROM induction_types ORDER BY "Name"', [], ['Name']),
  q('prin-035', 'simple_select', 'easy', 'How many training requests are in the system?', 'SELECT COUNT(*) AS total FROM training_requests', ['15'], ['total']),
  q('prin-036', 'simple_select', 'easy', 'Berapa jumlah equipment model terdaftar?', 'SELECT COUNT(*) AS total FROM equipment_models', ['850'], ['total']),
  q('prin-037', 'simple_select', 'easy', 'Show all active companies.', 'SELECT "Name" FROM companies WHERE "IsActive" = true', [], ['Name']),
  q('prin-038', 'simple_select', 'easy', 'Training batch yang ExamMode-nya ONLINE ada berapa?', 'SELECT COUNT(*) AS total FROM training_batches WHERE "ExamMode" = \'ONLINE\'', [], ['total']),
  q('prin-039', 'simple_select', 'easy', 'Berapa peserta VISITOR yang terdaftar?', 'SELECT COUNT(*) AS total FROM participants WHERE "ParticipantType" = \'VISITOR\'', ['1'], ['total']),
  q('prin-040', 'simple_select', 'easy', 'How many subcon profiles exist?', 'SELECT COUNT(*) AS total FROM subcon_profiles', [], ['total']),

  // ═════════ filtering (45) ═════════
  q('prin-041', 'filtering', 'easy', 'Siapa saja peserta dengan status INACTIVE?', 'SELECT "FullName" FROM participants WHERE "Status" = \'INACTIVE\'', [], ['FullName']),
  q('prin-042', 'filtering', 'easy', 'Show all ACTIVE permits with their permit numbers.', 'SELECT "PermitNo" FROM permits WHERE "Status" = \'ACTIVE\'', [], ['PermitNo']),
  q('prin-043', 'filtering', 'easy', 'Permit mana saja yang sudah EXPIRED?', 'SELECT "PermitNo", "ExpiryDate" FROM permits WHERE "Status" = \'EXPIRED\'', [], ['PermitNo', 'ExpiryDate']),
  q('prin-044', 'filtering', 'easy', 'Which permits expired before 1 January 2026?', 'SELECT "PermitNo", "ExpiryDate" FROM permits WHERE "ExpiryDate" < \'2026-01-01\'', [], ['PermitNo', 'ExpiryDate']),
  q('prin-045', 'filtering', 'medium', 'Peserta wanita siapa saja yang terdaftar di site Asam-Asam?', 'SELECT p."FullName" FROM participants p JOIN sites s ON p."SiteId" = s."Id" WHERE p."Gender" = \'F\' AND s."Name" ILIKE \'%asam%\'', [], ['FullName']),
  q('prin-046', 'filtering', 'medium', 'List participants hired by PT DARMA HENWA at Bengalon Site.', 'SELECT p."FullName" FROM participants p JOIN companies c ON p."CompanyId" = c."Id" JOIN sites s ON p."SiteId" = s."Id" WHERE c."Name" = \'PT DARMA HENWA\' AND s."Name" ILIKE \'%bengalon%\'', [], ['FullName']),
  q('prin-047', 'filtering', 'easy', 'Which MCU registrations are still PENDING?', 'SELECT "Status" FROM mcu_registrations WHERE "Status" = \'PENDING\'', [], ['Status']),
  q('prin-048', 'filtering', 'easy', 'Tampilkan peserta yang belum pernah MCU (LastMcuDate kosong).', 'SELECT "FullName" FROM participants WHERE "LastMcuDate" IS NULL', [], ['FullName']),
  q('prin-049', 'filtering', 'easy', 'Which participants have no company assigned?', 'SELECT "FullName" FROM participants WHERE "CompanyId" IS NULL', [], ['FullName']),
  q('prin-050', 'filtering', 'easy', 'Show tags that are still active (ActualReleaseDate is null).', 'SELECT "TagNo", "Reason" FROM tags WHERE "ActualReleaseDate" IS NULL', [], ['TagNo', 'Reason']),
  q('prin-051', 'filtering', 'easy', 'Tag mana saja yang sudah dilepas?', 'SELECT "TagNo" FROM tags WHERE "ActualReleaseDate" IS NOT NULL', [], ['TagNo']),
  q('prin-052', 'filtering', 'easy', 'Which induction batches have status COMPLETED?', 'SELECT "BatchNo" FROM induction_batches WHERE "Status" = \'COMPLETED\'', [], ['BatchNo']),
  q('prin-053', 'filtering', 'medium', 'Tampilkan peserta training yang lulus dengan skor di atas 80.', 'SELECT p."FullName", tp."Score" FROM training_participants tp JOIN participants p ON tp."ParticipantId" = p."Id" WHERE tp."Score" > 80', [], ['FullName', 'Score']),
  q('prin-054', 'filtering', 'easy', 'Which participants were born before 1980?', 'SELECT "FullName", "BirthDate" FROM participants WHERE "BirthDate" < \'1980-01-01\'', [], ['FullName', 'BirthDate']),
  q('prin-055', 'filtering', 'easy', 'Permit KIMPER ada berapa dan nomornya apa saja?', 'SELECT "PermitNo" FROM permits WHERE "PermitType" = \'KIMPER\'', ['2'], ['PermitNo']),
  q('prin-056', 'filtering', 'medium', 'Show SIMPER permits issued in 2025.', 'SELECT "PermitNo", "IssueDate" FROM permits WHERE "PermitType" = \'SIMPER\' AND "IssueDate" >= \'2025-01-01\' AND "IssueDate" < \'2026-01-01\'', [], ['PermitNo', 'IssueDate']),
  q('prin-057', 'filtering', 'medium', 'MCU registration bertipe NEW_HIRE yang dijadwalkan tahun 2026 apa saja?', 'SELECT "ScheduledDate" FROM mcu_registrations WHERE "McuType" = \'NEW_HIRE\' AND "ScheduledDate" >= \'2026-01-01\'', [], ['ScheduledDate']),
  q('prin-058', 'filtering', 'medium', 'Peserta vendor (bukan DH) siapa yang posisinya operator?', 'SELECT "FullName", "Position" FROM participants WHERE "ParticipantType" <> \'DH\' AND "Position" ILIKE \'%operator%\'', [], ['FullName', 'Position']),
  q('prin-059', 'filtering', 'easy', 'Which sites are marked inactive?', 'SELECT "Name" FROM sites WHERE "IsActive" = false', [], ['Name']),
  q('prin-060', 'filtering', 'easy', 'Company vendor mana yang tidak aktif?', 'SELECT "Name" FROM companies WHERE "IsActive" = false', [], ['Name']),
  q('prin-061', 'filtering', 'medium', 'Employee profiles yang punya JdeNo tapi tidak punya ProIntEmployeeId.', 'SELECT p."FullName" FROM employee_profiles e JOIN participants p ON e."ParticipantId" = p."Id" WHERE e."JdeNo" IS NOT NULL AND e."JdeNo" <> \'\' AND (e."ProIntEmployeeId" IS NULL OR e."ProIntEmployeeId" = \'\')', [], ['FullName']),
  q('prin-062', 'filtering', 'easy', 'Training batch yang MaxParticipants-nya di atas 20.', 'SELECT "BatchNo", "MaxParticipants" FROM training_batches WHERE "MaxParticipants" > 20', [], ['BatchNo', 'MaxParticipants']),
  q('prin-063', 'filtering', 'medium', 'Tampilkan tag yang Reason-nya mengandung kata "unsafe".', 'SELECT "TagNo", "Reason" FROM tags WHERE "Reason" ILIKE \'%unsafe%\'', [], ['TagNo', 'Reason']),
  q('prin-064', 'filtering', 'easy', 'Which permits have a renewal reason recorded?', 'SELECT "PermitNo", "RenewalReason" FROM permits WHERE "RenewalReason" IS NOT NULL', [], ['PermitNo', 'RenewalReason']),
  q('prin-065', 'filtering', 'medium', 'Peserta yang pindah company (punya history) — tampilkan namanya.', 'SELECT DISTINCT p."FullName" FROM participants p JOIN participant_company_histories h ON h."ParticipantId" = p."Id"', [], ['FullName']),
  q('prin-066', 'filtering', 'easy', 'Show soft-deleted permits count.', 'SELECT COUNT(*) AS total FROM permits WHERE "IsDeleted" = true', [], ['total']),
  q('prin-067', 'filtering', 'easy', 'Berapa peserta yang punya foto profil?', 'SELECT COUNT(*) AS total FROM participants WHERE "Photo" IS NOT NULL AND "Photo" <> \'\'', [], ['total']),
  q('prin-068', 'filtering', 'medium', 'MCU hasil FIT tahun 2026 — peserta siapa saja?', 'SELECT p."FullName", mr."ResultStatus" FROM mcu_results mr JOIN mcu_registrations r ON mr."McuRegistrationId" = r."Id" JOIN participants p ON r."ParticipantId" = p."Id" WHERE mr."ResultStatus" = \'FIT\' AND mr."ResultDate" >= \'2026-01-01\'', [], ['FullName', 'ResultStatus']),
  q('prin-069', 'filtering', 'easy', 'Department tanpa parent (root departments) apa saja?', 'SELECT "Name" FROM departments WHERE parent_id IS NULL ORDER BY "Name"', [], ['Name']),
  q('prin-070', 'filtering', 'medium', 'Sub-department dari department yang namanya mengandung HSE.', 'SELECT d1."Name" FROM departments d1 JOIN departments d0 ON d1.parent_id = d0."Id" WHERE d0."Name" ILIKE \'%hse%\'', [], ['Name']),
  q('prin-071', 'filtering', 'easy', 'Which training batches have notes filled?', 'SELECT "BatchNo", "Notes" FROM training_batches WHERE "Notes" IS NOT NULL AND "Notes" <> \'\'', [], ['BatchNo', 'Notes']),
  q('prin-072', 'filtering', 'medium', 'Peserta dengan email domain gmail.com — siapa saja?', 'SELECT "FullName", "Email" FROM participants WHERE "Email" ILIKE \'%@gmail.com\'', [], ['FullName', 'Email']),
  q('prin-073', 'filtering', 'medium', 'Induction batches dengan exam mode ONLINE.', 'SELECT "BatchNo" FROM induction_batches WHERE "ExamMode" = \'ONLINE\'', [], ['BatchNo']),
  q('prin-074', 'filtering', 'easy', 'Training participants yang belum hadir (AttendedAt null).', 'SELECT "Id" FROM training_participants WHERE "AttendedAt" IS NULL', [], ['Id']),
  q('prin-075', 'filtering', 'medium', 'Participants whose phone number starts with 08.', 'SELECT "FullName", "Phone" FROM participants WHERE "Phone" LIKE \'08%\'', [], ['FullName', 'Phone']),
  q('prin-076', 'filtering', 'medium', 'MCU registrations handled by which hospitals?', 'SELECT DISTINCT "HospitalName" FROM mcu_registrations WHERE "HospitalName" IS NOT NULL', [], ['HospitalName']),
  q('prin-077', 'filtering', 'easy', 'Berapa training participants yang sudah dapat sertifikat?', 'SELECT COUNT(*) AS total FROM training_participants WHERE "CertificateNo" IS NOT NULL', [], ['total']),
  q('prin-078', 'filtering', 'medium', 'Tag dengan ExpectedReleaseDate sudah lewat tapi belum release.', 'SELECT "TagNo" FROM tags WHERE "ExpectedReleaseDate" < NOW() AND "ActualReleaseDate" IS NULL', [], ['TagNo']),
  q('prin-079', 'filtering', 'easy', 'Which exam questions are active?', 'SELECT COUNT(*) AS total FROM exam_questions WHERE "IsActive" = true', [], ['total']),
  q('prin-080', 'filtering', 'easy', 'Audit logs hari ini ada berapa?', 'SELECT COUNT(*) AS total FROM audit_logs WHERE "CreatedAt" >= CURRENT_DATE', [], ['total']),
  q('prin-081', 'filtering', 'medium', 'Permits yang sudah pernah di-print (PrintedAt terisi).', 'SELECT "PermitNo" FROM permits WHERE "PrintedAt" IS NOT NULL', [], ['PermitNo']),
  q('prin-082', 'filtering', 'medium', 'Training participants dengan ExamStatus PASSED.', 'SELECT "Id" FROM training_participants WHERE "ExamStatus" = \'PASSED\'', [], ['Id']),
  q('prin-083', 'filtering', 'medium', 'Karyawan department yang tidak aktif — siapa saja?', 'SELECT p."FullName", d."Name" FROM employee_profiles e JOIN participants p ON e."ParticipantId" = p."Id" JOIN departments d ON e."DepartmentId" = d."Id" WHERE d."IsActive" = false', [], ['FullName', 'Name']),
  q('prin-084', 'filtering', 'medium', 'Sites dengan KTT signature terisi.', 'SELECT "Name" FROM sites WHERE "KttSignatureUrl" IS NOT NULL', [], ['Name']),
  q('prin-085', 'filtering', 'medium', 'Permit yang JdeSnapshot-nya terisi.', 'SELECT "PermitNo", "JdeSnapshot" FROM permits WHERE "JdeSnapshot" IS NOT NULL AND "JdeSnapshot" <> \'\'', [], ['PermitNo', 'JdeSnapshot']),
]
