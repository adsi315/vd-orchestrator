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
  console.log('=== CLAUDE (Primary) REQUEST ===');
  console.log('System length:', system.length);
  console.log('User length:', user.length);
  console.log('System preview:', system.substring(0, 300));
  console.log('User preview:', user.substring(0, 300));
  
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
  
  console.log('=== CLAUDE RESPONSE ===');
  console.log('Response preview:', data.content[0].text.substring(0, 500));
  console.log('Tokens - Input:', data.usage.input_tokens, 'Output:', data.usage.output_tokens);
  
  return data.content[0].text;
}

// GPT call (QA reviewer)
async function callGPT(system, user) {
  console.log('=== GPT (QA) REQUEST ===');
  console.log('System length:', system.length);
  console.log('User length:', user.length);
  
  const { data } = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4-turbo-preview",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      temperature: 0.2,
      max_tokens: 4000  // ✅ Fixed
    },
    { 
      headers: { 
        "Authorization": `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json"
      }
    }
  );
  
  console.log('=== GPT RESPONSE ===');
  console.log('Response preview:', data.choices[0].message.content.substring(0, 500));
  console.log('Tokens - Total:', data.usage.total_tokens);
  
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
    const user_inputs = req.body?.user_inputs || '';
    const document_text = req.body?.document_text || '';

    console.log('=== SOP REVIEWER REQUEST ===');
    console.log('user_inputs length:', user_inputs.length);
    console.log('document_text length:', document_text.length);

    if (!user_inputs || !document_text) {
      return res.status(400).json({ 
        error: 'Both user_inputs and document_text are required',
        received: {
          has_user_inputs: !!user_inputs,
          has_document_text: !!document_text
        }
      });
    }

    // Chunk the document
    const chunks = document_text.length > 10000 
      ? chunkText(document_text, 8000) 
      : [document_text];

    console.log(`Processing ${chunks.length} chunk(s) through Claude...`);

    // Process each chunk through Claude (Primary)
    let processedChunks = [];
    for (let i = 0; i < chunks.length; i++) {
      console.log(`Claude processing chunk ${i + 1}/${chunks.length}`);
      
      const system = `You are an expert SOP (Standard Operating Procedure) and regulatory compliance reviewer with deep expertise in:
- ISO 9001:2015 Quality Management Systems
- ISO 13485:2016 Medical Devices QMS
- FDA 21 CFR Part 11 Electronic Records
- EU GMP Guidelines
- Industry best practices across pharmaceutical, manufacturing, healthcare sectors

Your role: Conduct comprehensive, systematic reviews of SOPs with precision and professionalism.

Analyze through multiple lenses:
✓ Regulatory Compliance - alignment with applicable standards
✓ Operational Clarity - clear, unambiguous procedures
✓ Risk Management - identification of potential issues
✓ Process Effectiveness - practical implementability
✓ Documentation Quality - completeness and consistency

Provide detailed, constructive, actionable feedback with specific improvement recommendations.`;

      const user = `REVIEW CRITERIA & REQUIREMENTS:
${user_inputs}

DOCUMENT SECTION TO REVIEW:
${chunks[i]}

Provide comprehensive review of this section with specific findings and recommendations.`;
      
      const result = await callClaude(system, user);
      processedChunks.push(result);
      
      if (i < chunks.length - 1) {
        await new Promise(r => setTimeout(r, 800));
      }
    }

    // Combine all chunk reviews
    const claudePrimaryReview = processedChunks.join("\n\n═══════════════════════════════════════════════════\n\n");
    console.log('All chunks reviewed by Claude. Combined length:', claudePrimaryReview.length);

    // Send to GPT for QA review
    console.log('=== Sending to GPT for QA Review ===');
    
    const gptSystem = `You are a Senior Quality Assurance Reviewer specializing in regulatory compliance and technical documentation auditing.

Your expertise spans ISO standards, FDA regulations, EU GMP, and international quality management systems.

Your role: Perform rigorous secondary review (QA/QC) of primary SOP analyses. Verify accuracy, identify oversights, assess consistency, and ensure recommendations meet international professional standards.

Approach reviews with:
- Critical analytical thinking
- Deep regulatory knowledge
- Attention to technical precision
- Zero tolerance for inaccuracies
- Commitment to audit-grade quality assurance

Review Protocol:
✓ ACCURACY VERIFICATION - Confirm all findings are factually correct
✓ COMPLETENESS ASSESSMENT - Identify overlooked issues
✓ CONSISTENCY CHECK - Ensure internal logic and coherence
✓ REGULATORY PRECISION - Validate compliance analysis
✓ ENHANCEMENT - Add value beyond validation

Provide independent verification that adds a critical safety layer to document reviews.`;

    const gptUser = `ORIGINAL REVIEW REQUIREMENTS:
${user_inputs}

ORIGINAL SOP DOCUMENT:
${document_text.substring(0, 30000)}

CLAUDE PRIMARY REVIEW TO QA:
${claudePrimaryReview}

Perform comprehensive QA review:
1. Verify accurate findings
2. Identify any missed critical issues
3. Flag inaccuracies or inconsistencies
4. Provide additional recommendations
5. Assess overall review quality
6. Deliver final determination: APPROVED / APPROVED WITH REVISIONS / REQUIRES REWORK

Provide actionable, professional QA assessment.`;

    const gptFinalReview = await callGPT(gptSystem, gptUser);
    
    console.log('GPT QA review complete. Length:', gptFinalReview.length);
    console.log('=== PROCESS COMPLETE ===');

    return res.status(200).json({
      success: true,
      ai_draft: claudePrimaryReview,   // ✅ Claude primary review
      ai_output: gptFinalReview,       // ✅ GPT final QA review
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
    
module.exports = (req, res) => {
  try {
    if (req.method === "GET") {
      return res.status(200).json({ status: "ok", method: "GET" });
    }
    if (req.method === "POST") {
      // echo body back so we can see what Bubble sends
      return res.status(200).json({ status: "ok", method: "POST", body: req.body || null });
    }
    return res.status(405).json({ error: "method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

  } catch (err) {
    console.error('=== ERROR ===');
    console.error('Message:', err.message);
    console.error('Stack:', err.stack);
    
    return res.status(500).json({ 
      error: err.message,
      details: err.response?.data || 'No additional details'
    });
  }
};
