/**
 * PRINASA benchmark — part 5: robustness (typo + paraphrase), multi-hop,
 * and cross-source hybrid questions.
 *
 * The hybrid block is THE reason this benchmark exists: questions that need
 * BOTH the database integration and document knowledge in the same answer.
 * They carry groundTruthSql for the DB half plus expectedKeywords for the
 * knowledge half, and the hybrid runner scores routing behavior explicitly:
 *   - refused/clarified when it should have answered  → routing failure
 *   - answered from only one source                    → partial
 *   - endless "let me continue analyzing" loops        → loop failure (bug!)
 *
 * The user-facing symptom that motivated this: with knowledge + database
 * both configured, the chatbot entered clarification/analysis loops and
 * never answered. These questions pin that behavior.
 */
import type { BenchmarkQuestion, HybridBenchmarkQuestion } from '../types'

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

function h(
  id: string,
  difficulty: HybridBenchmarkQuestion['difficulty'],
  question: string,
  groundTruthSql: string,
  expectedDbTokens: string[],
  expectedKnowledgeKeywords: string[],
): HybridBenchmarkQuestion {
  return { id, category: 'cross_source_hybrid', difficulty, question, groundTruthSql, expectedAnswerContains: expectedDbTokens, expectedColumns: [], integrationId: 'int-prinasa-001', tags: ['hybrid'], expectedKnowledgeKeywords }
}

