const axios = require('axios');

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// Optimized chunking - smaller chunks = faster processing
function chunkText(text, max = 5000) {  // ✅ Reduced from 8000 to 5000
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
      max_tokens: 8000,  // ✅ Reduced from 16000 for faster responses
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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const user_inputs = req.body?.user_inputs || '';
    const document_text = req.body?.document_text || '';

    console.log('=== SOP Review Start ===');
    console.log('Document length:', document_text.length);

    if (!user_inputs || !document_text) {
      return res.status(400).json({ 
        error: 'Both user_inputs and document_text required'
      });
    }

    // ✅ Limit document size to prevent timeout
    const maxDocLength = 40000;  // ~40KB of text (8-10 pages)
    const truncatedDoc = document_text.length > maxDocLength 
      ? document_text.substring(0, maxDocLength) + "\n\n[Document truncated for processing]"
      : document_text;

    // Chunk if needed
    const chunks = truncatedDoc.length > 10000 
      ? chunkText(truncatedDoc, 5000)  // Smaller chunks
      : [truncatedDoc];

    console.log(`Processing ${chunks.length} chunk(s)...`);

    // ✅ Process only first 5 chunks to stay under 60 seconds
    const chunksToProcess = chunks.slice(0, 5);
    
    if (chunks.length > 5) {
      console.log(`Warning: Document has ${chunks.length} chunks, processing first 5 only`);
    }

    // Process chunks through Claude
    let processedChunks = [];
    for (let i = 0; i < chunksToProcess.length; i++) {
      console.log(`Chunk ${i + 1}/${chunksToProcess.length}`);
      
      const system = `You are an expert SOP reviewer with expertise in ISO 9001, ISO 13485, FDA 21 CFR Part 11, and EU GMP.

Review for: regulatory compliance, operational clarity, risk management, process effectiveness, documentation quality.

Provide concise, actionable feedback with specific recommendations.`;

      const user = `CRITERIA: ${user_inputs}\n\nSECTION:\n${chunksToProcess[i]}\n\nProvide review.`;
      
      const result = await callClaude(system, user);
      processedChunks.push(result);
      
      // ✅ Reduced delay from 800ms to 300ms
      if (i < chunksToProcess.length - 1) {
        await new Promise(r => setTimeout(r, 300));
      }
    }

    const claudeReview = processedChunks.join("\n\n---\n\n");
    console.log('Claude complete');

    // GPT Enhancement
    const gptSystem = `You are a Senior QA Editor for regulatory compliance documentation.

Take the SOP review and produce the FINAL ENHANCED VERSION.

✓ Preserve all findings
✓ Correct errors
✓ Add critical missed issues
✓ Improve clarity and structure
✓ Ensure regulatory precision

Output the final SOP review document (not meta-commentary).`;

    const gptUser = `REQUIREMENTS:\n${user_inputs}\n\nDOCUMENT:\n${truncatedDoc.substring(0, 20000)}\n\nPRIMARY REVIEW:\n${claudeReview}\n\nProduce FINAL ENHANCED review.`;

    const finalReview = await callGPT(gptSystem, gptUser);
    
    console.log('=== Complete ===');

    return res.status(200).json({
      success: true,
      ai_draft: claudeReview,
      ai_output: finalReview,
      chunks_processed: chunksToProcess.length,
      document_truncated: document_text.length > maxDocLength,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error('Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};


Loading spinner (use an animated GIF or Bubble's loading bar)
