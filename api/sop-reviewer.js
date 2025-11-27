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

// Claude call
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

// GPT call
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

    console.log('=== START ===');
    console.log('Inputs:', user_inputs.length);
    console.log('Document:', document_text.length);

    if (!user_inputs || !document_text) {
      return res.status(400).json({ 
        error: 'Both user_inputs and document_text required'
      });
    }

    // Chunk
    const chunks = document_text.length > 10000 
      ? chunkText(document_text, 8000) 
      : [document_text];

    console.log(`${chunks.length} chunks`);

    // Claude processes chunks
    let processedChunks = [];
    for (let i = 0; i < chunks.length; i++) {
      console.log(`Chunk ${i + 1}/${chunks.length}`);
      
      const system = `You are an expert SOP and regulatory compliance reviewer with expertise in ISO 9001, ISO 13485, FDA 21 CFR Part 11, and EU GMP.

Review this document section for:
✓ Regulatory compliance
✓ Operational clarity  
✓ Risk management
✓ Process effectiveness
✓ Documentation quality

Provide detailed, actionable feedback with specific recommendations.`;

      const user = `REVIEW CRITERIA:
${user_inputs}

DOCUMENT SECTION:
${chunks[i]}

Provide comprehensive review with findings and recommendations.`;
      
      const result = await callClaude(system, user);
      processedChunks.push(result);
      
      if (i < chunks.length - 1) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    const claudeReview = processedChunks.join("\n\n═══════════════════════════════════════════════════\n\n");
    console.log('Claude total:', claudeReview.length);

    // ✅ FIXED: GPT enhances the review (doesn't critique it)
    console.log('GPT enhancing...');
    
    const gptSystem = `You are a Senior Documentation Quality Editor specializing in regulatory compliance.

Your task: Take the SOP review below and produce an IMPROVED, FINAL VERSION of it.

What to do:
✓ Keep all the findings and recommendations
✓ Fix any errors or inconsistencies 
✓ Add any critical issues that were overlooked
✓ Improve the structure and clarity
✓ Ensure professional tone and regulatory precision
✓ Make it more actionable and complete

What NOT to do:
✗ Do not write a critique about the review
✗ Do not list what was "good" or "bad" 
✗ Do not write meta-commentary like "The review covered..." or "Missing from the analysis..."

OUTPUT: The enhanced final SOP review document itself - seamless and ready for the user.`;

    const gptUser = `Original user requirements:
${user_inputs}

Original SOP document:
${document_text.substring(0, 30000)}

Review to enhance:
${claudeReview}

---

Produce the final, enhanced version of this SOP review. Output the review document directly (not commentary about it).`;

    const finalReview = await callGPT(gptSystem, gptUser);
    
    console.log('=== DONE ===');
    console.log('Final:', finalReview.length);

    return res.status(200).json({
      success: true,
      ai_draft: claudeReview,
      ai_output: finalReview,
      chunks_processed: chunks.length,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error('=== ERROR ===');
    console.error(err.message);
    console.error(err.response?.data);
    
    return res.status(500).json({ 
      error: err.message,
      details: err.response?.data
    });
  }
};
