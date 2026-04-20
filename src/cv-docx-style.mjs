/**
 * Styled CV layout (Arial, accent colors, section rules, numbered bullets, job blocks).
 * Mirrors the structure of the user's reference docx.js template.
 */
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  LevelFormat,
  Packer,
  Paragraph,
  TabStopType,
  TextRun,
} from "docx";

const BLACK = "111111";
const GRAY = "555555";
const ACCENT = "1A5276";

function splitNameSubtitle(title) {
  const t = (title || "").trim();
  const sep = /\s+[—–-]\s+|\s+\|\s+/;
  const bits = t.split(sep);
  return {
    name: bits[0]?.trim() || t || "Name",
    subtitle: bits.slice(1).join(" | ").trim(),
  };
}

function hr(color = "AAAAAA", size = 4) {
  return new Paragraph({
    border: { bottom: { style: BorderStyle.SINGLE, size, color, space: 1 } },
    spacing: { before: 80, after: 80 },
  });
}

function sectionHeader(text) {
  return [
    new Paragraph({
      spacing: { before: 200, after: 60 },
      children: [
        new TextRun({
          text: text.toUpperCase(),
          bold: true,
          size: 20,
          color: ACCENT,
          font: "Arial",
        }),
      ],
    }),
    hr(),
  ];
}

function bullet(text) {
  return new Paragraph({
    numbering: { reference: "bullets", level: 0 },
    spacing: { after: 70 },
    children: [new TextRun({ text, size: 19, font: "Arial", color: BLACK })],
  });
}

function labelLine(label, value) {
  return new Paragraph({
    spacing: { after: 65 },
    children: [
      new TextRun({ text: `${label}: `, bold: true, size: 19, font: "Arial", color: BLACK }),
      new TextRun({ text: value, size: 19, font: "Arial", color: BLACK }),
    ],
  });
}

function jobBlock(title, company, period) {
  return [
    new Paragraph({
      tabStops: [{ type: TabStopType.RIGHT, position: 9360 }],
      spacing: { before: 180, after: 10 },
      children: [
        new TextRun({ text: title, bold: true, size: 20, font: "Arial", color: BLACK }),
        new TextRun({ text: `\t${period}`, size: 18, font: "Arial", color: GRAY }),
      ],
    }),
    new Paragraph({
      spacing: { after: 90 },
      children: [
        new TextRun({
          text: company,
          size: 18,
          font: "Arial",
          color: ACCENT,
          italics: true,
        }),
      ],
    }),
  ];
}

function linkRuns(links) {
  if (!links || links.length === 0) return [];
  const children = [];
  for (let i = 0; i < links.length; i++) {
    const { text, url } = links[i];
    if (i > 0) {
      children.push(new TextRun({ text: "  ·  ", size: 18, font: "Arial", color: GRAY }));
    }
    children.push(
      new ExternalHyperlink({
        link: url,
        children: [
          new TextRun({ text, size: 18, font: "Arial", color: ACCENT, underline: {} }),
        ],
      }),
    );
  }
  return [
    new Paragraph({
      spacing: { after: 10 },
      children,
    }),
  ];
}

/** Split "Label: value" lines into rows; continuation lines append to previous value. */
function coreSkillsRowsFromText(skillsText) {
  const skills = String(skillsText || "").trim();
  if (!skills) return [{ label: "Skills", value: "—" }];
  const lines = skills.split(/\n/).map((l) => l.trim()).filter(Boolean);
  const rows = [];
  for (const line of lines) {
    const m = line.match(/^([^:]+):\s*(.+)$/);
    if (m) rows.push({ label: m[1].trim(), value: m[2].trim() });
    else if (rows.length) rows[rows.length - 1].value += ` ${line}`;
    else rows.push({ label: "Skills", value: line });
  }
  return rows.length ? rows : [{ label: "Skills", value: skills.replace(/\s+/g, " ") }];
}

/**
 * @param {{
 *   title: string,
 *   summary: string,
 *   skills: string,
 *   experience: string[],
 *   contact_line?: string,
 *   links?: { text: string, url: string }[],
 *   core_skills?: { label: string, value: string }[],
 *   jobs?: { title: string, company: string, period: string, bullets: string[] }[],
 *   featured_project?: Record<string, unknown> | null,
 *   technical_tooling?: { label: string, value: string }[],
 *   education?: { degree_line: string, bullets: string[] } | null,
 * }} resume
 * @param {string} tailoringParagraph
 */
