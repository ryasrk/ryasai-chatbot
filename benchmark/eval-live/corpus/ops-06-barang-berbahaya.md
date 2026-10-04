# PT ARUNIKA LOGISTIK NUSANTARA
## STANDARD OPERATING PROCEDURE: DANGEROUS GOODS HANDLING
**Document Code:** SOP-OPS-DG-004  
**Version:** 3.1  
**Effective Date:** 15 January 2026  
**Owning Department:** Operations Directorate  
**Approved by:** Yusuf Halim, Chief Operating Officer  
**Head Office:** Jl. Rungkut Industri III No. 18, Surabaya  

---

### 1. Purpose and Facility Scope

This Standard Operating Procedure (SOP) defines mandatory requirements for the acceptance, handling, storage, and movement of Dangerous Goods (DG) across PT Arunika Logistik Nusantara ("Arunika"). This policy ensures strict compliance with Indonesian transport safety laws, IMO/IMDG guidelines, and internal safety standards.

#### 1.1 Facility Acceptance Rules
DG handling is restricted exclusively to two equipped hub facilities:
1. **Surabaya Hub (SBY-01):** Total facility 18,000 m²; dedicated DG storage vault 1,200 m².
2. **Jakarta Cikarang Hub (JKT-02):** Total facility 24,500 m²; dedicated DG storage vault 1,800 m².

**Strictly Prohibited Locations:** Regional warehouses Medan (MDN-03, 9,200 m²), Makassar (MKS-04, 7,800 m²), and Balikpapan (BPN-05, 6,100 m²) lack chemical containment sumps and vapor suppression systems. These three facilities are strictly barred from accepting, staging, or cross-docking any DG cargo. Any inbound delivery containing DG arriving at MDN-03, MKS-04, or BPN-05 will be rejected immediately at the inbound security gate.

---

### 2. Maximum Storage Limits

Thresholds are monitored continuously in WMS *Gudangku v4* and reconciled against ERP *SAP Business One*. Storage beyond authorized tonnage is prohibited.

| Facility Code | Warehouse Location | Total Facility Area | DG Containment Area | Maximum DG Capacity | Permitted DG Intake |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **SBY-01** | Surabaya, East Java | 18,000 m² | 1,200 m² | 45,000 kg (45 MT) | Yes |
| **JKT-02** | Cikarang, West Java | 24,500 m² | 1,800 m² | 75,000 kg (75 MT) | Yes |
| **MDN-03** | Medan, North Sumatra | 9,200 m² | 0 m² | 0 kg (0 MT) | Prohibited |
| **MKS-04** | Makassar, South Sulawesi | 7,800 m² | 0 m² | 0 kg (0 MT) | Prohibited |
| **BPN-05** | Balikpapan, East Kalimantan | 6,100 m² | 0 m² | 0 kg (0 MT) | Prohibited |

---

### 3. Hazard Classification: Accepted vs. Excluded Classes

#### 3.1 Accepted UN Classes
- **Class 3 (Flammable Liquids):** Packing Groups II and III only (e.g., solvents, coatings, printing inks). Flash points between 23°C and 60°C.
- **Class 8 (Corrosive Substances):** Packing Groups II and III organic and inorganic acids and alkalis in certified UN packaging.
- **Class 9 (Miscellaneous Dangerous Goods):** UN3480 and UN3481 Lithium-ion batteries, dry ice, and regulated consumer chemical packages.

#### 3.2 Excluded UN Classes (Strictly Prohibited)
Arunika does not handle, store, or transport:
- **Class 1:** All Explosives (1.1 through 1.6).
- **Class 2.3:** Toxic Inhalation Gases.
- **Class 4.2 & 4.3:** Spontaneously Combustible and Dangerous When Wet.
- **Class 5.2:** Organic Peroxides.
- **Class 6.2:** Infectious Substances.
- **Class 7:** Radioactive Materials.

---

### 4. MSDS Requirements and Inbound Clearance

1. **Mandatory Documentation:** Every inbound consignment must have an authentic 16-section Material Safety Data Sheet (MSDS / SDS) compliant with the Globally Harmonized System (GHS). The MSDS must be issued in either Indonesian or English and updated within the last 36 months.
2. **Receiving Verification:** Shift receiving officers must inspect packaging integrity, verify UN specification marks, and upload the MSDS into *Gudangku v4*. Inbound lots cannot be binned until *SAP Business One* confirms SKU hazardous profile activation.
3. **Transport Documentation:** Outbound dispatches created in TMS *RuteKu* must print emergency response codes and shipper 24-hour hotlines on driver manifests.

