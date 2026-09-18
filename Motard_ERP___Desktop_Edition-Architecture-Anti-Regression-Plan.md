# Motard ERP — Desktop Edition: Architecture & Anti-Regression Plan

## 0. READ THIS FIRST — Why this document exists

We have already built **more than ten previous versions** of this desktop application. **Every single one failed in the same ways.** Not different failures each time — the *same* failures, reappearing in a new shape after each "fix."

So this document is **not a bug list to patch.** It is a record of failures that actually happened, and a demand for an **architecture that makes them structurally impossible to repeat.**

### 0.1 The rules that broke every previous attempt

Read these before writing a single line of code. Violating any one of them is how we got here:

1. **No symptom patching.** Every fix must address the **root cause**. If you cannot explain the root cause in writing, you are not allowed to "fix" it.
2. **Banned "solutions":** adding `sleep`, adding retries to hide a race, increasing timeouts, telling the user to "refresh," "restart the app," or "wait longer." These are not fixes — they are how the same bug came back ten times wearing a different mask.
3. **"It works on the dev machine" is worthless evidence.** See Section 5.
4. **Clean Architecture is mandatory, not a preference.** See Section 1.
5. **Report honestly.** If something is unverified, say **NOT PROVEN**. An optimistic "PASS" is worse than an honest failure, because it is how broken versions reached customers.

### 0.2 What went wrong last time, in one picture

The core damage was never one isolated bug. It was **cascading failure across tightly coupled layers**:

```
PostgreSQL fails to start correctly
        ↓
Backend fails to connect
        ↓
Frontend fires dozens of API errors
        ↓
User concludes "the invoices and inventory are corrupted"
```

The user sees a hundred false errors and never the one real cause. **The architecture must surface the single true root cause — never a storm of downstream noise.**

---

## 1. Architectural Foundation (non-negotiable)

### 1.1 Desktop is a runtime layer, not a second ERP

The existing Web ERP **is** the ERP. The desktop edition is the layer that makes that same ERP run as a real, standalone Windows application. **Do not fork, reimplement, or duplicate business logic into the desktop layer.**

```
┌─────────────────────────────────────────┐
│         Desktop Runtime Layer           │
│  (process lifecycle, DB bootstrap,      │
│   ports, packaging, updates, recovery)  │
├─────────────────────────────────────────┤
│         ERP Business Logic              │
│      (single shared implementation)     │
└─────────────────────────────────────────┘
```

Hard separation. No leakage in either direction.

### 1.2 Clean Code / Clean Architecture requirements

Previous attempts failed because of **excess coupling, duplicated logic, tangled runtime dependencies, fragile startup sequencing, and patch-on-patch fixes**. The result: a bug in one layer broke three other layers.

Required from day one:
- Clear layer boundaries with explicit, one-directional dependencies
- No duplicated business logic between web and desktop
- Startup sequencing that is explicit, ordered, and observable — not implicit and timing-dependent
- Failures isolated to their own layer, with a single accurate error surfaced to the user

---

## 2. Identity Model — License ≠ Company ≠ Installation ≠ User

This separation is **critical**, because previous builds let a new installation inherit an old company's identity and data. That must be structurally impossible.

| Concept | What it is | What it is NOT |
|---------|-----------|----------------|
| **License** | The right to run the software; device entitlement | It carries **no** company name, manager name, PIN, password, invoice data, or any business data |
| **Company (Tenant)** | The customer's business data | Not derived from the license key content |
| **Installation** | One install on one machine — has its own Installation ID, device binding, and local DB | Never inherits identity or data from another machine |
| **User** | A person with a role and permissions inside a Company | Not the same thing as a device |

**Explicit requirement:** a new installation must **always** provision a fresh installation identity and must **never** reuse a previous tenant, company, or license state left on the machine or elsewhere.

---

## 3. The Complete Customer Journey (target behavior)

### 3.1 Purchase & license issuance
The vendor uses the **External License Dashboard** (which already exists and is already wired into the project — **verify that integration is correct and actually connected**). The vendor enters the customer (e.g. "Al-Noor Textiles") and clicks **Create License**, producing a key such as:
```
LIC-ABCD-1234
```
The key grants the right to run the software. Nothing more.

### 3.2 Single installer
The customer receives exactly one file:
```
Motard ERP Setup.exe
```
Their machine has **only Windows 10 or 11**. They do **not** have — and must never be asked to install or know about — Node.js, PostgreSQL, npm, Rust, Git, or VS Code.

They click **Install**. It finishes. That's all.

**Forbidden:** "install PostgreSQL first," "open port 5432," or a 10+ minute install with no explanation.

### 3.3 First launch
Internally the Desktop Runtime prepares the database, starts the backend, prepares resources, resolves ports, and establishes identity.

The user sees only:
```
Preparing Motard ERP...
```
then:
```
Ready
```
**Never** PostgreSQL, Node, localhost, or port numbers.

### 3.4 Activation (first time only)
```
Activate Motard ERP
License key: [________________]
```
The customer pastes `LIC-ABCD-1234`. The system verifies the license exists, is valid, is not revoked, is within its device limit, and binds it to the correct installation and tenant.

