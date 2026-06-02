# 10 — Decisions Needed From You / The Boss

[← Phased plan](09-phased-plan.md) · [Index](README.md) · [Next: Risks & next steps →](11-risks-next-steps.md)

---

These shape scope, cost, and timeline. Please answer each.

### Q1. Online payments — in or out of scope?
Right now deposits are shown but not *collected* online. Do you want real payment collection (card/Fawry/etc.) in this build, or do agencies keep settling payment off-platform for now? *(Adds significant scope and compliance if in.)*

**Your answer:**

---

### Q2. Database choice
We recommend **PostgreSQL** for reliability. Agree, or do you have a hosting/database preference already?

**Your answer:**

---

### Q3. Hosting
Do you have a preferred host/cloud (AWS, a VPS, Railway/Render, etc.), or should we recommend and set one up?

**Your answer:**

---

### Q4. Email provider
Any existing email service or domain you must use? Otherwise we'll recommend one and configure your sending domain.

**Your answer:**

---

### Q5. Languages
English only for launch, or do we need **Arabic / right-to-left** support? *(Best decided now — retrofitting later is costly.)*

**Your answer:**

---

### Q6. Agency onboarding
How does a new agency get in? Self-signup with your approval, or only your team creates agency accounts? This changes the signup flow.

**Your answer:**

---

### Q7. Roles
Are the roles in file [06](06-accounts-roles.md) (Super Admin, Ops Staff / Agency Owner, Agency Agent) right, or do you need more granularity (e.g. finance-only, read-only)?

**Your answer:**

---

### Q8. Customer accounts
Should **direct travellers** (public site) also get accounts and login, or stay as one-off guest bookings like today?

**Your answer:**

---

### Q9. Scale expectation
Rough number of agencies, workers, and bookings/month at launch and in year one? This informs hosting size and a few design choices.

**Your answer:**

---

### Q10. Compliance
Any data-protection or tourism-authority requirements we must meet (data residency, invoicing rules, etc.)?

**Your answer:**