export function profileFromParsedResume(resume, tailoringParagraph) {
  const { name, subtitle } = splitNameSubtitle(resume.title || "Resume");
  const core_skills = Array.isArray(resume.core_skills) && resume.core_skills.length
    ? resume.core_skills
    : coreSkillsRowsFromText(resume.skills);

  let jobs;
  if (Array.isArray(resume.jobs) && resume.jobs.length > 0) {
    jobs = resume.jobs.map((j) => ({
      title: String(j?.title || "").trim() || "Role",
      company: String(j?.company || "").trim(),
      period: String(j?.period || "").trim(),
      bullets: Array.isArray(j?.bullets) ? j.bullets.map((b) => String(b).trim()).filter(Boolean) : [],
    }));
  } else {
    jobs = [
      {
        title: "Professional Experience",
        company: "",
        period: "",
        bullets: resume.experience.length ? resume.experience : ["—"],
      },
    ];
  }

  const technical_tooling = Array.isArray(resume.technical_tooling) && resume.technical_tooling.length
    ? resume.technical_tooling
    : [];

  return {
    name,
    subtitle,
    contact_line: String(resume.contact_line || "").trim(),
    links: Array.isArray(resume.links) ? resume.links : [],
    professional_summary: (resume.summary || "").trim() || "—",
    core_skills,
    featured_project: resume.featured_project && typeof resume.featured_project === "object" ? resume.featured_project : null,
    jobs,
    technical_tooling,
    education: resume.education && typeof resume.education === "object" ? resume.education : null,
    role_fit: (tailoringParagraph || "").trim(),
  };
}

/** Maps compact AI JSON (title/summary/skills/experience/role_fit) into a styled profile. */
export function profileFromLegacyAi(ai) {
  const { name, subtitle } = splitNameSubtitle(ai.title || "");
  return {
    name,
    subtitle,
    contact_line: String(ai.contact_line || "").trim(),
    links: Array.isArray(ai.links) ? ai.links : [],
    professional_summary: String(ai.summary || "").trim() || "—",
    core_skills: Array.isArray(ai.core_skills)
      ? ai.core_skills
      : [{ label: "Skills", value: String(ai.skills || "").trim() || "—" }],
    featured_project: ai.featured_project || null,
    jobs: Array.isArray(ai.jobs) && ai.jobs.length
      ? ai.jobs
      : [
          {
            title: "Experience",
            company: "",
            period: "",
            bullets: Array.isArray(ai.experience) && ai.experience.length ? ai.experience : ["—"],
          },
        ],
    technical_tooling: Array.isArray(ai.technical_tooling) ? ai.technical_tooling : [],
    education: ai.education || null,
    role_fit: String(ai.role_fit || "").trim(),
  };
}