export const prinasaRobustnessQuestions: BenchmarkQuestion[] = [
  // ═════════ robustness_typo (20) ═════════
  q('prin-321', 'robustness_typo', 'medium', 'berapa jumlah peserta yang terdaftar dlm sistem?', 'SELECT COUNT(*) AS total FROM participants', ['5060'], ['total']),
  q('prin-322', 'robustness_typo', 'medium', 'How many permints are ACTIVE rite now?', 'SELECT COUNT(*) AS total FROM permits WHERE "Status" = \'ACTIVE\'', ['23'], ['total']),
  q('prin-323', 'robustness_typo', 'medium', 'list participents at Bengalon cite', 'SELECT p."FullName" FROM participants p JOIN sites s ON p."SiteId" = s."Id" WHERE s."Name" ILIKE \'%bengalon%\'', [], ['FullName']),
  q('prin-324', 'robustness_typo', 'medium', 'siapa saja yg punya permit kadaluarsa', 'SELECT p."FullName" FROM permits pm JOIN participants p ON pm."ParticipantId" = p."Id" WHERE pm."Status" = \'EXPIRED\'', [], ['FullName']),
  q('prin-325', 'robustness_typo', 'medium', 'mcu regisration count per stats', 'SELECT "Status", COUNT(*) AS total FROM mcu_registrations GROUP BY "Status"', [], ['Status', 'total']),
  q('prin-326', 'robustness_typo', 'medium', 'show companies with there participant counts', 'SELECT c."Name", COUNT(p."Id") AS total FROM companies c LEFT JOIN participants p ON p."CompanyId" = c."Id" GROUP BY c."Name"', [], ['Name', 'total']),
  q('prin-327', 'robustness_typo', 'medium', 'karyawan departmen production berapa orang', 'SELECT d."Name", COUNT(*) AS total FROM employee_profiles e JOIN departments d ON e."DepartmentId" = d."Id" WHERE d."Name" ILIKE \'%production%\' GROUP BY d."Name"', [], ['Name', 'total']),
  q('prin-328', 'robustness_typo', 'medium', 'training batch stat: how many complted vs ongoing', 'SELECT "Status", COUNT(*) AS total FROM training_batches GROUP BY "Status"', [], ['Status', 'total']),
  q('prin-329', 'robustness_typo', 'medium', 'which sites require MCU HE input daet?', 'SELECT "Name" FROM sites WHERE "RequireMcuHeInputDate" = true', [], ['Name']),
  q('prin-330', 'robustness_typo', 'medium', 'permits that will expiere next month', 'SELECT "PermitNo", "ExpiryDate" FROM permits WHERE "ExpiryDate" BETWEEN NOW() AND NOW() + interval \'1 month\'', [], ['PermitNo', 'ExpiryDate']),
  q('prin-331', 'robustness_typo', 'medium', 'berapa tag yang masih aktif (belum dilepas)', 'SELECT COUNT(*) AS total FROM tags WHERE "ActualReleaseDate" IS NULL', [], ['total']),
  q('prin-332', 'robustness_typo', 'medium', 'induktion batch di site Asam-Asam ada berapa', 'SELECT COUNT(*) AS total FROM induction_batches b JOIN sites s ON b."SiteId" = s."Id" WHERE s."Name" ILIKE \'%asam%\'', [], ['total']),
  q('prin-333', 'robustness_typo', 'medium', 'trainers list and how many batches they tought', 'SELECT tr."Name", COUNT(b."Id") AS batches FROM trainers tr LEFT JOIN training_batches b ON b."TrainerId" = tr."Id" GROUP BY tr."Name"', [], ['Name', 'batches']),
  q('prin-334', 'robustness_typo', 'medium', 'peserta tanpa nik berapa banyak', 'SELECT COUNT(*) AS total FROM participants WHERE "Nik" IS NULL OR "Nik" = \'\'', [], ['total']),
  q('prin-335', 'robustness_typo', 'medium', 'equipments models by brnad top 5', 'SELECT "Brand", COUNT(*) AS total FROM equipment_models GROUP BY "Brand" ORDER BY total DESC LIMIT 5', [], ['Brand', 'total']),
  q('prin-336', 'robustness_typo', 'medium', 'klinik mana yang menangani MCU terbanyak', 'SELECT cl."Name", COUNT(r."Id") AS total FROM clinics cl LEFT JOIN mcu_registrations r ON r."ClinicId" = cl."Id" GROUP BY cl."Name" ORDER BY total DESC LIMIT 1', [], ['Name', 'total']),
  q('prin-337', 'robustness_typo', 'medium', 'how many SUBCON partisipan at Kintap site?', 'SELECT COUNT(*) AS total FROM participants p JOIN sites s ON p."SiteId" = s."Id" WHERE p."ParticipantType" = \'SUBCON\' AND s."Name" ILIKE \'%kintap%\'', [], ['total']),
  q('prin-338', 'robustness_typo', 'medium', 'latest MCU resutls today', 'SELECT "ResultStatus", "ResultDate" FROM mcu_results WHERE "ResultDate" >= CURRENT_DATE', [], ['ResultStatus']),
  q('prin-339', 'robustness_typo', 'medium', 'siapa trainer untuk batch training HI?', 'SELECT tr."Name" FROM training_batches b JOIN training_types tt ON b."TrainingTypeId" = tt."Id" LEFT JOIN trainers tr ON b."TrainerId" = tr."Id" WHERE tt."Name" = \'HI\'', [], ['Name']),
  q('prin-340', 'robustness_typo', 'medium', 'compnies with zero participants', 'SELECT c."Name" FROM companies c WHERE NOT EXISTS (SELECT 1 FROM participants p WHERE p."CompanyId" = c."Id")', [], ['Name']),

  // ═════════ robustness_paraphrase (20) ═════════
  q('prin-341', 'robustness_paraphrase', 'medium', 'Sebanyak apa total orang yang tercatat dalam database peserta?', 'SELECT COUNT(*) AS total FROM participants', ['5060'], ['total']),
  q('prin-342', 'robustness_paraphrase', 'medium', 'Give me the number of medical check-ups that have been registered so far.', 'SELECT COUNT(*) AS total FROM mcu_registrations', ['28'], ['total']),
  q('prin-343', 'robustness_paraphrase', 'medium', 'Saya ingin tahu izin kerja yang masih berlaku ada berapa.', 'SELECT COUNT(*) AS total FROM permits WHERE "Status" = \'ACTIVE\'', ['23'], ['total']),
  q('prin-344', 'robustness_paraphrase', 'medium', 'Which locations do we operate in?', 'SELECT "Name" FROM sites ORDER BY "Name"', [], ['Name']),
  q('prin-345', 'robustness_paraphrase', 'medium', 'Informasi jumlah vendor atau kontraktor yang bekerja sama.', 'SELECT COUNT(*) AS total FROM participants WHERE "ParticipantType" = \'SUBCON\'', ['20'], ['total']),
  q('prin-346', 'robustness_paraphrase', 'medium', 'How many people passed their safety induction?', 'SELECT COUNT(*) AS total FROM induction_participants WHERE "Status" = \'COMPLETED\'', [], ['total']),
  q('prin-347', 'robustness_paraphrase', 'medium', 'Berapa orang sudah selesai medical check-up dengan hasil FIT?', 'SELECT COUNT(*) AS total FROM mcu_results WHERE "ResultStatus" = \'FIT\'', [], ['total']),
  q('prin-348', 'robustness_paraphrase', 'medium', 'Show me the breakdown of our workforce by employment type.', 'SELECT "ParticipantType", COUNT(*) AS total FROM participants GROUP BY "ParticipantType"', ['DH', 'SUBCON'], ['ParticipantType', 'total']),
  q('prin-349', 'robustness_paraphrase', 'medium', 'Siapa saja yang sertifikat trainingnya masih berlaku tahun ini?', 'SELECT p."FullName" FROM training_participants tp JOIN participants p ON tp."ParticipantId" = p."Id" WHERE tp."CertificateExpiryDate" >= CURRENT_DATE', [], ['FullName']),
  q('prin-350', 'robustness_paraphrase', 'medium', 'What is the count of work permits about to lapse within sixty days?', 'SELECT COUNT(*) AS total FROM permits WHERE "ExpiryDate" BETWEEN NOW() AND NOW() + interval \'60 days\' AND "Status" = \'ACTIVE\'', [], ['total']),
  q('prin-351', 'robustness_paraphrase', 'medium', 'Sebutkan divisi-divisi yang ada di perusahaan.', 'SELECT "Name" FROM departments WHERE parent_id IS NULL ORDER BY "Name"', [], ['Name']),
  q('prin-352', 'robustness_paraphrase', 'medium', 'Which medical facilities do we partner with?', 'SELECT "Name" FROM clinics ORDER BY "Name"', [], ['Name']),
  q('prin-353', 'robustness_paraphrase', 'medium', 'Peserta yang akan menjalani MCU terdekat — siapa saja?', 'SELECT "FullName", "NextMcuDate" FROM participants WHERE "NextMcuDate" > NOW() ORDER BY "NextMcuDate" ASC LIMIT 10', [], ['FullName', 'NextMcuDate']),
  q('prin-354', 'robustness_paraphrase', 'medium', 'How many staff members do we have in each work location?', 'SELECT s."Name" AS site, COUNT(p."Id") AS total FROM sites s LEFT JOIN participants p ON p."SiteId" = s."Id" GROUP BY s."Name"', [], ['site', 'total']),
  q('prin-355', 'robustness_paraphrase', 'medium', 'Alamat dan kontak vendor PT DARMA HENWA apa?', 'SELECT "Name", "Address", "Phone" FROM companies WHERE "Name" = \'PT DARMA HENWA\'', ['PT DARMA HENWA'], ['Name', 'Address']),
  q('prin-356', 'robustness_paraphrase', 'medium', 'Give me everyone who failed at least one training attempt.', 'SELECT DISTINCT p."FullName" FROM training_participants tp JOIN participants p ON tp."ParticipantId" = p."Id" WHERE tp."Status" = \'FAILED\'', [], ['FullName']),
  q('prin-357', 'robustness_paraphrase', 'medium', 'Kapan terakhir kali ada penerbitan izin kerja?', 'SELECT "IssueDate" FROM permits ORDER BY "IssueDate" DESC LIMIT 1', [], ['IssueDate']),
  q('prin-358', 'robustness_paraphrase', 'medium', 'What equipment brands do we certify people on?', 'SELECT DISTINCT "Brand" FROM equipment_models ORDER BY "Brand" LIMIT 15', [], ['Brand']),
  q('prin-359', 'robustness_paraphrase', 'medium', 'Ada berapa peserta yang sedang dalam status non-aktif?', 'SELECT "Status", COUNT(*) AS total FROM participants GROUP BY "Status"', [], ['Status', 'total']),
  q('prin-360', 'robustness_paraphrase', 'medium', 'Who are the safety tag violators currently restricted from work?', 'SELECT p."FullName", t."Reason" FROM tags t JOIN participants p ON t."ParticipantId" = p."Id" WHERE t."ActualReleaseDate" IS NULL', [], ['FullName', 'Reason']),

  // ═════════ multi_hop (25) ═════════
  q('prin-361', 'multi_hop', 'hard', 'Site mana yang KTT-nya juga jadi trainer? (nama orang sama)', 'SELECT s."MiningTechnicalHeadName" FROM sites s WHERE s."MiningTechnicalHeadName" IN (SELECT "Name" FROM trainers)', [], ['MiningTechnicalHeadName']),
  q('prin-362', 'multi_hop', 'hard', 'Di site dengan tag terbanyak, siapa pemegang permit aktif?', 'SELECT p."FullName", pm."PermitNo", pm."ExpiryDate" FROM permits pm JOIN participants p ON pm."ParticipantId" = p."Id" WHERE p."SiteId" = (SELECT "SiteId" FROM tags GROUP BY "SiteId" ORDER BY COUNT(*) DESC LIMIT 1) AND pm."Status" = \'ACTIVE\'', [], ['FullName', 'ExpiryDate']),
  q('prin-363', 'multi_hop', 'hard', 'Company dengan karyawan paling banyak ikut training — training apa saja yang diikuti?', 'SELECT tt."Name" AS training, COUNT(*) AS pax FROM training_participants tp JOIN participants p ON tp."ParticipantId" = p."Id" JOIN training_batches b ON tp."TrainingBatchId" = b."Id" JOIN training_types tt ON b."TrainingTypeId" = tt."Id" WHERE p."CompanyId" = (SELECT p2."CompanyId" FROM training_participants tp2 JOIN participants p2 ON tp2."ParticipantId" = p2."Id" WHERE p2."CompanyId" IS NOT NULL GROUP BY p2."CompanyId" ORDER BY COUNT(*) DESC LIMIT 1) GROUP BY tt."Name"', [], ['training', 'pax']),
  q('prin-364', 'multi_hop', 'hard', 'Department head count vs its parent department head count.', 'SELECT d1."Name" AS child, d0."Name" AS parent, (SELECT COUNT(*) FROM employee_profiles e WHERE e."DepartmentId" = d1."Id") AS child_count, (SELECT COUNT(*) FROM employee_profiles e WHERE e."DepartmentId" = d0."Id") AS parent_count FROM departments d1 JOIN departments d0 ON d1.parent_id = d0."Id" ORDER BY child_count DESC LIMIT 10', [], ['child', 'parent', 'child_count']),
  q('prin-365', 'multi_hop', 'hard', 'Which trainer trained the person holding the newest permit?', 'SELECT tr."Name" AS trainer, p."FullName" FROM training_participants tp JOIN training_batches b ON tp."TrainingBatchId" = b."Id" JOIN trainers tr ON b."TrainerId" = tr."Id" JOIN participants p ON tp."ParticipantId" = p."Id" WHERE p."Id" = (SELECT "ParticipantId" FROM permits ORDER BY "IssueDate" DESC LIMIT 1)', [], ['trainer', 'FullName']),
  q('prin-366', 'multi_hop', 'hard', 'Di site dengan MCU FIT rate tertinggi, siapa yang TIDAK punya permit aktif?', 'SELECT p."FullName" FROM participants p WHERE p."SiteId" = (SELECT p2."SiteId" FROM mcu_results mr JOIN mcu_registrations r ON mr."McuRegistrationId" = r."Id" JOIN participants p2 ON r."ParticipantId" = p2."Id" WHERE p2."SiteId" IS NOT NULL GROUP BY p2."SiteId" ORDER BY ROUND(100.0 * SUM(CASE WHEN mr."ResultStatus" = \'FIT\' THEN 1 ELSE 0 END) / COUNT(*), 1) DESC LIMIT 1) AND NOT EXISTS (SELECT 1 FROM permits pm WHERE pm."ParticipantId" = p."Id" AND pm."Status" = \'ACTIVE\') LIMIT 10', [], ['FullName']),
  q('prin-367', 'multi_hop', 'hard', 'Equipment yang dipakai batch training dari trainer yang paling sibuk.', 'SELECT em."Name" FROM training_batch_equipments tbe JOIN equipment_models em ON tbe."EquipmentModelId" = em."Id" WHERE tbe."TrainingBatchId" IN (SELECT b."Id" FROM training_batches b WHERE b."TrainerId" = (SELECT "TrainerId" FROM training_batches WHERE "TrainerId" IS NOT NULL GROUP BY "TrainerId" ORDER BY COUNT(*) DESC LIMIT 1))', [], ['Name']),
  q('prin-368', 'multi_hop', 'hard', 'Orang yang tag-nya paling lama — department dia apa?', 'SELECT p."FullName", COALESCE(d."Name", \'no-dept\') AS dept, EXTRACT(DAY FROM (NOW() - t."AppliedDate")) AS days FROM tags t JOIN participants p ON t."ParticipantId" = p."Id" LEFT JOIN employee_profiles e ON e."ParticipantId" = p."Id" LEFT JOIN departments d ON e."DepartmentId" = d."Id" WHERE t."ActualReleaseDate" IS NULL ORDER BY t."AppliedDate" ASC LIMIT 1', [], ['FullName', 'dept', 'days']),
  q('prin-369', 'multi_hop', 'hard', 'The newest participant — do they already have a permit and MCU?', 'SELECT p."FullName", CASE WHEN pm."Id" IS NOT NULL THEN \'yes\' ELSE \'no\' END AS has_permit, CASE WHEN r."Id" IS NOT NULL THEN \'yes\' ELSE \'no\' END AS has_mcu FROM participants p LEFT JOIN permits pm ON pm."ParticipantId" = p."Id" LEFT JOIN mcu_registrations r ON r."ParticipantId" = p."Id" WHERE p."Id" = (SELECT "Id" FROM participants ORDER BY "CreatedAt" DESC LIMIT 1)', [], ['FullName', 'has_permit', 'has_mcu']),
  q('prin-370', 'multi_hop', 'hard', 'Participant scoring above overall average — which company are they from?', 'SELECT p."FullName", c."Name" AS company, tp."Score" FROM training_participants tp JOIN participants p ON tp."ParticipantId" = p."Id" LEFT JOIN companies c ON p."CompanyId" = c."Id" WHERE tp."Score" > (SELECT AVG("Score") FROM training_participants)', [], ['FullName', 'company', 'Score']),
  q('prin-371', 'multi_hop', 'hard', 'Clinic paling sibuk — kategori MCU apa yang paling sering ditangani?', 'SELECT mc."Name" AS category, COUNT(*) AS total FROM mcu_registrations r JOIN mcu_categories mc ON r."McuCategoryId" = mc."Id" WHERE r."ClinicId" = (SELECT "ClinicId" FROM mcu_registrations WHERE "ClinicId" IS NOT NULL GROUP BY "ClinicId" ORDER BY COUNT(*) DESC LIMIT 1) GROUP BY mc."Name"', [], ['category', 'total']),
  q('prin-372', 'multi_hop', 'hard', 'Employees of the biggest department — which sites do they work at?', 'SELECT s."Name" AS site, COUNT(*) AS total FROM employee_profiles e JOIN participants p ON e."ParticipantId" = p."Id" LEFT JOIN sites s ON p."SiteId" = s."Id" WHERE e."DepartmentId" = (SELECT "DepartmentId" FROM employee_profiles WHERE "DepartmentId" IS NOT NULL GROUP BY "DepartmentId" ORDER BY COUNT(*) DESC LIMIT 1) GROUP BY s."Name"', [], ['site', 'total']),
  q('prin-373', 'multi_hop', 'hard', 'Which batch has the highest average score, and who is its trainer?', 'SELECT b."BatchNo", tr."Name" AS trainer, ROUND(AVG(tp."Score"), 1) AS avg_score FROM training_participants tp JOIN training_batches b ON tp."TrainingBatchId" = b."Id" LEFT JOIN trainers tr ON b."TrainerId" = tr."Id" WHERE tp."Score" IS NOT NULL GROUP BY b."Id", b."BatchNo", tr."Name" ORDER BY avg_score DESC LIMIT 1', [], ['BatchNo', 'trainer', 'avg_score']),
  q('prin-374', 'multi_hop', 'hard', 'Oldest ACTIVE permit holder — which site and what position?', 'SELECT p."FullName", s."Name" AS site, p."Position", pm."IssueDate" FROM permits pm JOIN participants p ON pm."ParticipantId" = p."Id" LEFT JOIN sites s ON p."SiteId" = s."Id" WHERE pm."Status" = \'ACTIVE\' ORDER BY pm."IssueDate" ASC LIMIT 1', [], ['FullName', 'site', 'IssueDate']),
  q('prin-375', 'multi_hop', 'hard', 'The most common position among SUBCON — which company hires them?', 'SELECT p."Position", c."Name" AS company, COUNT(*) AS total FROM participants p LEFT JOIN companies c ON p."CompanyId" = c."Id" WHERE p."ParticipantType" = \'SUBCON\' GROUP BY p."Position", c."Name" ORDER BY total DESC LIMIT 1', [], ['Position', 'company', 'total']),
  q('prin-376', 'multi_hop', 'hard', '2 hop: company with most expired permits → which sites are those workers at?', 'SELECT s."Name" AS site, COUNT(*) AS total FROM permits pm JOIN participants p ON pm."ParticipantId" = p."Id" LEFT JOIN sites s ON p."SiteId" = s."Id" WHERE pm."Status" = \'EXPIRED\' AND p."CompanyId" = (SELECT p2."CompanyId" FROM permits pm2 JOIN participants p2 ON pm2."ParticipantId" = p2."Id" WHERE pm2."Status" = \'EXPIRED\' AND p2."CompanyId" IS NOT NULL GROUP BY p2."CompanyId" ORDER BY COUNT(*) DESC LIMIT 1) GROUP BY s."Name"', [], ['site', 'total']),
  q('prin-377', 'multi_hop', 'hard', 'Equipment model with most permit certifications.', 'SELECT em."Name" FROM equipment_models em WHERE em."Id" IN (SELECT "EquipmentModelId" FROM permit_equipments WHERE "EquipmentModelId" IS NOT NULL GROUP BY "EquipmentModelId" ORDER BY COUNT(*) DESC LIMIT 1)', [], ['Name']),
  q('prin-378', 'multi_hop', 'hard', 'Trainer yang mengajar batch dengan exam — berapa persen lulus examnya?', 'SELECT tr."Name" AS trainer, ROUND(100.0 * SUM(CASE WHEN tp."ExamStatus" = \'PASSED\' THEN 1 ELSE 0 END) / NULLIF(SUM(CASE WHEN tp."ExamStatus" IS NOT NULL THEN 1 ELSE 0 END), 0), 1) AS exam_pass_pct FROM training_batches b JOIN trainers tr ON b."TrainerId" = tr."Id" JOIN training_participants tp ON tp."TrainingBatchId" = b."Id" GROUP BY tr."Name"', [], ['trainer', 'exam_pass_pct']),
  q('prin-379', 'multi_hop', 'hard', 'Which site has the most participants without NIK — and how many?', 'SELECT s."Name" AS site, COUNT(*) AS no_nik FROM participants p JOIN sites s ON p."SiteId" = s."Id" WHERE p."Nik" IS NULL OR p."Nik" = \'\' GROUP BY s."Name" ORDER BY no_nik DESC LIMIT 1', [], ['site', 'no_nik']),
  q('prin-380', 'multi_hop', 'hard', 'Induction type with most batches — what is its average completion rate?', 'SELECT t."Name" AS type, COUNT(b."Id") AS batches, ROUND(100.0 * SUM(CASE WHEN ip."Status" = \'COMPLETED\' THEN 1 ELSE 0 END) / NULLIF(COUNT(ip."Id"), 0), 1) AS completion_pct FROM induction_batches b JOIN induction_types t ON b."InductionTypeId" = t."Id" LEFT JOIN induction_participants ip ON ip."InductionBatchId" = b."Id" GROUP BY t."Name" ORDER BY batches DESC', [], ['type', 'batches', 'completion_pct']),
  q('prin-381', 'multi_hop', 'hard', 'Kategori MCU terbanyak — siapa saja pesertanya dari company terbesar?', 'SELECT p."FullName" FROM mcu_registrations r JOIN participants p ON r."ParticipantId" = p."Id" WHERE r."McuCategoryId" = (SELECT "McuCategoryId" FROM mcu_registrations GROUP BY "McuCategoryId" ORDER BY COUNT(*) DESC LIMIT 1) AND p."CompanyId" = (SELECT "CompanyId" FROM participants WHERE "CompanyId" IS NOT NULL GROUP BY "CompanyId" ORDER BY COUNT(*) DESC LIMIT 1) LIMIT 10', [], ['FullName']),
  q('prin-382', 'multi_hop', 'hard', 'Participant with most trainings — their latest certificate expiry?', 'SELECT p."FullName", tp."CertificateNo", tp."CertificateExpiryDate" FROM training_participants tp JOIN participants p ON tp."ParticipantId" = p."Id" WHERE p."Id" = (SELECT "ParticipantId" FROM training_participants GROUP BY "ParticipantId" ORDER BY COUNT(*) DESC LIMIT 1) ORDER BY tp."CertificateIssuedAt" DESC LIMIT 1', [], ['FullName', 'CertificateExpiryDate']),
  q('prin-383', 'multi_hop', 'hard', 'Sites requiring HE input — do their participants have HE input dates in results?', 'SELECT s."Name" AS site, COUNT(*) AS he_entries FROM sites s JOIN participants p ON p."SiteId" = s."Id" JOIN mcu_registrations r ON r."ParticipantId" = p."Id" JOIN mcu_results mr ON mr."McuRegistrationId" = r."Id" WHERE s."RequireMcuHeInputDate" = true AND mr."HeInputDate" IS NOT NULL GROUP BY s."Name"', [], ['site', 'he_entries']),
  q('prin-384', 'multi_hop', 'hard', 'Batch dengan lokasi unik (Location terisi) — trainernya siapa dan berapa pax?', 'SELECT b."BatchNo", b."Location", tr."Name" AS trainer, COUNT(tp."Id") AS pax FROM training_batches b LEFT JOIN trainers tr ON b."TrainerId" = tr."Id" LEFT JOIN training_participants tp ON tp."TrainingBatchId" = b."Id" WHERE b."Location" IS NOT NULL AND b."Location" <> \'\' GROUP BY b."Id", b."BatchNo", b."Location", tr."Name"', [], ['BatchNo', 'pax']),
  q('prin-385', 'multi_hop', 'hard', 'Person with the newest permit — what is their training history?', 'SELECT tt."Name" AS training, tp."Score" FROM training_participants tp JOIN training_batches b ON tp."TrainingBatchId" = b."Id" JOIN training_types tt ON b."TrainingTypeId" = tt."Id" WHERE tp."ParticipantId" = (SELECT "ParticipantId" FROM permits ORDER BY "IssueDate" DESC LIMIT 1)', [], ['training', 'Score']),
]

