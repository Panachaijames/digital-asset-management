// dwp Global DAM — preset tag library, grouped by facet.
// Shown under the Tags field on the upload page; clicking a preset toggles it
// into the batch tags. Values are stored through the same normalizeTags path
// as typed tags (lower-cased, de-duplicated) on upload.

export interface TagPresetGroup {
  group: string;
  tags: string[];
}

export const TAG_PRESETS: TagPresetGroup[] = [
  {
    group: "Macro Portfolio",
    tags: ["Lifestyle", "Workplace", "Community"],
  },
  {
    group: "Staff & Culture",
    tags: ["Role Seniority", "Function / Group", "Portrait Style Variant"],
  },
  {
    group: "Brand Activation",
    tags: ["Event Typology", "Social Content Format"],
  },
  {
    group: "Location Matrix",
    tags: ["Global Region", "Studio Hub (Jurisdiction)", "Climate / Setting Context"],
  },
  {
    group: "Project Excellence",
    tags: ["Global Flagship", "Award Winner", "Press Featured"],
  },
  {
    group: "Sustainability & Wellness",
    tags: ["Biophilic Design", "Net-Zero Carbon", "Institutional Standard"],
  },
  {
    group: "Digital Innovation",
    tags: ["AI-Accelerated Workflow", "Advanced 3D Visualisation", "Smart Building"],
  },
  {
    group: "Marketing Performance",
    tags: ["Top Social Performer", "Executive Approved"],
  },
  {
    group: "Project Reference",
    tags: ["Project Status", "Lead Studio", "Scope of Work"],
  },
  {
    group: "Video & Motion",
    tags: ["Motion Format", "Master / Derivative", "Audio & Language", "Drone Compliance"],
  },
  {
    group: "Rights & Licensing",
    tags: ["Licence Type", "Confidentiality Status", "Consent / Releases", "Territory Restrictions"],
  },
  {
    group: "Asset Lifecycle",
    tags: [
      "Draft",
      "In Review",
      "Approved",
      "Published",
      "Superseded",
      "Expired",
      "Archived",
      "Version Numbering",
      "Review Cadence",
    ],
  },
  {
    group: "AI Provenance",
    tags: [
      "Digital Source Type",
      "AI System Used",
      "Prompt on File",
      "Content Credentials",
      "Disclosure Clearance",
    ],
  },
];