**It must not ask for the key again merely because the app was closed and reopened.**

### 3.5 Company setup
On success, show a brief celebratory confirmation with the company name and a simple animation, then proceed. This is where **License ≠ Company** becomes visible: the license proved the right to run; the company is the customer's own data.

### 3.6 Manager account creation
The customer creates their Manager account: username + password or PIN (e.g. `4827`).

- `0000` is **not** acceptable as a production value.
- The vendor never knows or manages the customer's PIN.

### 3.7 Windows startup behavior
There must be an option for Motard ERP to **start automatically with Windows**:
```
PC powers on → Motard ERP starts → prepares internally → ready
```
**Clarification (do not over-apply this):** "no password" means the user is not re-asked for Windows credentials or forced to re-run setup every time. It does **not** mean authentication is disabled — **if the user logged out of the ERP, the ERP's own login still applies.**

---

## 4. Multi-Device: Invitations, Not File Copying

**The manager must never copy their machine's files or database folder to the accountant.** That was the old broken approach.

### 4.1 Correct flow
1. Manager goes to **Settings → Users → Invite user** and generates:
   ```
   INVITE-XXXX-XXXX
   ```
2. The accountant installs the **same installer** on their own machine — a fresh installation with its own Installation ID, device binding, and local DB.
3. On launch, instead of creating a new company, the accountant chooses **"Join an existing company"** and enters the invitation code.
4. The system resolves: this company → this user → this role → this device, and adds them to the **same company**.
5. **The manager receives a notification via the sync system**, e.g. *"Device X joined the company via invitation as Accountant."*

### 4.2 License Code vs Invitation Code — keep these strictly separate

| | Purpose |
|---|---------|
| **License Code** | Right to run the software / device entitlement |
| **Invitation Code** | A user/device joining the customer's organization with a role |

### 4.3 Roles
```
Manager    → full permissions
Accountant → accounting permissions
Warehouse  → inventory permissions
```
Every device keeps its **own local installation and local DB**, regardless of role.

### 4.4 Additional devices
A third device follows the identical path: fresh install → join by invitation.
```
Device 1 → Manager
Device 2 → Accountant
Device 3 → Warehouse
```
Same company, separate local installations, Sync Hub as the intermediary.

### 4.5 Device limits
Each device has an independent device identity. The number of allowed devices comes from the **license**. If the plan allows 2 devices, a third activation must be refused. The customer can manage their own allowed devices; **raising the limit or changing the plan stays with the vendor** (Control Plane logic).

---

## 5. Offline-First (the heart of the product)

**The internet is for synchronization — never a requirement for daily work.**

With no connection, the accountant must still be able to create invoices, receipts, payments, inventory moves, edits, and queries. All saved locally.

When connectivity returns:
```
Local DB → Outbox → Sync Hub → Validation / Claims → Materialization → other devices pull updates
```

### 5.1 Concrete example
Manager's device, offline, creates exit invoice `INV-100` and saves locally. Two hours later the connection returns; the change goes to the Hub. The accountant's device connects and pulls the change — `INV-100` appears.

**No DB file sent. No folder copied.** This is exactly why the manager must never hand over a copy of their installation.

---

## 6. Packaging Parity — "works in dev" means nothing

One of the most dangerous failures in previous desktop builds:

```
Development machine  → everything present, everything works
Customer packaged build → fields disappear
                        → pages crash
                        → fonts / images / print assets missing
                        → errors the developer never saw
```

**Requirement:** the build that is tested before delivery must be **the exact same artifact the customer receives** — not a dev build. Packaging parity must be explicitly verified, including fonts, images, and print assets. **Printing in particular must be tested inside the final packaged build**, because printing has previously worked in dev and failed at the customer.

---

## 7. State Propagation & Consistency (confirmed bug — treat as a formal requirement)

### 7.1 The observed bug
```
Create invoice → save succeeds → open inventory → EMPTY → press Refresh → inventory appears
```

### 7.2 The correct diagnosis
This does **not** mean the database lost the inventory. The data was committed; the inventory view simply never received the new state. This points at **UI state / cache / query invalidation / fetch timing after invoice creation.**

### 7.3 The requirement — do not ship a workaround
Telling the user to "press Refresh" is a workaround, not a fix.

> **Requirement:** After a successful invoice transaction, all affected inventory views and queries must immediately reflect the committed state **without requiring a browser/app refresh.**

This is a **consistency and state-propagation requirement**, not a cosmetic UI improvement. It applies to:

| Action | Required immediate effect |
|--------|---------------------------|
| Entry invoice saved | Inventory increases immediately |
| Exit invoice saved | Inventory decreases immediately |
| Invoice edited | Inventory reflects the edit immediately |
| Invoice cancelled / return | Inventory updates immediately |

**If the database is correct but the screen is stale, that is a FAIL — not a PASS "because Refresh fixed it."**

---

## 8. Performance Requirements (explicit, measurable — not vague goals)

