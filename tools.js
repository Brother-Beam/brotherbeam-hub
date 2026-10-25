/*
 * Hub inventory: single source of truth for what exists and where it lives.
 * Same schema as the GWC hub, so the two can share tooling.
 *
 *   id          kebab-case unique slug
 *   name        display name
 *   description one line
 *   capability  "delivery" | "sales" | "operations" | "finance" | "brand" | "strategy" | "enablers"
 *   kind        "tool" | "document" | "partnership" | "initiative" | "policy" | "decision" | "person"
 *   status      "live" | "reference" | "in-flight"
 *   audience    any of ["founders","team","client"]
 *   url         full URL the card opens, or "" until it exists
 *   source      "claude" | "manual" | "other"
 */
window.INVENTORY = [
  { id: "roadmap", name: "Roadmap & Work Station", description: "Where the company is going, who owns what, and the shared checklist of what is due now.", capability: "strategy", kind: "tool", status: "live", audience: ["founders"], url: "roadmap.html", source: "claude" },
  { id: "operating-model", name: "Operating model", description: "How we run engagements: the architecture map, the AI implementation playbook, the transformation cadence.", capability: "delivery", kind: "document", status: "in-flight", audience: ["founders","team"], url: "", source: "claude" },
  { id: "offer", name: "Offer & pricing", description: "What we sell, in what packages, at what price, and how an engagement is scoped.", capability: "sales", kind: "document", status: "in-flight", audience: ["founders"], url: "", source: "claude" },
  { id: "proposal-desk", name: "Proposal desk", description: "Quote and proposal builder: scope, team, timeline, price, terms.", capability: "sales", kind: "tool", status: "in-flight", audience: ["founders","team"], url: "", source: "claude" },
  { id: "client-hub-template", name: "Client hub template", description: "The per-client workspace we stand up on day one: roadmap, Work Station, decisions log, measurement.", capability: "delivery", kind: "tool", status: "in-flight", audience: ["founders","team","client"], url: "", source: "claude" },
  { id: "drive", name: "Shared drive", description: "Contracts, proposals, templates and client folders.", capability: "enablers", kind: "tool", status: "reference", audience: ["founders","team"], url: "", source: "manual" }
];
