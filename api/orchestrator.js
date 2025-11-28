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

  try {
    // ======= HANDLE RAW TEXT OR JSON =======
    let document_text = "";
    let user_inputs = "";

    if (typeof req.body === "string") {
      // raw text
      document_text = req.body;
    } else if (typeof req.body === "object") {
      document_text = req.body.document_text || "";
      user_inputs = req.body.user_inputs || "";
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

Conduct comprehensive review of this document section.

Analyze for:
✓ Regulatory Compliance
✓ Operational Clarity
✓ Risk Management
✓ Process Effectiveness
✓ Documentation Quality

Output format: Structured review using HTML:
- <h3> for section headings
- <p> for paragraphs
- <ul>/<li> for lists
- <strong> for emphasis
- <table> if needed

Provide detailed, actionable findings and recommendations.`;

      const userPrompt = `<strong>Review Criteria:</strong>
${user_inputs}

<strong>Document Section ${i + 1} of ${chunks.length}:</strong>
${chunks[i]}

Provide comprehensive review of this section.`;

      const result = await callClaude(system, userPrompt);
      processedChunks.push(result);

      if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 500));
    }

    const claudeReview = processedChunks.join("\n\n");
    console.log('Claude total length:', claudeReview.length);

    // ======= REVIEWER 2: GPT QA =======
    console.log('GPT review...');
    const gptSystem = `You are Reviewer 2, a Senior Quality Assurance Specialist conducting secondary review of SOP analysis.

Your role: Review the primary analysis and provide:
1. Verification of accurate findings
2. Additional critical issues
3. Corrections for inaccuracies
4. Enhanced recommendations
5. Overall assessment and approval

Output format: HTML with:
- <h3> for section headings
- <p> for paragraphs  
- <ul>/<li> for lists
- <strong> for emphasis

Sections:
1. VERIFICATION
2. ADDITIONAL FINDINGS
3. CORRECTIONS
4. ENHANCED RECOMMENDATIONS
5. OVERALL ASSESSMENT

Reference Reviewer 1's findings when verifying or correcting.`;

    const gptUser = `<strong>Original Review Requirements:</strong>
${user_inputs}

<strong>Original SOP Document (excerpt):</strong>
${document_text.substring(0, 30000)}

<strong>REVIEWER 1 ANALYSIS:</strong>
${claudeReview}

Provide your comprehensive secondary review following the structured format specified.`;

    const gptReview = await callGPT(gptSystem, gptUser);

    console.log('=== DONE ===');

    // ======= FINAL DOCUMENT HTML =======
    const finalDocument = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; max-width: 1200px; margin: 0 auto; padding: 20px; background: #f9f9f9; }
.header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; border-radius: 10px; margin-bottom: 30px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
.header h1 { margin: 0 0 10px 0; font-size: 28px; }
.header p { margin: 5px 0; opacity: 0.9; font-size: 14px; }
.review-section { background: white; padding: 30px; margin-bottom: 25px; border-radius: 10px; box-shadow: 0 2px 4px rgba(0,0,0,0.08); }
.reviewer-badge { display: inline-block; padding: 8px 16px; border-radius: 20px; font-weight: 600; font-size: 13px; margin-bottom: 15px; text-transform: uppercase; letter-spacing: 0.5px; }
.reviewer-1 { background: #e3f2fd; color: #1565c0; border-left: 4px solid #1565c0; }
.reviewer-2 { background: #f3e5f5; color: #6a1b9a; border-left: 4px solid #6a1b9a; }
h2 { color: #2c3e50; border-bottom: 3px solid #667eea; padding-bottom: 10px; margin-top: 0; font-size: 22px; }
h3 { color: #34495e; margin-top: 25px; font-size: 18px; }
p { margin: 12px 0; text-align: justify; }
ul, ol { margin: 15px 0; padding-left: 25px; }
li { margin: 8px 0; }
strong { color: #2c3e50; font-weight: 600; }
table { width: 100%; border-collapse: collapse; margin: 20px 0; background: white; }
th { background: #667eea; color: white; padding: 12px; text-align: left; font-weight: 600; }
td { padding: 10px 12px; border-bottom: 1px solid #e0e0e0; }
tr:hover { background: #f5f5f5; }
.criteria-box { background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0; border-radius: 5px; }
.footer { text-align: center; margin-top: 40px; padding: 20px; color: #7f8c8d; font-size: 13px; border-top: 1px solid #e0e0e0; }
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
    console.error('=== ERROR ===');
    console.error(err.message);
    return res.status(500).json({
      error: err.message,
      details: err.response?.data
    });
  }
};
