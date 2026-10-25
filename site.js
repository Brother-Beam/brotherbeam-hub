/*
 * ONE file to rename the company. Every page reads from here.
 * Swap the bracketed placeholders; nothing else needs to change.
 */
window.SITE = {
  name: "NEWCO",                       // short name: top bar, tab titles
  fullName: "NewCo Advisory",          // long name: footers, the gate
  tagline: "Business architecture, with AI built in.",
  what: "We map how a business actually runs, redesign the parts that leak value, and implement the AI that makes the new design work. Then we run the change with the same operating system we use ourselves.",
  password: "newco",                   // roadmap + Work Station gate (lowercase; the gate ignores case)
  hubUrl: "",                          // the Vercel URL once deployed, e.g. https://newco-hub.vercel.app
  people: [
    { name: "Pat Fitzgerald", role: "Founder", focus: "Business transformation: matching market dynamics to new technology. Built in the mortgage industry, now doing the same at TaylorMade.", email: "" },
    { name: "Mike FitzGerald", role: "Co-founder", focus: "Operating systems for a business: the hub, the cadence, and AI implementation inside real workflows. Physician and clinic operator.", email: "" },
    { name: "[Friend]", role: "Co-founder", focus: "[What they bring]", email: "" }
  ],
  pillars: [
    { t: "Business architecture", d: "Map the business as it really works: capabilities, processes, systems, data, decisions and money. Find where value leaks and where it is trapped." },
    { t: "AI implementation", d: "Put AI where the map says it pays, one workflow at a time, with the data, guardrails and training that make it stick." },
    { t: "Transformation programs", d: "Run the change: a roadmap with owners, a Work Station for what is due now, a weekly cadence, and measurement that shows it worked." }
  ],
  links: {
    drive: "",      // shared Google Drive folder
    calendar: "",   // shared calendar
    docs: ""        // proposals and templates
  }
};
