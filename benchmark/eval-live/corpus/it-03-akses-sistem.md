# PT ARUNIKA LOGISTIK NUSANTARA
## INTERNAL STANDARD OPERATING PROCEDURE

| Document Attribute | Specification |
| :--- | :--- |
| **Document Code** | ARN-IT-STD-2026-004 |
| **Version** | 2.4 |
| **Effective Date** | February 1, 2026 |
| **Owning Department** | Information Technology & Cybersecurity (IT-SEC) |
| **Approved By** | Hendra Gunawan (CTO), Ratna Wijayakusuma (CEO) |

---

### 1. Purpose and Scope
This standard establishes mandatory controls for provisioning, managing, reviewing, and revoking user access across enterprise systems operated by PT Arunika Logistik Nusantara ("Arunika"). This policy protects data integrity and logistics operations across the corporate head office at Jl. Rungkut Industri III No. 18, Surabaya, and all 5 regional distribution centers:
- SBY-01 (Surabaya, 18,000 m²)
- JKT-02 (Jakarta Cikarang, 24,500 m²)
- MDN-03 (Medan, 9,200 m²)
- MKS-04 (Makassar, 7,800 m²)
- BPN-05 (Balikpapan, 6,100 m²)

This policy applies to all 1,240 employees, contract workers, and third-party technology vendors.

---

### 2. Role-Based Access Control (RBAC) Framework
Access to Arunika core operational systems must strictly align with the user's primary functional role based on least-privilege principles.

| System Name | System Role Identifier | Permitted Operational Functions | Designated Approver |
| :--- | :--- | :--- | :--- |
| **Gudangku v4** (WMS) | `WMS-WH-OPS` | Inbound putaway, picking, barcode scanning across 3 shifts | Warehouse Operations Manager |
| **Gudangku v4** (WMS) | `WMS-SUPERVISOR` | Inventory adjustments up to IDR 50,000,000, bin relocations | Facility Head (SBY/JKT/MDN/MKS/BPN) |
| **RuteKu** (TMS) | `TMS-DISPATCHER` | Manifest generation, assigning 312 trucks and 58 vans | Transport Operations Manager |
| **RuteKu** (TMS) | `TMS-FLEET-ADMIN` | Fleet records, driver onboarding, GPS geofence routing | COO (Yusuf Halim) |
| **SAP Business One** | `ERP-FIN-CLERK` | AP/AR entry, transport billing, vendor reconciliation | CFO (Dimas Prasetyo) |
| **SAP Business One** | `ERP-LOG-ANALYST` | Multi-facility inventory ledger queries, stock audits | Supply Chain Controller |

---

### 3. Access Request Workflow via Jira Service Management
1. **Submission**: All access requests must be initiated through Jira Service Management under the `ACCESS-REQ` queue. Self-requests without line-manager delegation will be automatically rejected.
2. **Approval Hierarchy**:
   - The direct reporting manager must validate business necessity within 24 business hours.
   - For modules in SAP Business One or administrative roles in Gudangku v4, explicit digital sign-off from CFO Dimas Prasetyo or CTO Hendra Gunawan is mandatory.
3. **Fulfillment SLA**: IT Infrastructure fulfills approved Jira requests within 8 working hours (business schedule: Monday–Friday, 08:00–17:00 WIB).

---

### 4. Credential Integrity and Shared Account Prohibition
- Individual accountability is absolute. The creation, sharing, or group usage of generic or shared accounts is strictly forbidden.
- Shift workers across the three warehouse shifts (Shift 1: 06:00–14:00, Shift 2: 14:00–22:00, Shift 3: 22:00–06:00 WIB) must log out completely at shift changeovers. Shared handheld terminals must require individual re-authentication.
- Any employee found sharing credentials will face immediate disciplinary action under Arunika Employment Code Article 14, carrying a minimum penalty surcharge of IDR 2,500,000 to cover internal audit remediations.

---

### 5. Privileged Account Management (PAM)
1. **Separation of Accounts**: System engineers, database administrators, and IT managers must use a separate privileged account with an `adm-` prefix (e.g., `adm-hgunawan`) strictly for administrative duties. Day-to-day corporate communication must use standard credentials.
2. **Multi-Factor Authentication (MFA)**: MFA via time-based one-time password (TOTP) is mandatory on all privileged access points to Gudangku v4 servers, RuteKu application clusters, and SAP Business One databases.
3. **Emergency "Break-Glass" Logins**: Emergency administrative credentials for SAP Business One and server hypervisors must be secured inside an encrypted electronic vault. Access generates an automatic critical alert to CTO Hendra Gunawan and triggers a mandatory Jira audit record.

---

### 6. Third-Party and Vendor Access Governance
1. Hardware vendors, software consultants, and system integration contractors supporting Gudangku v4 or RuteKu must be sponsored by an Arunika Department Head.
2. **Maximum Expiry (30 Days)**: All external vendor accounts must be configured with a hard system expiration date capped at exactly 30 calendar days from provisioning.
3. **Re-authorization**: Extensions require a renewed Jira Service Management ticket approved by CTO Hendra Gunawan 5 business days prior to expiry.
4. Unmonitored remote access without an active corporate sponsor session is permanently prohibited.

---

### 7. Offboarding and Access Revocation Protocol
1. **HR Notification**: The Human Resources Department under CHRO Sekar Ayuningtyas must log an offboarding ticket in Jira Service Management at least 48 hours prior to an employee's scheduled last working day.
2. **Revocation Timeline (4 Hours)**:
   - For planned separations, IT Infrastructure must terminate all access across Gudangku v4, RuteKu, SAP Business One, Jira, and Active Directory within a maximum window of 4 hours from the departure timestamp.
   - For involuntary or immediate terminations, HR notifies IT directly; access must be revoked within 15 minutes of notification.
3. **Confirmation**: IT must attach system termination logs to the Jira ticket before the clearance voucher is released to Finance for final severance disbursement.

---

### 8. Periodic Access Reviews and Auditing Schedule
1. **Quarterly Review Schedule**: Formal access audits must occur every calendar quarter, closing strictly on:
   - Quarter 1: March 31
   - Quarter 2: June 30
   - Quarter 3: September 30
   - Quarter 4: December 31
2. **Review Scope**: Department Heads must review active user lists for all 1,240 positions across Gudangku v4, RuteKu, and SAP Business One.
3. **Remediation**: Unused accounts inactive for 45 consecutive days must be suspended automatically. Accounts remaining unverified 5 working days post-quarterly review will be purged immediately. Certified audit registers must be signed by Hendra Gunawan (CTO) and archived for 7 fiscal years.
