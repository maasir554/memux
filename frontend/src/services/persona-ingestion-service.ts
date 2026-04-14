import { dbService } from './db-service';
import { apiService } from './api-service';

export interface PersonaFieldExtraction {
    key: string;
    value: string;
    keywords: string[];
}

export const personaIngestionService = {
    /**
     * Ingests unstructured text (from a text document or PDF extraction)
     * and relies on the AI TS orchestrator to extract dense KV fields,
     * embedding them and writing them natively as 'persona_field' segments.
     */
    async ingestPersonaText(sourceId: string, text: string, documentIdForPdfAttachment?: string): Promise<void> {
        const prompt = `You are an expert AI persona data extractor.
Read the following personal document text and extract all important details into a strict JSON array.
Include details such as demographics, name, emails, phones, addresses, employment history, education, skills, and links.

OUTPUT FORMAT INSTRUCTIONS:
Return ONLY a valid JSON object matching this schema:
{
  "fields": [
    {
      "key": "Primary Email",
      "value": "user@example.com",
      "keywords": ["email", "contact", "address"]
    }
  ]
}

Ensure "keywords" contains at least 5 broad synonyms or variations of the key that a form might ask for during autofilling.

CONTENT TO EXTRACT:
${text}`;

        try {
            // The python backend will instantly abort with a generic non-JSON rejection string 
            // if we provide an empty context array. We pass a dummy chunk to bypass this RAG gate.
            const bypassChunk = { id: "system_bypass", similarity_score: 1.0, text_summary: "Bypass." };
            const chatRes = await apiService.generateRagChat(prompt, [bypassChunk]);
            
            // The RAG endpoint drops output fields that aren't inside an 'answer' property, 
            // replacing it with an error string. By grabbing the raw_response from the debug trace, 
            // we access the raw unstripped LLM output!
            const rawContent = chatRes.debug_info?.raw_response || chatRes.response;
            
            let rawStr = rawContent.trim();
            if (rawStr.startsWith('```json')) rawStr = rawStr.slice(7);
            if (rawStr.startsWith('```')) rawStr = rawStr.slice(3);
            if (rawStr.endsWith('```')) rawStr = rawStr.slice(0, -3);

            const parsed = JSON.parse(rawStr.trim());
            const fields: PersonaFieldExtraction[] = parsed.fields || [];

            if (fields.length === 0) return;

            // Generate Embeddings representing the Key + Value + Keywords for semantic matching
            const textsToEmbed = fields.map(f => `Key: ${f.key} Value: ${f.value} Keywords: ${f.keywords.join(', ')}`);
            const embeddings = await apiService.generateEmbeddings(textsToEmbed);

            const db = (await import('../lib/db')).getDb();
            const now = new Date().toISOString();

            for (let i = 0; i < fields.length; i++) {
                const field = fields[i];
                // Attach the PDF document id into the structured JSON if it is relevant so the extractor agent knows what file to pull
                const structuredJsonTarget: any = {
                    key: field.key,
                    value: field.value,
                    keywords: field.keywords
                };
                if (documentIdForPdfAttachment) {
                    structuredJsonTarget.source_document_id = documentIdForPdfAttachment;
                }

                await db.query(
                    `INSERT INTO context_segments (
                        id, source_id, segment_type, segment_index, text_content, structured_json, embedding
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7::vector)`,
                    [
                        crypto.randomUUID(),
                        sourceId,
                        'persona_field',
                        i,
                        `[Persona Extraction] ${field.key}: ${field.value}`,
                        JSON.stringify(structuredJsonTarget),
                        JSON.stringify(embeddings[i])
                    ]
                );
            }

            // Mark source as indexed
            await dbService.updateContextSource(sourceId, { status: 'indexed' });
        } catch (error) {
            console.error("Persona ingestion AI extraction failed:", error);
            try {
                await dbService.updateContextSource(sourceId, { status: 'failed' });
            } catch (statusError) {
                console.error("Also failed to update status to failed:", statusError);
            }
        }
    }
};
