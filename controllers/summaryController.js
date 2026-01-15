import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import Summary from '../models/Summary.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Upload audio file to AssemblyAI
const uploadAudioToAssemblyAI = async (filePath) => {
  try {
    const fileStream = fs.createReadStream(filePath);
    const fileBuffer = fs.readFileSync(filePath);
    
    const uploadRes = await fetch('https://api.assemblyai.com/v2/upload', {
      method: 'POST',
      headers: {
        Authorization: process.env.ASSEMBLYAI_API_KEY,
      },
      body: fileBuffer,
    });

    if (!uploadRes.ok) {
      const txt = await uploadRes.text().catch(() => uploadRes.statusText);
      throw new Error(`Upload failed: ${txt}`);
    }

    const data = await uploadRes.json();
    return data.upload_url;
  } catch (err) {
    console.error('Audio upload failed:', err.message);
    throw err;
  }
};

// Transcribe and summarize with AssemblyAI
const transcribeAndSummarizeWithAssemblyAI = async (audioUrl, attempts = 3) => {
  for (let i = 0; i < attempts; i++) {
    try {
      // Submit transcription job with summarization
      const submitRes = await fetch('https://api.assemblyai.com/v2/transcript', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: process.env.ASSEMBLYAI_API_KEY,
        },
        body: JSON.stringify({
          audio_url: audioUrl,
          summarization: true,
          summary_model: 'informative',
          summary_type: 'bullets',
          
  summary_guidance: `
  Create a professional meeting summary.
  Focus on:
  - Key discussion points
  - Decisions made
  - Problems mentioned
  - Next action items
  Keep it short and clear.
  `,
        }),
      });

      if (!submitRes.ok) {
        const txt = await submitRes.text().catch(() => submitRes.statusText);
        throw new Error(`Transcription submission failed: ${txt}`);
      }

      const jobData = await submitRes.json();
      const transcriptId = jobData.id;

      // Poll for completion
      let transcript = jobData;
      while (transcript.status === 'queued' || transcript.status === 'processing') {
        await sleep(2000); // Wait 2 seconds before polling

        const pollRes = await fetch(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
          method: 'GET',
          headers: {
            Authorization: process.env.ASSEMBLYAI_API_KEY,
          },
        });

        if (!pollRes.ok) {
          const txt = await pollRes.text().catch(() => pollRes.statusText);
          throw new Error(`Polling failed: ${txt}`);
        }

        transcript = await pollRes.json();
      }

      if (transcript.status === 'error') {
        throw new Error(`Transcription error: ${transcript.error}`);
      }

      return {
        text: transcript.text || '',
        summary: transcript.summary || '',
      };
    } catch (err) {
      console.warn(`Transcription attempt ${i + 1} failed:`, err.message);
      if (i < attempts - 1) await sleep(1000 * (i + 1));
      else throw err;
    }
  }
};

export const createSummary = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No audio file uploaded' });
    if (!req.user) return res.status(401).json({ message: 'Unauthorized' });

    if (req.file.size && req.file.size > 100 * 1024 * 1024) {
      return res.status(400).json({ message: 'File too large (max 100MB)' });
    }

    // Save file to uploads with a timestamped filename
    const uploadsDir = path.join(process.cwd(), 'uploads');
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
    const filename = `audio-${Date.now()}.webm`;
    const filePath = path.join(uploadsDir, filename);
    fs.writeFileSync(filePath, req.file.buffer);

    // Upload to AssemblyAI and get URL
    console.log('Uploading audio to AssemblyAI...');
    const audioUrl = await uploadAudioToAssemblyAI(filePath);
    console.log('Audio uploaded successfully:', audioUrl);

    // Transcribe and summarize using AssemblyAI
    console.log('Processing with AssemblyAI (transcription + summarization)...');
    const { text: transcript, summary } = await transcribeAndSummarizeWithAssemblyAI(audioUrl);

    let summaryText = summary || 'Summary not available.';
    if (!summaryText || summaryText.trim() === '') {
      summaryText = 'Summary not available.';
    }

    // Parse participants
    let participants = [req.user._id];
    try {
      if (req.body.participants) {
        const p = typeof req.body.participants === 'string' ? JSON.parse(req.body.participants) : req.body.participants;
        participants = Array.from(new Set([...participants, ...p]));
      }
    } catch (e) {
      // ignore parse errors
    }

    // Save summary
    const record = new Summary({
      roomId: req.body.roomId || 'unknown',
      participants,
      transcript: transcript || 'Transcript not available.',
      summary: summaryText,
      audioUrl: `/uploads/${filename}`,
    });
    await record.save();

    res.json({ id: record._id, summary: record.summary, transcript: record.transcript, audioUrl: record.audioUrl });
  } catch (err) {
    console.error('Error in createSummary:', err);
    res.status(500).json({ message: 'Failed to process audio: ' + err.message });
  }
};

export const getSummaries = async (req, res) => {
  try {
    const summaries = await Summary.find({ participants: req.user._id }).sort({ createdAt: -1 });
    res.json(summaries);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch summaries' });
  }
};

export const deleteSummary = async (req, res) => {
  try {
    const { id } = req.params;
    const summary = await Summary.findById(id);
    
    if (!summary) {
      return res.status(404).json({ message: 'Summary not found' });
    }
    
    // Check if user is a participant in this summary
    if (!summary.participants.includes(req.user._id.toString())) {
      return res.status(403).json({ message: 'Unauthorized to delete this summary' });
    }
    
    // Delete audio file if it exists
    if (summary.audioUrl) {
      const filePath = path.join(process.cwd(), summary.audioUrl.replace(/^\//, ''));
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
    
    // Delete summary from database
    await Summary.findByIdAndDelete(id);
    res.json({ message: 'Summary deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to delete summary' });
  }
};

export default { createSummary, getSummaries, deleteSummary };