---

### 5. Storage Segregation Matrix

All DG stored at SBY-01 and JKT-02 must adhere to the chemical segregation rules defined below.

| Hazard Category | Class 3 Flammable Liquids | Class 8 Corrosives (Acids) | Class 8 Corrosives (Alkalis) | Class 9 Miscellaneous & Batteries |
| :--- | :--- | :--- | :--- | :--- |
| **Class 3 Flammables** | Compatible; shared fire bund permitted | Segregate by min. 6 meters or concrete firewall | Segregate by min. 6 meters or concrete firewall | Segregate by min. 3 meters lateral distance |
| **Class 8 Acids** | Segregate by min. 6 meters or concrete firewall | Compatible; acid-resistant secondary sump | Strictly incompatible; separate sumps and min. 5 m | Segregate by min. 3 meters lateral distance |
| **Class 8 Alkalis** | Segregate by min. 6 meters or concrete firewall | Strictly incompatible; separate sumps and min. 5 m | Compatible; alkali-resistant secondary sump | Segregate by min. 3 meters lateral distance |
| **Class 9 Miscellaneous**| Segregate by min. 3 meters lateral distance | Segregate by min. 3 meters lateral distance | Segregate by min. 3 meters lateral distance | Compatible; maintain dry racking conditions |

---

### 6. Training and Handler Certification

1. **Certified Handler Requirement:** Every employee handling or staging DG must hold an active BNSP/Ministry of Transportation Certified DG Handler credential.
2. **Mandatory Refresher Cycle:** Recertification is mandatory every twenty-four (24) months. CHRO Sekar Ayuningtyas allocates an annual training budget of IDR 4,800,000 per operative through the People and Culture Division.
3. **Shift Staffing:** Because warehouses operate continuously on 3 shifts (Shift 1: 06:00–14:00, Shift 2: 14:00–22:00, Shift 3: 22:00–06:00 WIB), SBY-01 and JKT-02 must maintain a minimum of two (2) certified DG specialists on active floor duty during every shift.

---

### 7. Emergency Spill Response Protocol

In case of container leak or chemical spill, teams must execute this four-phase procedure:

1. **Phase 1: Evacuate and Secure (Minutes 0–5)**
   - Evacuate personnel within 20 meters upwind.
   - Deploy safety cones to seal the corridor. Cut power to adjacent electrical panels.
2. **Phase 2: Identification and PPE (Minutes 5–10)**
   - The Shift Safety Supervisor scans the pallet barcode in *Gudangku v4* to retrieve the electronic MSDS.
   - Clean-up responders don Level B/C chemical PPE (full-face vapor respirators, heavy nitrile gloves, chemical-resistant splash suits).
3. **Phase 3: Containment and Neutralization (Minutes 10–30)**
   - Surround the spill using polypropylene absorbent booms from the zone spill cart.
   - For Class 8 acid spills, apply sodium bicarbonate neutralizing powder. For alkali leaks, apply citric acid neutralizing granules. For Class 3 liquids, apply inert vermiculite absorbent.
   - Shovel spent absorbent into 120-liter UN-rated polyethylene salvage overpack drums.
4. **Phase 4: Escalation and Disposal (Within 60 Minutes)**
   - Raise a Severity-1 incident ticket in *Jira Service Management* under queue `DG-EMERGENCY`.
   - Transmit an incident report to COO Yusuf Halim and CTO Hendra Gunawan within two hours.
   - Contracted hazardous waste handlers must collect sealed overpack drums within 24 hours. Failure to follow spill protocols carries internal disciplinary fines up to IDR 25,000,000 per violation.

---

### 8. Fleet Allocation and Transport Standards

- DG line-hauls are restricted to Arunika's heavy truck fleet: 140 CDD, 96 CDE, 52 Fuso, and 24 Tronton trucks.
- Arunika's 58 urban delivery vans are strictly forbidden from transporting Class 3 or Class 8 liquid chemical consignments.
- Every assigned truck must carry two 9 kg dry chemical fire extinguishers, a 45-liter chemical spill kit, and real-time tracking enabled through *RuteKu*.
