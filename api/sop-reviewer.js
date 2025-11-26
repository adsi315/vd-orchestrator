const axios = require('axios');

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// Chunking function
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

// Claude call (Primary reviewer)
async function callClaude(system, user) {
  console.log('=== CLAUDE (Primary) ===');
  
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
  
  console.log('Claude response length:', data.content[0].text.length);
  return data.content[0].text;
}

// GPT call (QA reviewer)
async function callGPT(system, user) {
  console.log('=== GPT (QA) ===');
  
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
  
  console.log('GPT response length:', data.choices[0].message.content.length);
  return data.choices[0].message.content;
}

// Main handler
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    // Get data - handle multiple formats from Bubble
    let user_inputs = '';
    let document_text = '';

    console.log('=== Request Info ===');
    console.log('Content-Type:', req.headers['content-type']);
    console.log('Body type:', typeof req.body);
    console.log('Body keys:', req.body ? Object.keys(req.body) : 'none');

    // Try to extract data from body (Vercel auto-parses most formats)
    if (req.body && typeof req.body === 'object') {
      user_inputs = req.body.user_inputs || '';
      document_text = req.body.document_text || '';
      console.log('Got data from parsed body object');
    }

    console.log('Final values:');
    console.log('- user_inputs length:', user_inputs?.length || 0);
    console.log('- document_text length:', document_text?.length || 0);

    if (!user_inputs || !document_text) {
      return res.status(400).json({ 
        error: 'Both user_inputs and document_text are required',
        received: {
          has_user_inputs: !!user_inputs,
          has_document_text: !!document_text,
          user_inputs_length: user_inputs?.length || 0,
          document_text_length: document_text?.length || 0
        }
      });
    }

    // Chunk the document
    const chunks = document_text.length > 10000 
      ? chunkText(document_text, 8000) 
      : [document_text];

    console.log(`Processing ${chunks.length} chunk(s)...`);

    // Process each chunk through Claude (Primary)
    let processedChunks = [];
    for (let i = 0; i < chunks.length; i++) {
      console.log(`Chunk ${i + 1}/${chunks.length}`);
      
      const system = `You are an expert SOP (Standard Operating Procedure) and regulatory compliance reviewer with deep expertise in:
- ISO 9001:2015 Quality Management Systems
- ISO 13485:2016 Medical Devices QMS
- FDA 21 CFR Part 11 Electronic Records
- EU GMP Guidelines
- Industry best practices

Analyze through multiple lenses:
✓ Regulatory Compliance
✓ Operational Clarity
✓ Risk Management
✓ Process Effectiveness
✓ Documentation Quality

Provide detailed, constructive, actionable feedback.`;

      const user = `REVIEW CRITERIA:\n${user_inputs}\n\nDOCUMENT SECTION:\n${chunks[i]}\n\nProvide comprehensive review with specific findings and recommendations.`;
      
      const result = await callClaude(system, user);
      processedChunks.push(result);
      
      if (i < chunks.length - 1) {
        await new Promise(r => setTimeout(r, 800));
      }
    }

    const claudePrimaryReview = processedChunks.join("\n\n═══════════════════════════════════════════════════\n\n");
    console.log('Claude review complete. Length:', claudePrimaryReview.length);

    // GPT QA Review
    console.log('Sending to GPT for QA...');
    
    const gptSystem = `You are a Senior Quality Assurance Reviewer specializing in regulatory compliance and technical documentation.

Perform rigorous secondary review (QA/QC) of the primary SOP analysis.

Verify:
✓ Accuracy of findings
✓ Completeness - identify missed issues
✓ Consistency of recommendations
✓ Regulatory precision
✓ Actionability

Provide verification, additional issues, corrections, and overall quality assessment.`;

    const gptUser = `ORIGINAL REQUIREMENTS:\n${user_inputs}\n\nORIGINAL DOCUMENT:\n${document_text.substring(0, 30000)}\n\nCLAUDE PRIMARY REVIEW:\n${claudePrimaryReview}\n\nProvide comprehensive QA review.`;

    const gptFinalReview = await callGPT(gptSystem, gptUser);
    
    console.log('GPT QA complete. Length:', gptFinalReview.length);
    console.log('=== SUCCESS ===');

    return res.status(200).json({
      success: true,
      ai_draft: claudePrimaryReview,
      ai_output: gptFinalReview,
      chunks_processed: chunks.length,
      timestamp: new Date().toISOString(),
      metadata: {
        document_length: document_text.length,
        user_inputs_length: user_inputs.length,
        total_chunks: chunks.length,
        model_used: {
          primary: "claude-sonnet-4-20250514",
          qa_reviewer: "gpt-4-turbo-preview"
        }
      }
    });

  } catch (err) {
    console.error('=== ERROR ===');
    console.error('Message:', err.message);
    console.error('Response:', err.response?.data);
    
    return res.status(500).json({ 
      error: err.message,
      details: err.response?.data || 'No additional details'
    });
  }
};
```

---

## **Fix Bubble API Connector (Same as Orchestrator)**

**In Bubble → API Connector → sop_reviewer:**

### **Critical Settings:**

**Method:** POST

**URL:** `https://vd-orchestrator.vercel.app/api/sop-reviewer`

**Headers:**
```
Content-Type: application/json
