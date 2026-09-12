/**
 * Seed a realistic bilingual knowledge base into the eval org via the real
 * ingestion path (chunkText + extractKeywords), so the eval measures the
 * production pipeline rather than hand-inserted rows.
 */
import { db } from '../src/lib/db'
import { chunkText, extractKeywords } from '../src/lib/rag'
import { bypassOrg, enterWithOrg } from '../src/lib/prisma-tenant'

const ORG = process.env.EVAL_ORG_ID!
const PREFIX = process.env.EVAL_DOC_PREFIX ?? 'KB'

const DOCS: Array<{ name: string; category: string; body: string }> = [
  {
    name: `${PREFIX} Employee Handbook 2024.pdf`,
    category: 'HR',
    body: `EMPLOYEE HANDBOOK 2024
SECTION 1 WORKING HOURS
Normal working hours are 40 hours per week, Monday through Friday, 09:00 to 17:00.
Employees must clock in and out using the attendance system.

SECTION 2 OVERTIME AND COMPENSATION
Overtime must be approved by the direct supervisor before it is performed.
The overtime rate on a working day is 1.5 times the hourly wage.
The overtime rate on a public holiday is 2.0 times the hourly wage.
Overtime is calculated from the official attendance record only.

SECTION 3 ANNUAL LEAVE
Employees are entitled to 12 working days of annual leave per year.
Annual leave must be requested at least 7 calendar days in advance.
Unused annual leave may be carried over up to a maximum of 5 days.

SECTION 4 REIMBURSEMENT
Reimbursement claims must be submitted within 30 days of the expense date.
Receipts are mandatory for any claim above 100,000 IDR.
The approval limit for a department head is 10,000,000 IDR per claim.`,
  },
  {
    name: `${PREFIX} Procurement Policy.pdf`,
    category: 'Procurement',
    body: `PROCUREMENT POLICY
SECTION 1 VENDOR REGISTRATION
All vendors must be registered on the approved supplier list before any purchase order.
Vendor registration requires a valid business licence and a tax identification number.

SECTION 2 THRESHOLDS
Direct purchase without tender is permitted up to 50,000,000 IDR.
Purchases between 50,000,000 IDR and 250,000,000 IDR require three comparable quotations.
Purchases above 250,000,000 IDR require a formal open tender.

SECTION 3 PAYMENT TERMS
Standard payment terms are 30 days from the invoice receipt date.
Early payment discounts are permitted where the discount exceeds the cost of capital.`,
  },
  {
    name: `${PREFIX} Data Security Standard.docx`,
    category: 'Security',
    body: `DATA SECURITY STANDARD
SECTION 1 CLASSIFICATION LEVELS
Data is classified as public, internal, confidential, or restricted.
Restricted data includes customer identity documents and payment credentials.

SECTION 2 ACCESS CONTROL
Access to confidential data requires written approval from the data owner.
Access to restricted data requires approval from the Chief Information Security Officer.
All access is reviewed every 90 days.

SECTION 3 INCIDENT REPORTING
A suspected data breach must be reported to the security team within 24 hours.
The security team must notify affected parties within 72 hours where required by law.`,
  },
  {
    name: `${PREFIX} Customer Refund SOP.pdf`,
    category: 'Support',
    body: `CUSTOMER REFUND STANDARD OPERATING PROCEDURE
SECTION 1 ELIGIBILITY
Customers may request a refund within 30 days of the purchase date.
Physical goods must be returned in original condition with the original invoice.
Digital licences are refundable only if they have not been activated.

SECTION 2 PROCESSING
Refunds are processed within 14 working days of the approved return.
Refunds are issued to the original payment method only.
Shipping costs are non-refundable unless the return is due to a supplier error.`,
  },
]

async function main() {
  await bypassOrg(async () => {
    enterWithOrg(ORG)
    let total = 0
    for (const d of DOCS) {
      const doc = await db.document.create({
        data: {
          organizationId: ORG, name: d.name, type: 'TEXT',
          sizeBytes: d.body.length, mimeType: 'text/plain', status: 'ready',
          isEnabled: true, contentText: d.body, category: d.category,
        },
        select: { id: true },
      })
      const chunks = chunkText(d.body)
      await db.documentChunk.createMany({
        data: chunks.map((c, i) => ({
          organizationId: ORG, documentId: doc.id, chunkIndex: i,
          content: c, keywords: extractKeywords(c, 8),
        })),
      })
      total += chunks.length
      console.log(`seeded ${d.name} -> ${chunks.length} chunks`)
    }
    console.log(`total chunks: ${total}`)
  })
  process.exit(0)
}

main().catch((e) => { console.error('SEED FAILED:', e); process.exit(1) })
