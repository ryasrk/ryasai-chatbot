# PT ARUNIKA LOGISTIK NUSANTARA
## IT DISASTER RECOVERY PLAN (IT-DRP)

**Document Code:** DRP-ITN-2026-V2  
**Version:** 2.4  
**Effective Date:** 12 January 2026  
**Owning Department:** Technology and Infrastructure Division  
**Approval Authority:** Hendra Gunawan (Chief Technology Officer)  

---

### 1. Purpose and Operational Context
This IT Disaster Recovery Plan ("Plan") establishes protocols to restore mission-critical digital infrastructure for PT Arunika Logistik Nusantara ("Arunika") during catastrophic events. Operating across national freight forwarding, warehousing, and last-mile delivery, Arunika relies on continuous system availability to orchestrate 1,240 employees, a 370-vehicle fleet (140 CDD, 96 CDE, 52 Fuso, 24 Tronton, and 58 vans), and round-the-clock, three-shift operations across five distribution centers: Surabaya (SBY-01, 18,000 m²), Jakarta Cikarang (JKT-02, 24,500 m²), Medan (MDN-03, 9,200 m²), Makassar (MKS-04, 7,800 m²), and Balikpapan (BPN-05, 6,100 m²).

### 2. Primary and Disaster Recovery Facilities
- **Primary Data Center (PDC):** Arunika Head Office, Jl. Rungkut Industri III No. 18, Surabaya, East Java. The facility houses enterprise application clusters, central databases, and primary telecom terminations.
- **Disaster Recovery Site (DRS):** Secure Tier-III Colocation Data Center located within the Jakarta Cikarang Hub facility (JKT-02), Cikarang Industrial Estate, West Java. The DRS features an independent electrical grid, dual 10 Gbps SD-WAN interconnection to PDC, and isolated secondary hyperconverged compute nodes.

### 3. Recovery Objectives
System criticality determines recovery priorities. Recovery Time Objective (RTO) defines maximum tolerable downtime, while Recovery Point Objective (RPO) dictates maximum allowable data loss.

| System Name | Business Function | Primary Workload | RPO | RTO | Failover Mechanism |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Gudangku v4** | Warehouse Management (WMS) | Inventory tracking, 3-shift picking & dispatch across 5 DCs | 15 minutes | 4 hours | Active-Passive snapshot replication to DRS cluster |
| **RuteKu** | Transport Management (TMS) | Dispatch & tracking for 312 trucks and 58 delivery vans | 1 hour | 8 hours | Automated hourly log shipping with standby instance |
| **SAP Business One** | Enterprise Resource Planning (ERP) | General ledger, invoicing, procurement, billing | 4 hours | 24 hours | Daily full backup with 4-hour differential replication |
| **Jira Service Management** | Incident & Ticketing | Operations support desk and internal IT request portal | 2 hours | 12 hours | Cloud vendor cross-region standby tenant |

### 4. Disaster Recovery Roles and Responsibilities
- **DR Incident Commander (Hendra Gunawan, CTO):** Declares disaster status, initiates DRS failover, and commands recovery operations.
- **Executive Oversight (Ratna Wijayakusuma, CEO):** Receives executive briefings, approves external crisis communication, and ratifies major strategic actions.
- **Finance and Emergency Procurement (Dimas Prasetyo, CFO):** Authorizes emergency expenditures from the IT Contingency Reserve (capped at IDR 650,000,000 per event).
- **Logistics Continuity Coordinator (Yusuf Halim, COO):** Transitions regional warehouses (SBY-01 through BPN-05) and transport coordinators to offline buffer procedures during downtime.
- **Human Resources & Safety Lead (Sekar Ayuningtyas, CHRO):** Coordinates staff headcounts, regional safety notifications, and internal workforce bulletins.
- **Lead Database & Infrastructure Administrator:** Executes technical failover, confirms data integrity against target RPO, and manages DNS switching.

### 5. Communication Tree and Escalation Workflow
When an outage persists beyond 30 minutes during standard hours (08:00–17:00 WIB) or warehouse operational shifts, escalation proceeds as follows:

```
[Level 1: System Monitoring Alert / Shift Lead Report]
                    │
                    ▼
[IT Operations Support Lead (Jira Service Management)]
                    │ (< 15 Minutes)
                    ▼
[DR Incident Commander: Hendra Gunawan (CTO)]
                    │
       ┌────────────┴────────────┐
       ▼                         ▼
[Executive Command]       [Business Continuity Operations]
  - Ratna Wijayakusuma (CEO) - Yusuf Halim (COO)
  - Dimas Prasetyo (CFO)       ├─ SBY-01, JKT-02, MDN-03 Warehouse Managers
  - Sekar Ayuningtyas (CHRO)   └─ Fleet Dispatch (312 Trucks / 58 Vans)
```

1. **Detection (T0 to T+15m):** Monitoring alerts trigger an automatic Level 1 notification to the IT Operations Support Lead via Jira Service Management.
2. **Declaration (T+15m to T+45m):** If primary systems are non-recoverable at PDC, CTO Hendra Gunawan formally declares a DR Event.
3. **Internal Cascading (T+45m to T+60m):** CEO Ratna Wijayakusuma and CFO Dimas Prasetyo are notified. COO Yusuf Halim alerts warehouse duty managers across all shifts to enforce paper-based manifests. CHRO Sekar Ayuningtyas issues staff notifications.
4. **Technical Execution (T+1h to RTO Target):** Infrastructure teams switch network routes to JKT-02 DRS.

### 6. Testing, Validation, and Maintenance Schedule
To guarantee operational readiness, Arunika mandates comprehensive DR testing twice each calendar year:
- **April Drill (Second Weekend):** Simulated component failover for WMS "Gudangku v4" and TMS "RuteKu". Focuses on data synchronization, database consistency checks, and transaction loss audits.
- **October Drill (Fourth Weekend):** Full datacenter isolation exercise. Simulates complete failure of Surabaya PDC with full cutover to JKT-02 DRS across all enterprise workloads, including SAP Business One.
- **Audit & Review:** Within 10 business days following each exercise, the CTO submits an evaluation report to the Board of Directors detailing observed RTO/RPO metrics, bottleneck analyses, and required corrective actions.
