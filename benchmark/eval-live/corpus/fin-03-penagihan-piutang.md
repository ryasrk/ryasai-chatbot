# PT ARUNIKA LOGISTIK NUSANTARA
## POLICY DIRECTIVE: BILLING, CREDIT, AND COLLECTIONS
**Document Code:** POL-FIN-2026-003  
**Version:** 3.0  
**Effective Date:** 01 January 2026  
**Owning Department:** Finance & Accounting Directorate  
**Approved By:** Dimas Prasetyo (Chief Financial Officer) & Ratna Wijayakusuma (Chief Executive Officer)

---

### 1. Purpose and Scope
This policy establishes standardized guidelines for credit evaluation, customer invoicing, collection workflows, and accounts receivable governance at PT Arunika Logistik Nusantara ("Arunika"). It governs all commercial credit extensions across domestic freight forwarding, last-mile delivery, and contract logistics operating out of Arunika distribution facilities (SBY-01 Surabaya, JKT-02 Cikarang, MDN-03 Medan, MKS-04 Makassar, and BPN-05 Balikpapan). 

Compliance is mandatory for all commercial, billing, customer support, and operational personnel during standard corporate operating hours (Monday–Friday, 08:00–17:00 WIB).

### 2. Customer Segmentation, Credit Limits, and Payment Terms
Credit facilities are granted strictly based on risk profiling, legal verification, financial assessment, and historical volume. All credit parameters and customer master records must be maintained in SAP Business One.

| Customer Segment | Qualification Criteria | Standard Payment Terms | Default Credit Limit (IDR) | Maximum Credit Limit (IDR) | Credit Assessment Authority |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Enterprise** | Annual contracted run-rate > IDR 3,000,000,000; minimum 2 years audited financial statements | Net 45 calendar days | IDR 500,000,000 | IDR 2,500,000,000 | CFO Dimas Prasetyo |
| **Corporate SME** | Contracted client; operating history > 12 months; bank statements & NPWP verified | Net 30 calendar days | IDR 75,000,000 | IDR 500,000,000 | Credit Committee |
| **Standard SME** | Verified business entity (NIB and NPWP validated); active trade < 12 months | Net 30 calendar days | IDR 25,000,000 | IDR 75,000,000 | Credit & Collections Manager |
| **Walk-in / Retail** | Ad-hoc bookings, non-contracted transport, spot cargo, retail last-mile | Cash on Delivery (COD) / Pre-payment | IDR 0 | IDR 0 | Branch Station Manager |

### 3. Invoicing and Billing Operations
1. **Billing Triggers:** Invoicing data is generated automatically in SAP Business One upon milestone completion confirmed by operational platforms:
   - Freight Forwarding and Last-Mile: Triggered via electronic Proof of Delivery (e-POD) synchronization in RuteKu (TMS).
   - Warehousing: Storage, handling, and value-added service fees are closed on the final calendar day of each month via Gudangku v4 (WMS).
2. **Dispatch Timeline:** Invoices accompanied by commercial receipts, digital tax slips (Faktur Pajak), and validated e-PODs must be delivered to clients within 2 business days of operational milestone completion.
3. **Billing Inquiries:** Client disputes regarding rates, damaged cargo, or billing counts must be logged via Jira Service Management within 7 calendar days of invoice dispatch. Undisputed invoice amounts remain fully payable under agreed terms.

### 4. Late Payment Charges
Invoices remaining unpaid beyond their assigned due date (Net 30 or Net 45) incur late payment interest:
- **Rate:** 2.0% per month, calculated on a 30-day pro-rata basis (0.067% per diem) against the gross overdue principal balance.
- **Cap:** Cumulative late interest charges are strictly capped at 10.0% of the total original invoice principal.
- **Waiver Authority:** Late fees may only be adjusted or waived in writing by CFO Dimas Prasetyo following joint review with COO Yusuf Halim verifying operational dispatch errors.

### 5. Credit Hold Rules and Operational Enforcement
Credit holds prevent Arunika from accumulating uncollectible exposure and require automated cross-system integration:
1. **Trigger Criteria:** An account is automatically placed on Credit Hold if:
   - Any undisputed invoice exceeds its payment term by more than 14 calendar days; or
   - The total of unbilled orders, in-transit shipments, and open accounts receivable reaches or exceeds 100% of the approved credit limit in SAP Business One.
2. **Operational Locks:**
   - **TMS ("RuteKu"):** Automatic system lock prevents booking creation, route planning, and dispatch allocation across all fleet assets (CDD, CDE, Fuso, Tronton, and delivery vans).
   - **WMS ("Gudangku v4"):** Automated hold prevents stock picking, staging, and outbound gate pass issuance across all distribution hubs (SBY-01, JKT-02, MDN-03, MKS-04, and BPN-05).
3. **Override Protocol:** Temporary release of an operational credit hold requires written authorization from CFO Dimas Prasetyo, supported by a formal debt repayment agreement or immediate partial bank transfer confirmation.

### 6. Dunning Schedule and Collections Procedures
The Credit and Collections team executes recovery workflows based on days past invoice maturity:
- **Day +7 Overdue:** Dunning Level 1. SAP Business One issues an automated email reminder and digital Statement of Account (SOA) to the client's registered accounts payable contact.
- **Day +14 Overdue:** Dunning Level 2. Credit Collectors execute direct telephone outreach. A formal overdue payment reminder is issued, and an automated soft credit hold blocks incremental order creation.
- **Day +30 Overdue:** Dunning Level 3. Formal First Legal Warning Letter (*Somasi I*) issued, signed by the Head of Legal and Credit & Collections Manager. Hard Credit Hold is locked in RuteKu and Gudangku v4. Outbound shipments are halted, and in-transit cargo may be held under carrier lien.
- **Day +60 Overdue:** Dunning Level 4. Second Legal Warning Letter (*Somasi II*) issued. Master Service Agreement is formally suspended. The file is transferred to external legal counsel for court collection or asset recovery, and the balance is marked for bad debt evaluation.

### 7. Bad Debt Write-Off Approval Hierarchy
Receivables deemed uncollectible after 180 calendar days of active recovery, debtor bankruptcy, or judicial exhaustion must be written off using the following authorization thresholds:
- **Up to IDR 25,000,000:** Approved jointly by the Credit & Collections Manager and Financial Controller.
- **IDR 25,000,001 to IDR 150,000,000:** Approved by Chief Financial Officer Dimas Prasetyo.
- **Above IDR 150,000,000:** Approved jointly by Chief Financial Officer Dimas Prasetyo and Chief Executive Officer Ratna Wijayakusuma, with formal notice submitted to the Board of Commissioners.
