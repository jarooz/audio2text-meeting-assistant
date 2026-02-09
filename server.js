import express from "express";
import multer from "multer";
import OpenAI, { toFile } from "openai";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const port = process.env.PORT || 3000;
const apiKey = process.env.OPENAI_API_KEY;

if (!apiKey) {
  console.error("Missing OPENAI_API_KEY in environment.");
}

const openai = new OpenAI({ apiKey });

const localeToLanguageCode = {
  auto: undefined,
  en: "en",
  "en-IN": "en",
  ta: "ta",
  tanglish: "ta",
  hi: "hi",
  kn: "kn",
  ml: "ml",
  te: "te",
  mr: "mr",
  gu: "gu",
  bn: "bn",
  pa: "pa",
  or: "or",
  as: "as",
};

app.use(express.json({ limit: "2mb" }));
app.use(express.static(__dirname));

app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: "Server is missing OPENAI_API_KEY." });
  }

  if (!req.file) {
    return res.status(400).json({ error: "Audio file is required." });
  }

  try {
    const selectedLanguage = req.body.language || "auto";
    const language = localeToLanguageCode[selectedLanguage] || undefined;

    const transcription = await openai.audio.transcriptions.create({
      model: "gpt-4o-mini-transcribe",
      file: await toFile(req.file.buffer, req.file.originalname || "audio.webm"),
      ...(language ? { language } : {}),
      prompt:
        selectedLanguage === "tanglish"
          ? "This audio may include code-switched Tamil and English (Tanglish). Preserve both naturally."
          : undefined,
    });

    const rawTranscript = transcription.text || "";

    const formatted = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content:
            "You format transcripts into detailed, well-structured Markdown without losing content fidelity.",
        },
        {
          role: "user",
          content:
            "Convert this transcript into detailed Markdown. " +
            "Output must be factual and based only on the transcript. " +
            "Use these sections exactly: " +
            "# Transcript, ## Metadata, ## Structured Transcript, ## Key Topics Mentioned, ## Clarifications Needed. " +
            "In Metadata include language and a note that speaker labels are inferred when uncertain. " +
            "In Structured Transcript, break into logical turns as bullet points; use **Speaker 1**, **Speaker 2** only when a speaker change is obvious, otherwise use **Speaker (unidentified)**. " +
            "Do not invent timestamps or names. " +
            `Language preference: ${selectedLanguage}. ` +
            `Raw transcript:\n${rawTranscript}`,
        },
      ],
    });

    return res.json({ transcript: formatted.output_text?.trim() || rawTranscript });
  } catch (error) {
    return res.status(500).json({
      error: error?.message || "Failed to transcribe audio.",
    });
  }
});

app.post("/api/analyze", async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: "Server is missing OPENAI_API_KEY." });
  }

  const transcript = req.body?.transcript?.trim();
  const language = req.body?.language || "auto";

  if (!transcript) {
    return res.status(400).json({ error: "Transcript is required." });
  }

  try {
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content:
            "You produce detailed, professional Markdown meeting documentation for business users.",
        },
        {
          role: "user",
          content:
            `Language preference: ${language}. ` +
            "Return valid JSON only with keys: summary, minutes. " +
            "Both summary and minutes must be fully formatted Markdown and highly detailed. " +
            "summary format requirements: " +
            "# Meeting Summary, ## Executive Overview, ## Business Context, ## Detailed Highlights, ## Risks and Dependencies, ## Next-step Focus. " +
            "Use rich bullet points with concrete details and references to transcript content. " +
            "minutes format requirements: " +
            "# Meeting Minutes, ## Meeting Context, ## Agenda Covered, ## Detailed Discussion Log, ## Decisions Made, ## Action Items, ## Open Questions, ## Follow-up Plan. " +
            "For Action Items include a Markdown table with columns: Item, Owner, Due Date, Priority, Status. " +
            "If owner or due date is missing, write Unknown. " +
            "Do not hallucinate facts; if missing, explicitly state Unknown or Not specified. " +
            `Transcript:\n${transcript}`,
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "meeting_outputs",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              summary: { type: "string" },
              minutes: { type: "string" },
            },
            required: ["summary", "minutes"],
          },
        },
      },
    });

    const parsed = JSON.parse(response.output_text || "{}");
    return res.json({
      summary: parsed.summary || "No summary generated.",
      minutes: parsed.minutes || "No minutes generated.",
    });
  } catch (error) {
    return res.status(500).json({
      error: error?.message || "Failed to generate summary and minutes.",
    });
  }
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