/**
 * Cross-source hybrid questions — the flagship block. Requires BOTH the
 * PRINASA database AND document knowledge to answer fully.
 */
export const prinasaHybridQuestions: HybridBenchmarkQuestion[] = [
  h('prinh-001', 'hard', 'Menurut dokumen kebijakan K3, siapa saja karyawan yang saat ini tidak memenuhi syarat MCU?', 'SELECT p."FullName", p."NextMcuDate" FROM participants p WHERE p."NextMcuDate" < NOW()', [], ['policy', 'MCU']),
  h('prinh-002', 'hard', 'Bagaimana aturan masa berlaku SIMPER di dokumen, dan berapa SIMPER kita yang sudah expired?', 'SELECT COUNT(*) AS total FROM permits WHERE "PermitType" = \'SIMPER\' AND "Status" = \'EXPIRED\'', ['expired'], ['SIMPER', 'berlaku']),
  h('prinh-003', 'hard', 'What does the safety documentation say about tag release procedures, and how many tags are currently unreleased?', 'SELECT COUNT(*) AS total FROM tags WHERE "ActualReleaseDate" IS NULL', [], ['tag', 'release']),
  h('prinh-004', 'hard', 'Menurut SOP, kapan MCU berkala harus dilakukan — dan siapa saja yang overdue?', 'SELECT "FullName", "NextMcuDate" FROM participants WHERE "NextMcuDate" < NOW()', [], ['SOP', 'MCU']),
  h('prinh-005', 'hard', 'Jelaskan prosedur induction wajib dari dokumen, lalu tunjukkan siapa yang belum pernah ikut induction.', 'SELECT p."FullName" FROM participants p WHERE p."Id" NOT IN (SELECT "ParticipantId" FROM induction_participants WHERE "ParticipantId" IS NOT NULL) LIMIT 15', [], ['induction']),
  h('prinh-006', 'hard', 'Apa syarat training ulang menurut dokumen, dan berapa sertifikat training yang expired tahun ini?', 'SELECT COUNT(*) AS total FROM training_participants WHERE "CertificateExpiryDate" < NOW()', [], ['training', 'ulang']),
  h('prinh-007', 'hard', 'How does the permit renewal policy in the documents compare with our actual renewal backlog?', 'SELECT COUNT(*) AS total FROM permits WHERE "Status" = \'EXPIRED\'', ['9'], ['renewal', 'permit']),
  h('prinh-008', 'hard', 'Sebutkan tipe-tipe permit yang diatur dalam dokumen dan jumlah masing-masing di database.', 'SELECT "PermitType", COUNT(*) AS total FROM permits GROUP BY "PermitType"', ['MINE_PERMIT', 'SIMPER', 'KIMPER'], ['permit']),
  h('prinh-009', 'hard', 'Apa kategori peserta MCU yang diwajibkan dokumen, dan berapa registrasi per McuType saat ini?', 'SELECT "McuType", COUNT(*) AS total FROM mcu_registrations GROUP BY "McuType"', [], ['MCU', 'kategori']),
  h('prinh-010', 'hard', 'Menurut dokumen K3, equipment apa yang butuh sertifikasi — dan berapa equipment model yang terdaftar?', 'SELECT COUNT(*) AS total FROM equipment_models', ['850'], ['equipment', 'sertifikasi']),
  h('prinh-011', 'hard', 'What is the document-specified validity period for work permits vs the oldest active permit we hold?', 'SELECT "PermitNo", "IssueDate", "ExpiryDate" FROM permits WHERE "Status" = \'ACTIVE\' ORDER BY "IssueDate" ASC LIMIT 5', [], ['validity', 'permit']),
  h('prinh-012', 'hard', 'Jelaskan aturan company transfer di dokumen dan siapa saja yang baru pindah company.', 'SELECT p."FullName", oc."Name" AS from_c, nc."Name" AS to_c FROM participant_company_histories h JOIN participants p ON h."ParticipantId" = p."Id" LEFT JOIN companies oc ON h."OldCompanyId" = oc."Id" LEFT JOIN companies nc ON h."NewCompanyId" = nc."Id"', [], ['transfer']),
  h('prinh-013', 'hard', 'Apa saja site yang wajib KTT menurut dokumen, dan siapa KTT tiap site di database?', 'SELECT "Name", "MiningTechnicalHeadName" FROM sites', [], ['KTT', 'site']),
  h('prinh-014', 'hard', 'How many vendor companies do we have, and what vendor qualification requirements does the documentation specify?', 'SELECT COUNT(*) AS total FROM companies', ['13'], ['vendor', 'qualification']),
  h('prinh-015', 'hard', 'Sebutkan alur approval permit dari dokumen dan siapa yang paling banyak menerbitkan permit.', 'SELECT "CreatedBy", COUNT(*) AS total FROM permits GROUP BY "CreatedBy" ORDER BY total DESC LIMIT 3', [], ['approval', 'permit']),
  h('prinh-016', 'hard', 'Apa itu tag type 1 dan 2 menurut dokumen, dan bagaimana distribusinya di database?', 'SELECT "TagType", COUNT(*) AS total FROM tags GROUP BY "TagType"', [], ['tag']),
  h('prinh-017', 'hard', 'Dokumen menyebut batas peserta per training batch — adakah batch yang melebihi batas?', 'SELECT b."BatchNo", b."MaxParticipants", COUNT(tp."Id") AS enrolled FROM training_batches b JOIN training_participants tp ON tp."TrainingBatchId" = b."Id" GROUP BY b."Id", b."BatchNo", b."MaxParticipants" HAVING COUNT(tp."Id") > b."MaxParticipants"', [], ['batch', 'peserta']),
  h('prinh-018', 'hard', 'Apa kriteria peserta FIT vs UNFIT di dokumen, dan berapa hasil UNFIT yang ada sekarang?', 'SELECT COUNT(*) AS total FROM mcu_results WHERE "ResultStatus" <> \'FIT\'', [], ['FIT', 'UNFIT']),
  h('prinh-019', 'hard', 'Menurut dokumen berapa lama induction berlaku, dan berapa peserta induction yang statusnya COMPLETED?', 'SELECT COUNT(*) AS total FROM induction_participants WHERE "Status" = \'COMPLETED\'', [], ['induction', 'berlaku']),
  h('prinh-020', 'hard', 'What emergency procedures does the documentation define, and which sites have emergency phones filled in?', 'SELECT "Name", "EmergencyPhone" FROM sites WHERE "EmergencyPhone" IS NOT NULL', [], ['emergency']),
]