| Stage | Requirement |
|-------|-------------|
| **Installation** | No unexplained 10+ minute installs. Measure every stage and fix the actual cause of any slowness. |
| **First launch** | Initialization must be explicit and measured. |
| **Normal launch** | Seconds — not 3–5 minutes. |
| **Subsequent launches** | Must not re-run full initialization every time. |
| **Uninstall** | Must not hang on processes, the DB, or locked files. |

**Forbidden approaches:** "make it wait longer," "add a retry," "sleep 10 seconds." Find the root cause.

---

## 9. Runtime Robustness

### 9.1 Crash recovery
If the machine loses power mid-operation, on next launch the app must correctly determine PostgreSQL state, backend state, migration state, process ownership, and installation identity — and return to a healthy state.

It must **never** reproduce the old cascade of Postgres → backend → frontend → 100 false API errors. **Surface only the real cause.**

### 9.2 Port conflicts
If another program occupies port `5432`, the app must **not** fail. It must detect the conflict, select a safe port, bind PostgreSQL, bind the backend, and pass the real port through to the frontend. **A second installation must never break the first one.**

---

## 10. Updates — Application Version ≠ Customer Data

You will ship fixes over time. For example, a calculation bug is fixed and released as `v1.0.1` while the customer is on `v1.0.0` with their production database.

After the update:
- The application updates
- **The database stays**
- Company data stays · invoices stay · license stays · users stay

**Absolutely forbidden:** `Delete → Install → start from zero`. The separation between application version and customer data is fundamental.

---

## 11. Full Regression Register — the failures that must not return

These are things that **actually happened** across the previous ten-plus attempts. Each one requires an architectural answer, not a patch.

### 11.1 Desktop layer failures
| Failure | Required architectural answer |
|---------|-------------------------------|
| 10+ minute installation | Measure each stage; fix the real cause |
| 3–5 minute app launch | Startup in seconds; no full re-initialization each run |
| Slow uninstall | Correct cleanup of processes and locked files |
| Port conflicts | Dynamic port management |
| Stale PostgreSQL PID | Correct process lifecycle and recovery |
| Inheriting an old company | Fresh installation identity; isolated DB/company/license |
| Dev works, customer build breaks | Test the packaged artifact itself |
| Fields/resources missing after packaging | Packaging parity verification |
| Printing works in dev, fails at customer | Test printing inside the final build |
| Update destroys the DB | Application ≠ Customer Data |
| Retry/Sleep hiding the real problem | **Banned.** Root cause required |

### 11.2 ERP-side areas that also needed repair
These must be re-verified as part of the desktop work, since desktop failures previously masked them: **FX, statements, ledger, cashbox, inventory, invoice relationships, printing, concurrency.**

---

## 12. Target Architecture

```
                 Vendor
                   │
          External License Dashboard
                   │
             License / Rights
                   │
        ┌──────────┴──────────┐
        │                     │
    Device 1              Device 2
    Manager               Accountant
        │                     │
   Local DB              Local DB
        │                     │
        └──────────┬──────────┘
                   │
               Sync Hub
                   │
        ┌──────────┴──────────┐
        │                     │
    Device 3              Device 4
   Warehouse              Manager PC
```

**The ERP remains one system.** The desktop layer is simply what makes that ERP run as a real Windows application: standalone, multi-device, offline/online capable, updatable, and recoverable.

---

## 13. Execution Plan

**Phase 1 — Audit before building.**
Verify the existing foundation: database schema and relationships, migrations (clean run from empty), tenant/installation/license/company separation, the external License Dashboard integration (**confirm it is genuinely connected and correct**), API contracts, transaction boundaries, and the cache-invalidation map. **Do the audit first, but do not stop after the report. Once the foundation is verified, continue automatically through all remai**

**Phase 2 — Root-cause analysis of the recurring failures.**
For each item in Section 11, state the actual root cause and the architectural mechanism that will prevent recurrence. Identify which failures share a single root cause.

**Phase 3 — Desktop Runtime layer.**
Process lifecycle, DB bootstrap, dynamic ports, resource preparation, crash recovery, startup sequencing — cleanly separated from ERP business logic.

**Phase 4 — Identity & licensing.**
License validation, installation identity, device binding, company setup, manager account, invitations and roles, device limits, manager notifications on join.

**Phase 5 — Offline-first sync.**
Local DB, outbox, Sync Hub, validation/claims, materialization, conflict handling, multi-device convergence.

**Phase 6 — State propagation.**
Implement and prove Section 7 across every document type and every dependent view.

**Phase 7 — Packaging, performance, updates.**
Single installer, packaging parity, measured performance targets, Windows auto-start, update path preserving customer data, clean uninstall.

**Phase 8 — Verification on the packaged artifact.**
Every test re-run against the exact build the customer will receive — including printing — on a clean machine with no developer tooling installed.

---

## 14. What I expect from you

- **Start with Phase 1, then continue through all phases automatically..**
- Tell me which of the recurring failures share a common root cause.
- Ask me to decide any ambiguous business rule instead of guessing.
- Work in small, reviewable batches with tests.
- For every item, state explicitly: **PROVEN** or **NOT PROVEN**. Never overstate completion.
- If you ever find yourself about to add a sleep, a retry, or a "just refresh" instruction — **stop and report the real cause instead.** That instinct is precisely what produced ten failed versions.