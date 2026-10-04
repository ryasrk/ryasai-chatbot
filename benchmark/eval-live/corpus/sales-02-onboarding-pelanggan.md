# PT ARUNIKA LOGISTIK NUSANTARA
## INTERNAL OPERATING PROCEDURE: CUSTOMER ONBOARDING AND KYC
**Document Code:** SOP-COM-2026-002  
**Version:** 2.1  
**Effective Date:** January 12, 2026  
**Owning Department:** Commercial & Business Solutions Division  
**Corporate Headquarters:** Jl. Rungkut Industri III No. 18, Surabaya  
**Authorized By:** Ratna Wijayakusuma (Chief Executive Officer), Dimas Prasetyo (Chief Financial Officer)  

---

### 1. Purpose and Scope
This Standard Operating Procedure defines the mandatory steps for Know Your Customer (KYC) verification, credit risk evaluation, technical integration, and operational trial execution for onboarding new business-to-business (B2B) clients at PT Arunika Logistik Nusantara ("Arunika"). 

The scope covers all accounts utilizing Arunika’s freight forwarding, contract warehousing (including facilities SBY-01, JKT-02, MDN-03, MKS-04, and BPN-05), and last-mile delivery services across Indonesia.

---

### 2. Mandatory KYC Documentation
All commercial onboarding requests must be initiated via Jira Service Management under the "Customer Onboarding" queue. The client relationship team must obtain and verify the following official corporate records:

1. **Nomor Induk Berusaha (NIB):** Valid business registration issued through the Online Single Submission (OSS) system, including verifiable standard industrial classification (KBLI) codes.
2. **Nomor Pokok Wajib Pajak (NPWP):** Corporate tax identification number card along with the Taxable Entrepreneur Confirmation Decree (Surat Pengukuhan Pengusaha Kena Pajak / SPPKP).
3. **Corporate Deeds:** Notarial Deed of Establishment (Akta Pendirian) and the most recent Deed of Amendments (Akta Perubahan Anggaran Dasar Terakhir), including the official approval decrees from the Ministry of Law and Human Rights (Surat Keputusan Kemenkumham RI).
4. **Authorized Identity Records:** Valid KTP for Indonesian citizens or Passport and KITAS for foreign nationals representing the Board of Directors with signatory authority.
5. **Financial Records:** Audited financial statements for the preceding calendar fiscal year or certified bank account statements covering the last three (3) consecutive months.

---

### 3. Credit Assessment and Risk Management
The Credit Control Division under CFO Dimas Prasetyo is solely responsible for determining customer creditworthiness and credit line approvals.

1. **Evaluation Process:** The Credit Control team inputs applicant financial data into SAP Business One to calculate a standardized corporate credit score. Assessment includes clearing history through Bank Indonesia regulatory records and commercial credit bureau references.
2. **Credit Limit Tiers:**
   - **Tier 1 (Unsecured Credit up to IDR 500,000,000):** Minimum operating history of three years with verified profitable cash flow. Payment terms: Net 30 days.
   - **Tier 2 (Unsecured Credit up to IDR 150,000,000):** Operating history between one and three years. Payment terms: Net 14 days.
   - **Tier 3 (Cash Basis / Security Deposit):** New entities operating under 12 months or clients with insufficient credit ratings. Requires a rolling security deposit equal to thirty days of estimated logistics spending or prepayment prior to cargo dispatch.
3. Master billing profiles and payment terms become active in SAP Business One only upon written sign-off from the Credit Control Manager and final counter-signature by the CFO.

---

### 4. Account Manager Assignment Rules
Following initial commercial clearance, client accounts are assigned to specific commercial tiers based on projected monthly billing.

| Client Tier | Projected Monthly Revenue (IDR) | Assigned Role | Engagement & Service Level |
| :--- | :--- | :--- | :--- |
| **Enterprise** | Above IDR 250,000,000 | Key Account Manager (KAM) | Dedicated single point of contact, custom SLA, monthly steering meetings |
| **Corporate** | IDR 75,000,001 to IDR 250,000,000 | Senior Account Manager | Dedicated manager, bi-weekly performance updates, quarterly business reviews |
| **Commercial** | IDR 20,000,000 to IDR 75,000,000 | Account Manager | Portfolio-managed account, standard monthly reporting, priority support queue |
| **Standard** | Below IDR 20,000,000 | Inside Sales Specialist | Shared support desk, standard ticketing via Jira Service Management |

---

### 5. Technical System Integration Options
Arunika's IT Systems Division under CTO Hendra Gunawan configures connectivity between client software and Arunika’s operational platforms: TMS "RuteKu" and WMS "Gudangku v4".

1. **Direct REST API Integration:** Real-time bi-directional pipeline connecting client ERP/OMS directly to RuteKu and Gudangku v4. Supports automated delivery order injection, inventory level queries, and instantaneous electronic proof of delivery (e-POD) receipt.
2. **Automated SFTP (Secure File Transfer Protocol):** Scheduled batch processing of delimited CSV or XML manifests uploaded to Arunika’s secure server at scheduled daily intervals (06:00, 14:00, and 22:00 WIB). Ideal for scheduled inbound receiving and daily batch dispatches.
3. **Arunika Client Web Portal:** Secure self-service web interface enabling manual order entry, stock monitoring across warehouses (SBY-01 through BPN-05), and real-time fleet GPS tracking across Arunika’s 312 trucks (CDD, CDE, Fuso, Tronton) and 58 vans.

---

### 6. Trial Shipment Procedure
Before launching commercial volumes, the assigned Account Manager coordinates an operational trial to test physical handling and data accuracy.

1. **Volume and Scope:** A single line-haul movement (minimum 1 CDD or Fuso shipment) or a controlled warehouse inbound pilot (10 to 20 pallets) through SBY-01 (Surabaya) or JKT-02 (Cikarang).
2. **Supervision:** Under the oversight of COO Yusuf Halim’s operational supervisors across the warehouse shifts, cargo is checked for scanning accuracy, packaging integrity, and transit compliance.
3. **Validation Gate:** The trial is deemed successful when physical transit aligns with scheduled SLA, stock balances reflect accurately in Gudangku v4 within 2 hours of receipt, and milestone tracking displays properly in RuteKu. A formal Trial Sign-Off Form must be countersigned by both the client and Arunika’s Operations Supervisor.

---

### 7. Five-Day Onboarding SLA
The end-to-end customer onboarding procedure must be completed within five (5) business days during standard operating hours (Monday to Friday, 08:00–17:00 WIB).

```
Day 1: Document Intake & Dossier Verification (NIB, NPWP, Deeds via Jira Service Management)
Day 2: Financial Assessment & Credit Limit Recommendation (SAP Business One)
Day 3: Credit Line Approval & Master Account Configuration (CFO Approval & AM Assignment)
Day 4: Technical Integration Setup (API / SFTP / Portal Configuration & Credential Handover)
Day 5: Operational Trial Shipment Execution & Formal Account Go-Live Sign-Off
```

Accounts experiencing incomplete documentation will be placed on administrative hold within Jira Service Management, pausing the five-day SLA clock until all mandatory records are furnished.
