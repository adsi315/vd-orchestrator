const axios = require('axios');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const LZString = require("lz-string");

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

let rawText = body.document_text;
let decompressed = LZString.decompressFromEncodedURIComponent(rawText);

function chunkText(text, max = 8000) {
  const sentences = text.split(/(?<=[.!?])\s+/);
  let chunks = [];
  let current = "";
  for (const s of sentences) {
    if ((current + s).length > max) {
      if (current.trim()) chunks.push(current.trim());
      current = "";
    }
    current += s + " ";
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

async function callClaude(system, user) {
  console.log('=== CLAUDE ===');
  const { data } = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-20250514",
      max_tokens: 16000,
      system: system,
      messages: [{ role: "user", content: user }]
    },
    {
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      }
    }
  );
  console.log('Claude done:', data.content[0].text.length);
  return data.content[0].text;
}

async function callGPT(system, user) {
  console.log('=== GPT ===');
  const { data } = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4-turbo-preview",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      temperature: 0.2,
      max_tokens: 4000
    },
    { 
      headers: { 
        "Authorization": `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json"
      }
    }
  );
  console.log('GPT done:', data.choices[0].message.content.length);
  return data.choices[0].message.content;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  module.exports = async (req, res) => {
  // ======= CORS & method handling =======
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    // ======= HANDLE RAW TEXT OR JSON =======
    let document_text = "";
    let user_inputs = "";

    if (typeof req.body === "string") {
      document_text = req.body;
    } else if (typeof req.body === "object") {
      document_text = req.body.document_text || "";
      user_inputs = req.body.user_inputs || "";
    }

    // ===== DECOMPRESS (if needed) =====
    if (document_text.startsWith("COMPRESSED:")) {
      document_text = LZString.decompressFromEncodedURIComponent(document_text.replace("COMPRESSED:", "")) || "";
    }

    if (!document_text || !user_inputs) {
      return res.status(400).json({ error: 'document_text and user_inputs are required' });
    }

    console.log('=== START ===');
    console.log('User inputs length:', user_inputs.length);
    console.log('Document text length:', document_text.length);

    // ======= CHUNK LARGE DOCUMENTS =======
    const chunks = document_text.length > 10000
      ? chunkText(document_text, 8000)
      : [document_text];

    console.log(`${chunks.length} chunks`);

    // ======= REVIEWER 1: Claude =======
    let processedChunks = [];
    for (let i = 0; i < chunks.length; i++) {
      console.log(`Chunk ${i + 1}/${chunks.length}`);

      const system = `You are Reviewer 1, an expert SOP and regulatory compliance reviewer with expertise in ISO 9001, ISO 13485, FDA 21 CFR Part 11, and EU GMP.

Analyze for regulatory compliance, clarity, risks, process effectiveness, and documentation quality. Output HTML with <h3>, <p>, <ul>/<li>, <strong>, and <table> if needed.`;

      const userPrompt = `<strong>Review Criteria:</strong>
${user_inputs}

<strong>Document Section ${i + 1} of ${chunks.length}:</strong>
${chunks[i]}`;

      const result = await callClaude(system, userPrompt);
      processedChunks.push(result);

      if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 500));
    }

    const claudeReview = processedChunks.join("\n\n");
    console.log('Claude total length:', claudeReview.length);

    // ======= REVIEWER 2: GPT QA =======
    const gptSystem = `You are Reviewer 2, a Senior QA Specialist conducting secondary review of SOP analysis.

Review the primary analysis and provide verification, additional findings, corrections, enhanced recommendations, and overall assessment. Output HTML with <h3>, <p>, <ul>/<li>, and <strong>.`;

    const gptUser = `<strong>Original Review Requirements:</strong>
${user_inputs}

<strong>Original SOP Document (excerpt):</strong>
${document_text.substring(0, 30000)}

<strong>REVIEWER 1 ANALYSIS:</strong>
${claudeReview}`;

    const gptReview = await callGPT(gptSystem, gptUser);
    console.log('=== DONE ===');

    // ======= FINAL DOCUMENT HTML =======
    const finalDocument = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
/* styles omitted for brevity, same as before */
</style>
</head>
<body>
<div class="header">
<h1>📋 SOP Dual Review Report</h1>
<p><strong>Generated:</strong> ${new Date().toLocaleString()}</p>
<p><strong>Review Type:</strong> Comprehensive Regulatory Compliance & Quality Assessment</p>
<p><strong>Document Size:</strong> ${Math.round(document_text.length / 1024)} KB | <strong>Sections Analyzed:</strong> ${chunks.length}</p>
</div>
<div class="criteria-box">
<strong>📌 Review Criteria Provided by User:</strong><br>
${user_inputs.replace(/\n/g, '<br>')}
</div>
<div class="review-section reviewer-1">
<span class="reviewer-badge reviewer-1">👤 Reviewer 1 - Primary Analysis</span>
<h2>Primary Compliance & Quality Review</h2>
${claudeReview}
</div>
<div class="review-section reviewer-2">
<span class="reviewer-badge reviewer-2">👤 Reviewer 2 - Secondary QA Review</span>
<h2>Quality Assurance & Verification</h2>
${gptReview}
</div>
<div class="footer">
<p>This report was generated using dual AI reviewer system: Claude Sonnet 4 (Primary) & GPT-4 Turbo (QA)</p>
<p>Confidential Document - For Internal Use Only</p>
</div>
</body>
</html>
`;

    return res.status(200).json({
      success: true,
      ai_draft: claudeReview,
      ai_output: finalDocument,
      gpt_review: gptReview,
      chunks_processed: chunks.length,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error('=== ERROR ===', err.message);
    return res.status(500).json({
      error: err.message,
      details: err.response?.data
    });
  }
};
