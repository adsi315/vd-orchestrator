// orchestrator.js
const axios = require('axios');

// ------------------ API KEYS ------------------
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// ------------------ HELPERS ------------------
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
  const { data } = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-20250514",
      max_tokens: 16000,
      system,
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
  return data.content[0].text;
}

async function callGPT(system, user) {
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
  return data.choices[0].message.content;
}

// ------------------ VERCEL HANDLER ------------------
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const {
      uploaded_wp = "",          // Optional uploaded SOP
      user_inputs = "",          // Optional manual input fields
      dropdown_selections = {},  // Optional constraints
      proceed_to_arg = false     // Populate ARG RG if true
    } = req.body || {};

    if (!uploaded_wp && !user_inputs) {
      return res.status(400).json({ error: "Provide at least uploaded_wp or user_inputs" });
    }

    // ------------------ PREPARE DOCUMENT ------------------
    const sourceText = uploaded_wp ? uploaded_wp : user_inputs;
    const chunks = sourceText.length > 10000 ? chunkText(sourceText, 8000) : [sourceText];
    let generatedChunks = [];

    // ------------------ CLAUDE: Generate Audit Program ------------------
    for (let i = 0; i < chunks.length; i++) {
      const system = `You are an expert auditor and working paper author. 
Your task: Convert the provided SOP text or user inputs into a professional, testable audit program.
Focus on:
- Step-by-step audit procedures
- Sample sizes where applicable
- Responsible departments or roles
- References to relevant policies, controls, or SOPs
- Clear, actionable, auditable content
- Suitable for auditors, compliance, risk, QA, IC, and department heads
Output in **structured HTML**, with headings, lists, and tables for clarity.`;

      const userPrompt = `
Section ${i + 1} of ${chunks.length}:

Text to convert:
${chunks[i]}

Additional user constraints:
${JSON.stringify(dropdown_selections)}

Instructions:
- Translate policies/procedures into testable audit steps
- Include sample sizes, responsible departments, and references
- Organize logically by department or control area
- Maintain professional and clear format
`;

      const chunkResult = await callClaude(system, userPrompt);
      generatedChunks.push(chunkResult);

      if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 500));
    }

    const generatedWP = generatedChunks.join("\n\n");

    // ------------------ OPTIONAL: Generate ARG Repeating Group Procedures ------------------
    let argProcedures = [];
    if (proceed_to_arg) {
      const procSystem = `You are an expert auditor. Extract all testable audit procedures from this Working Paper for a Bubble repeating group.
- Follow 5Cs: Criteria, Condition, Cause, Consequence, Conclusion
- Each procedure must be actionable and clear
- Return JSON array of objects {procedure: "...", sample_size: "...", department: "..."} or fallback to text list`;

      const procUser = `Working Paper:
${generatedWP}`;

      const procResultRaw = await callGPT(procSystem, procUser);

      try {
        argProcedures = JSON.parse(procResultRaw);
      } catch (err) {
        console.warn("JSON parse failed, fallback to text array");
        argProcedures = procResultRaw
          .split(/\n/)
          .filter(line => line.trim())
          .map(line => ({ procedure: line.trim() }));
      }
    }

    // ------------------ FORMAT FINAL HTML ------------------
    const finalDocument = `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height:1.6; color:#333; max-width:1200px; margin:0 auto; padding:20px; background:#f9f9f9;}
.header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color:white; padding:30px; border-radius:10px; margin-bottom:30px; box-shadow:0 4px 6px rgba(0,0,0,0.1);}
.header h1 { margin:0 0 10px 0; font-size:28px;}
.review-section { background:white; padding:30px; margin-bottom:25px; border-radius:10px; box-shadow:0 2px 4px rgba(0,0,0,0.08);}
h2 { color:#2c3e50; border-bottom:3px solid #667eea; padding-bottom:10px; margin-top:0; font-size:22px;}
p { margin:12px 0; text-align:justify;}
ul, ol { margin:15px 0; padding-left:25px;}
li { margin:8px 0;}
strong { color:#2c3e50; font-weight:600;}
</style>
</head>
<body>
<div class="header">
<h1>📋 Generated Audit Program</h1>
<p><strong>Generated:</strong> ${new Date().toLocaleString()}</p>
<p><strong>Document Size:</strong> ${Math.round(sourceText.length/1024)} KB | <strong>Sections:</strong> ${chunks.length}</p>
</div>
<div class="review-section">
<h2>Working Paper</h2>
${generatedWP.replace(/\n/g,"<br>")}
</div>
</body>
</html>
`;

    // ------------------ RESPONSE ------------------
    return res.status(200).json({
      success: true,
      working_paper_raw: generatedWP,
      working_paper_html: finalDocument,
      procedures_for_arg: argProcedures,
      chunks_processed: chunks.length,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error('=== ERROR ===', err);
    return res.status(500).json({
      error: err.message,
      details: err.response?.data
    });
  }
};
