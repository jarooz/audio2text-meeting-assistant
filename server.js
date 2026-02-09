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

    return res.json({ transcript: transcription.text || "" });
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
            "You turn meeting transcripts into concise summaries and actionable minutes for business users.",
        },
        {
          role: "user",
          content:
            `Language preference: ${language}. ` +
            "Return valid JSON only with keys: summary, minutes. " +
            "summary: a concise 5-8 bullet summary. " +
            "minutes: markdown sections for Agenda, Key Discussion Points, Decisions, Action Items (with owner and due date if present), Open Questions. " +
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