/** @param {Record<string, unknown>} profile */
export function buildStyledCvDocument(profile) {
  const p = profile;
  const name = String(p.name || "").trim() || "Name";
  const subtitle = String(p.subtitle || "").trim();
  const contact_line = String(p.contact_line || "").trim();
  const links = Array.isArray(p.links) ? p.links : [];
  const professional_summary = String(p.professional_summary || "").trim() || "—";
  const core_skills = Array.isArray(p.core_skills) ? p.core_skills : [];
  const featured_project = p.featured_project && typeof p.featured_project === "object" ? p.featured_project : null;
  const jobs = Array.isArray(p.jobs) && p.jobs.length ? p.jobs : [];
  const technical_tooling = Array.isArray(p.technical_tooling) ? p.technical_tooling : [];
  const education = p.education && typeof p.education === "object" ? p.education : null;
  const role_fit = String(p.role_fit || "").trim();

  const children = [
    new Paragraph({
      spacing: { after: 40 },
      children: [new TextRun({ text: name, bold: true, size: 48, font: "Arial", color: BLACK })],
    }),
  ];

  if (subtitle) {
    children.push(
      new Paragraph({
        spacing: { after: 40 },
        children: [
          new TextRun({
            text: subtitle,
            bold: true,
            size: 22,
            font: "Arial",
            color: ACCENT,
          }),
        ],
      }),
    );
  }

  if (contact_line) {
    children.push(
      new Paragraph({
        spacing: { after: 30 },
        children: [new TextRun({ text: contact_line, size: 18, font: "Arial", color: GRAY })],
      }),
    );
  }

  children.push(...linkRuns(links));
  children.push(hr(ACCENT, 6));

  children.push(
    ...sectionHeader("Professional Summary"),
    new Paragraph({
      spacing: { after: 60 },
      children: [
        new TextRun({
          text: professional_summary,
          size: 19,
          font: "Arial",
          color: BLACK,
        }),
      ],
    }),
  );

  if (role_fit) {
    children.push(
      new Paragraph({
        spacing: { after: 60 },
        children: [
          new TextRun({ text: "Role fit: ", bold: true, size: 19, font: "Arial", color: BLACK }),
          new TextRun({ text: role_fit, size: 19, font: "Arial", color: GRAY, italics: true }),
        ],
      }),
    );
  }

  children.push(...sectionHeader("Core Skills"));
  for (const row of core_skills) {
    const label = String(row?.label || "Skills").trim();
    const value = String(row?.value || "—").trim();
    children.push(labelLine(label, value));
  }
  children.push(new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: "" })] }));

  if (featured_project) {
    const fpTitle = String(featured_project.title || "").trim();
    const fpUrl = String(featured_project.url || featured_project.play_url || "").trim();
    const fpUrlLabel = String(featured_project.url_label || featured_project.play_link_text || "Link").trim();
    const fpDesc = String(featured_project.description || "").trim();
    if (fpTitle || fpDesc) {
      children.push(...sectionHeader("Featured Project"));
      const titleChildren = [
        new TextRun({
          text: fpTitle ? `${fpTitle}  ·  ` : "",
          bold: true,
          size: 19,
          font: "Arial",
          color: BLACK,
        }),
      ];
      if (fpUrl) {
        titleChildren.push(
          new ExternalHyperlink({
            link: fpUrl,
            children: [
              new TextRun({
                text: fpUrlLabel,
                size: 19,
                font: "Arial",
                color: ACCENT,
                underline: {},
              }),
            ],
          }),
        );
      }
      children.push(
        new Paragraph({ spacing: { after: 40 }, children: titleChildren }),
        new Paragraph({
          spacing: { after: 60 },
          children: [
            new TextRun({
              text: fpDesc || "—",
              size: 19,
              font: "Arial",
              color: BLACK,
            }),
          ],
        }),
      );
    }
  }

  children.push(...sectionHeader("Professional Experience"));
  for (const job of jobs) {
    const jt = String(job?.title || "").trim() || "Role";
    const jc = String(job?.company || "").trim();
    const jp = String(job?.period || "").trim();
    const bullets = Array.isArray(job?.bullets) ? job.bullets.map((b) => String(b).trim()).filter(Boolean) : [];
    children.push(...jobBlock(jt, jc, jp));
    for (const b of bullets) {
      children.push(bullet(b));
    }
    children.push(new Paragraph({ spacing: { after: 50 }, children: [new TextRun({ text: "" })] }));
  }

  if (technical_tooling.length) {
    children.push(...sectionHeader("Technical Tooling"));
    for (const row of technical_tooling) {
      const label = String(row?.label || "").trim();
      const value = String(row?.value || "").trim();
      if (label) children.push(labelLine(label, value || "—"));
    }
    children.push(new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: "" })] }));
  }

  if (education) {
    const degreeLine = String(education.degree_line || "").trim();
    const eduBullets = Array.isArray(education.bullets)
      ? education.bullets.map((b) => String(b).trim()).filter(Boolean)
      : [];
    if (degreeLine || eduBullets.length) {
      children.push(...sectionHeader("Education & Certifications"));
      if (degreeLine) {
        children.push(
          new Paragraph({
            spacing: { after: 50 },
            children: [
              new TextRun({
                text: degreeLine,
                bold: true,
                size: 19,
                font: "Arial",
                color: BLACK,
              }),
            ],
          }),
        );
      }
      for (const b of eduBullets) {
        children.push(bullet(b));
      }
    }
  }

  return new Document({
    numbering: {
      config: [
        {
          reference: "bullets",
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: "•",
              alignment: AlignmentType.LEFT,
              style: {
                paragraph: {
                  indent: { left: 400, hanging: 200 },
                },
              },
            },
          ],
        },
      ],
    },
    styles: {
      default: {
        document: {
          run: { font: "Arial", size: 19 },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 12240, height: 15840 },
            margin: { top: 900, right: 960, bottom: 900, left: 960 },
          },
        },
        children,
      },
    ],
  });
}

export async function createStyledCvDocumentBuffer(profile) {
  const doc = buildStyledCvDocument(profile);
  return Packer.toBuffer(doc);
}
