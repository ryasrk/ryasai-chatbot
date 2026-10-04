# PT Arunika Logistik Nusantara
## Standard Operating Procedure: Cargo Insurance and Claims Procedure

**Document Code:** ALN-SOP-FIN-014  
**Version:** 3.2  
**Effective Date:** January 15, 2026  
**Owning Department:** Finance & Risk Management Directorate  
**Approved by:** Dimas Prasetyo (Chief Financial Officer) & Yusuf Halim (Chief Operating Officer)  

---

### 1. Purpose and Scope
This Standard Operating Procedure defines the mandatory guidelines for cargo insurance coverage, loss management, and claim settlement across PT Arunika Logistik Nusantara ("Arunika"). It governs risk boundaries, deductible schedules, required documentation, and processing timelines for freight loss, damage, or shortage.

This procedure applies to all cargo operations utilizing Arunika's 312 trucks (140 CDD, 96 CDE, 52 Fuso, 24 Tronton) and 58 vans, across all warehouse facilities (SBY-01, JKT-02, MDN-03, MKS-04, BPN-05), and throughout all three daily operating shifts.

---

### 2. Underwriter, Policy Limits, and Deductibles
Arunika's cargo risk is underwritten by **PT Asuransi Sompo Insurance Indonesia** (Policy No. CGO-7742-JKT-2026) under Institute Cargo Clauses (A) All-Risks terms and warehouse bailee coverage.

#### Table 1: Insurance Coverage Limits and Deductibles
| Scope | Asset / Facility Code | Fleet or Facility Details | Policy Limit (IDR) | Deductible per Incident (IDR) |
| :--- | :--- | :--- | :--- | :--- |
| Transit Fleet | Vans (58 units) | Blind vans / last-mile | 250,000,000 per conveyance | 5% of claim (min. 2,500,000) |
| Transit Fleet | CDE (96 units) | Colt Diesel Engkel (4 wheels) | 500,000,000 per conveyance | 5% of claim (min. 5,000,000) |
| Transit Fleet | CDD (140 units) | Colt Diesel Double (6 wheels) | 1,000,000,000 per conveyance | 5% of claim (min. 5,000,000) |
| Transit Fleet | Fuso (52 units) | Medium-duty cargo trucks | 2,500,000,000 per conveyance | 5% of claim (min. 10,000,000) |
| Transit Fleet | Tronton (24 units) | Heavy multi-axle trucks | 5,000,000,000 per conveyance | 5% of claim (min. 15,000,000) |
| Warehouse | SBY-01 Surabaya | Hub warehouse (18,000 m²) | 85,000,000,000 per location | 10% of claim (min. 25,000,000) |
| Warehouse | JKT-02 Cikarang | Regional hub (24,500 m²) | 120,000,000,000 per location | 10% of claim (min. 25,000,000) |
| Warehouse | MDN-03 Medan | Regional hub (9,200 m²) | 45,000,000,000 per location | 10% of claim (min. 20,000,000) |
| Warehouse | MKS-04 Makassar | Regional hub (7,800 m²) | 40,000,000,000 per location | 10% of claim (min. 20,000,000) |
| Warehouse | BPN-05 Balikpapan | Regional hub (6,100 m²) | 30,000,000,000 per location | 10% of claim (min. 15,000,000) |

---

### 3. Excluded Goods
The master insurance policy strictly excludes the following cargo items from standard coverage. Transportation of these goods requires written underwriter endorsement secured at least 48 hours prior to dispatch:
1. **Precious Metals & Currency:** Cash, minted bullion, promissory notes, traveler's checks, negotiable bonds, precious stones, and fine jewelry.
2. **Munitions & Armaments:** Weapons, ammunition, military hardware, commercial explosives, and fireworks.
3. **Hazardous Materials:** UN Class 1 (Explosives) and UN Class 7 (Radioactive materials).
4. **Live Animals:** Livestock, poultry, pets, and biological research specimens.
5. **Deep-Frozen Perishables:** Foodstuffs requiring active refrigeration below -18°C without a designated reefer transport rider.
6. **Antiques & High-Value Art:** Artifacts older than 50 years and artwork exceeding IDR 200,000,000 per piece without pre-shipment valuation.
7. **Prohibited Goods:** Illegal narcotics, contraband, unexcised goods, and items prohibited under Indonesian law.

---

### 4. Claims Procedure and Timelines

#### 4.1 Claim Filing (Within 7 Calendar Days)
- Claimants must formally file any cargo loss, damage, or shortage notice within **seven (7) calendar days** of shipment delivery or scheduled delivery date.
- The claim must be initiated by opening a ticket in Jira Service Management under queue `CARGO-CLAIM`. Late filings beyond 7 days are automatically barred from indemnification.

#### 4.2 Investigation and Loss Assessment (Within 14 Calendar Days)
- The Risk Management Division and the insurer's appointed loss adjuster have **fourteen (14) calendar days** from Jira ticket creation to complete the full investigation.
- The investigation involves auditing GPS tracks in TMS "RuteKu", shift inventory records in WMS "Gudangku v4", and executing physical inspections.
- An official Loss Assessment Report determining liability and payable damages must be issued on or before day 14.

#### 4.3 Claim Approval and Payout (Within 30 Calendar Days)
- Disbursement of the approved claim amount must be executed within **thirty (30) calendar days** of formal approval and execution of the subrogation receipt.
- Finance processes settlement payments directly to claimant accounts net of the applicable deductible.

---

### 5. Required Claim Documents
Claim submissions in Jira Service Management must include the following seven mandatory documents:
1. **Formal Claim Letter:** Describing incident date, consignment code, cargo nature, and exact claim amount in IDR.
2. **Surat Jalan / Delivery Order:** Consignment note from TMS "RuteKu" containing exception remarks signed by driver and receiver.
3. **Commercial Invoice & Packing List:** Vendor invoice establishing actual cargo cost basis.
4. **Warehouse Discrepancy Slip:** Discrepancy report exported from WMS "Gudangku v4" signed by the shift lead.
5. **Photographic & Video Evidence:** Clear images of damaged goods, carton integrity, packaging, and vehicle seal status.
6. **Police Incident Report (Surat Keterangan Kepolisian):** Mandatory for vehicular accidents, hi-jackings, warehouse burglary, or losses above IDR 20,000,000.
7. **Joint Inspection Form:** Signed jointly by the Arunika Warehouse Shift Supervisor and customer representative.

---

### 6. Enterprise Systems and Settlement Accounting
1. **TMS "RuteKu":** Exports telematics records, route histories, and electronic proof of delivery (e-POD) incident logs within 12 hours of an exception.
2. **WMS "Gudangku v4":** Warehouse teams record damaged stock under status `CLM-QUARANTINE` across all 3 shifts to isolate physical inventory from sellable stock.
3. **Jira Service Management:** Tracks claim progression through workflow stages: `Submitted`, `Under-Investigation`, `Adjuster-Survey`, `Approved`, and `Closed`.
4. **ERP SAP Business One:** Finance posts claim accruals to Account `2140-02` (Cargo Claims Payable) and disburses settlements via Account `5210-04` (Cargo Settlement Losses), authorized by CFO Dimas Prasetyo.
