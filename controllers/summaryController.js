import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import Summary from "../models/Summary.js";

const prompt= "You are an AI meeting assistant.Summarize the following meeting transcript.Highlight key points and action items"


const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ===============================
   Upload audio to AssemblyAI
================================ */
const uploadAudioToAssemblyAI = async (filePath) => {
  const buffer = fs.readFileSync(filePath);

  const res = await fetch("https://api.assemblyai.com/v2/upload", {
    method: "POST",
    headers: {
      Authorization: process.env.ASSEMBLYAI_API_KEY,
      "Content-Type": "application/octet-stream",
    },
    body: buffer,
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error("Upload failed: " + txt);
  }

  const data = await res.json();
  return data.upload_url;
};

/* ===============================
   Transcribe + Summarize
================================ */
const transcribeAndSummarize = async (audioUrl) => {
  const submitRes = await fetch("https://api.assemblyai.com/v2/transcript", {
    method: "POST",
    headers: {
      Authorization: process.env.ASSEMBLYAI_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      audio_url: audioUrl,
      summarization: true,
      summary_model: "informative",
      summary_type: "bullets",
    }),
  });

  if (!submitRes.ok) {
    const txt = await submitRes.text();
    throw new Error("Transcription submission failed: " + txt);
  }

  let transcript = await submitRes.json();

  while (["queued", "processing"].includes(transcript.status)) {
    await sleep(2000);

    const pollRes = await fetch(
      `https://api.assemblyai.com/v2/transcript/${transcript.id}`,
      {
        headers: {
          Authorization: process.env.ASSEMBLYAI_API_KEY,
        },
      }
    );

    transcript = await pollRes.json();
  }

  if (transcript.status === "error") {
    throw new Error(transcript.error);
  }

  return {
    transcript: transcript.text || "",
    summary: transcript.summary || "Summary not available.",
  };
};

/* ===============================
   CREATE SUMMARY
================================ */
export const createSummary = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No audio file uploaded" });
    }

    if (!req.user) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const uploadsDir = path.join(process.cwd(), "uploads");
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

    const filename = `audio-${Date.now()}.webm`;
    const filePath = path.join(uploadsDir, filename);
    fs.writeFileSync(filePath, req.file.buffer);

    console.log("Uploading audio...");
    const audioUrl = await uploadAudioToAssemblyAI(filePath);

    console.log("Transcribing + summarizing...");
    const { transcript, summary } = await transcribeAndSummarize(audioUrl);

    const participants = [req.user._id];

    const record = new Summary({
      roomId: req.body.roomId || "unknown",
      participants,
      transcript,
      prompt,
      summary,
      audioUrl: `/uploads/${filename}`,
    });

    await record.save();

    res.json({
      id: record._id,
      transcript: record.transcript,
      summary: record.summary,
      audioUrl: record.audioUrl,
    });
  } catch (err) {
    console.error("Summary error:", err);
    res.status(500).json({
      message: "Failed to process audio: " + err.message,
    });
  }
};

/* ===============================
   GET SUMMARIES
================================ */
export const getSummaries = async (req, res) => {
  try {
    const data = await Summary.find({
      participants: req.user._id,
    }).sort({ createdAt: -1 });

    res.json(data);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch summaries" });
  }
};

/* ===============================
   DELETE SUMMARY
================================ */
export const deleteSummary = async (req, res) => {
  try {
    const record = await Summary.findById(req.params.id);
    if (!record) {
      return res.status(404).json({ message: "Summary not found" });
    }

    if (!record.participants.includes(req.user._id)) {
      return res.status(403).json({ message: "Unauthorized" });
    }

    if (record.audioUrl) {
      const fp = path.join(process.cwd(), record.audioUrl.replace("/", ""));
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }

    await record.deleteOne();
    res.json({ message: "Summary deleted" });
  } catch (err) {
    res.status(500).json({ message: "Delete failed" });
  }
};
