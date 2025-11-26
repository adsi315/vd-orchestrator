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
      max_tokens: 12000
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
    const user_inputs = req.body?.user_inputs || '';  // User's review criteria/requirements
    const document_text = req.body?.document_text || '';  // Full SOP document text

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
      
      const system = `You are an expert SOP (Standard Operating Procedure) reviewer with deep knowledge of:
- ISO 9001:2015 Quality Management Systems
- ISO 13485:2016 Medical Devices QMS
- FDA 21 CFR Part 11 (if applicable)
- EU GMP Guidelines
- Industry best practices

Review document sections for:
✓ Clarity and completeness
✓ Compliance with standards
✓ Process effectiveness
✓ Risk identification
✓ Consistency and accuracy

Provide detailed, constructive feedback with specific improvement recommendations.`;

      const user = `USER REVIEW CRITERIA:\n${user_inputs}\n\nDOCUMENT SECTION:\n${chunks[i]}\n\nProvide detailed review of this section.`;
      
      const result = await callClaude(system, user);
      processedChunks.push(result);
      
      if (i < chunks.length - 1) {
        await new Promise(r => setTimeout(r, 800));  // Rate limiting
      }
    }

    // Combine all chunk reviews
    const claudeFullReview = processedChunks.join("\n\n---\n\n");
    console.log('All chunks reviewed by Claude. Combined length:', claudeFullReview.length);

    // Send to GPT for QA review
    console.log('=== Sending to GPT for QA Review ===');
    
    const gptSystem = `You are a Senior Quality Assurance Reviewer specializing in regulatory compliance and technical documentation.

Your role: Perform rigorous secondary review (QA/QC) of the primary SOP analysis.

Verify:
✓ Accuracy of findings
✓ Completeness - identify any missed issues
✓ Consistency of recommendations
✓ Regulatory precision
✓ Actionability of suggestions

Provide:
- Verification of accurate findings
- Additional issues not identified in primary review
- Corrections for any inaccuracies
- Enhanced recommendations
- Overall quality assessment`;

    const gptUser = `ORIGINAL USER REQUIREMENTS:\n${user_inputs}\n\nORIGINAL DOCUMENT:\n${document_text.substring(0, 30000)}\n\nCLAUDE PRIMARY REVIEW:\n${claudeFullReview}\n\nProvide comprehensive QA review identifying gaps, confirming accurate findings, and suggesting enhancements.`;

    const gptQAReview = await callGPT(gptSystem, gptUser);
    
    console.log('GPT QA review complete. Length:', gptQAReview.length);
    console.log('=== PROCESS COMPLETE ===');

    return res.status(200).json({
      success: true,
      claude_primary_review: claudeFullReview,
      gpt_qa_review: gptQAReview,
      chunks_processed: chunks.length,
      timestamp: new Date().toISOString(),
      metadata: {
        document_length: document_text.length,
        user_inputs_length: user_inputs.length,
        total_chunks: chunks.length
      }
    });

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
