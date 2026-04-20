/**
 * Writes out/michael_samuel_cv.pdf using pdfkit (no LibreOffice).
 * Content mirrors data/resume.txt; layout is simple text (not identical to the DOCX styling).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const resumePath = path.join(root, "data", "resume.txt");
const outPath = path.join(root, "out", "michael_samuel_cv.pdf");

function parseResume(content) {
  const blocks = content.split(/\n\n+/).map((b) => b.trim()).filter(Boolean);
  const data = {
    title: "",
    summary: "",
    skills: "",
    experience: [],
  };

  for (const block of blocks) {
    const lines = block.split("\n");
    const section = lines[0].trim().toUpperCase();
    const body = lines.slice(1).join("\n").trim();

    if (section === "TITLE") data.title = body;
    else if (section === "SUMMARY") data.summary = body;
    else if (section === "SKILLS") data.skills = body.replace(/\s+/g, " ");
    else if (section === "EXPERIENCE") {
      for (const line of body.split("\n")) {
        const t = line.trim();
        if (t.startsWith("-")) data.experience.push(t.replace(/^-\s*/, "").trim());
        else if (t) data.experience.push(t);
      }
    }
  }

  return data;
}

async function main() {
  if (!fs.existsSync(resumePath)) {
    throw new Error(`Missing ${resumePath}`);
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const resume = parseResume(fs.readFileSync(resumePath, "utf8"));
  const doc = new PDFDocument({ margin: 56, size: "LETTER" });
  const stream = fs.createWriteStream(outPath);
  doc.pipe(stream);

  doc.font("Helvetica-Bold").fontSize(18).text(resume.title || "Resume", { paragraphGap: 6 });
  doc.font("Helvetica").fontSize(11);

  if (resume.summary) {
    doc.moveDown(0.75).font("Helvetica-Bold").text("Summary");
    doc.font("Helvetica").text(resume.summary, { paragraphGap: 6 });
  }
  if (resume.skills) {
    doc.moveDown(0.5).font("Helvetica-Bold").text("Skills");
    doc.font("Helvetica").text(resume.skills, { paragraphGap: 6 });
  }
  if (resume.experience.length) {
    doc.moveDown(0.5).font("Helvetica-Bold").text("Experience");
    for (const line of resume.experience) {
      doc.font("Helvetica").text(`• ${line}`, { indent: 10, paragraphGap: 4 });
    }
  }

  doc.moveDown(2);
  doc.font("Helvetica-Oblique").fontSize(7).fillColor("#666666").text("PDF via pdfkit (plain layout).", {
    align: "left",
  });

  doc.end();

  await new Promise((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
  });

  console.log(`Wrote ${outPath} (pdfkit fallback).`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
