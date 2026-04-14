import { dbService } from './db-service';
import { apiService } from './api-service';

export interface FormField {
    id: string;
    name: string;
    type: string;
    label: string;
    required: boolean;
}

export interface FormStructure {
    platform: string;
    title: string;
    url: string;
    fields: FormField[];
}

export const autofillAgentService = {
    async fillForm(form: FormStructure): Promise<{ mapped_fields: Record<string, string>, file_blobs: Record<string, string> }> {
        const profileSpace = await dbService.getPersonalProfileSpace();
        
        const mappedFields: Record<string, string> = {};
        const fileBlobs: Record<string, string> = {};

        // Instead of processing the entire form with a massive raw context, we iterate each field to leverage
        // the structured multi-agent pipeline: Decompose -> 10 + 10 Retrieval -> 5 Shortlist -> Map
        for (const field of form.fields) {
            console.info(`[Multi-Agent] Processing field: ${field.label || field.name}`);
            
            // Agent 1: Decompose query into keywords
            const fieldQuery = `The form is asking for ${field.label || field.name} of type ${field.type}. Form context: ${form.title}`;
            const decomp = await apiService.decomposeQuery(fieldQuery, []);
            const searchKeywords = decomp.search_terms.length > 0 ? decomp.search_terms : [field.name];

            // Setup Retrieval bounds
            let candidateIds = new Set<string>();
            let candidates: any[] = [];

            // 10 Chunks via Vector Semantic Distance
            try {
                const queryEmbedding = await apiService.generateEmbeddings([fieldQuery]).then(e => e[0]);
                const semanticResults = await dbService.searchPersonaFieldsSemantic(profileSpace.id, queryEmbedding, 10);
                for (const r of semanticResults) {
                    if (!candidateIds.has(r.id)) {
                        candidateIds.add(r.id);
                        candidates.push(r);
                    }
                }
            } catch (e) {
                console.warn("Semantic retrieval failed context", e);
            }

            // 10 Chunks via Grep JSON array match
            try {
                const grepResults = await dbService.searchPersonaFieldsGrep(profileSpace.id, searchKeywords, 10);
                for (const r of grepResults) {
                    if (!candidateIds.has(r.id)) {
                        candidateIds.add(r.id);
                        candidates.push(r);
                    }
                }
            } catch (e) {
                console.warn("Grep retrieval failed context", e);
            }

            if (candidates.length === 0) continue;

            // Agent 2: Shortlist Contexts down to exact 5 items to prevent hallucination / bloat
            let finalChunksToEvaluate = candidates;
            if (candidates.length > 5) {
                try {
                    const mappedCandidates = candidates.map(c => ({
                        id: c.id,
                        text_summary: c.text_content
                    }));
                    const shortlistRes = await apiService.ragShortlistChunks(fieldQuery, mappedCandidates);
                    
                    const keepers = new Set(shortlistRes.evaluations.filter(e => e.to_keep).map(e => e.id));
                    finalChunksToEvaluate = candidates.filter(c => keepers.has(c.id));
                    
                    // Fallback to top 5 heuristic if LLM throws out everything
                    if (finalChunksToEvaluate.length === 0) {
                        finalChunksToEvaluate = candidates.slice(0, 5);
                    }
                } catch(e) {
                    console.warn("Shortlist agent failed, falling back to heuristic slice.", e);
                    finalChunksToEvaluate = candidates.slice(0, 5);
                }
            }

            // Agent 3: The precise Value Extractor
            const extractionPrompt = `You are an autofill completion agent.
Form context: ${form.title} | ${form.url}
Extract the EXACT string value for the field: "${field.name}" (Label: "${field.label}") based strictly on the provided Contexts. 

RULES:
1. Output ONLY the raw extracted value meant to be typed in. No quotes or explanations.
2. If it is asking for a File (like a Resume or Image), reply with EXACTLY the "source_document_id" found dynamically in the context matching the file. 
3. If no relevant info exists across contexts, reply exactly "UNKNOWN".`;

            const evaluationChunks = finalChunksToEvaluate.map(c => ({
                id: c.id,
                data: c.structured_json || {},
                text_summary: c.text_content
            }));
            
            try {
                const res = await apiService.generateRagChat(extractionPrompt, evaluationChunks);
                const answer = res.response.trim();
                
                if (answer === "UNKNOWN" || answer === "" || answer.includes("UNKNOWN")) {
                    continue; // Skip injecting this field
                }

                if (field.type === 'file') {
                    const docIdMatch = answer.replace(/[^a-zA-Z0-9-]/g, ''); 
                    if (docIdMatch) {
                        const { pdfStore } = await import('@/services/pdf-store');
                        const file = await pdfStore.getPdf(docIdMatch);
                        if (file) {
                            const b64 = await new Promise<string>((resolve) => {
                                const reader = new FileReader();
                                reader.onload = () => resolve(String(reader.result).split(',')[1]);
                                reader.readAsDataURL(file);
                            });
                            fileBlobs[field.name] = b64;
                        }
                    }
                } else {
                    mappedFields[field.name] = answer;
                }
            } catch(e) {
                console.error("Mapping agent failed for field:", field.name, e);
            }
        }

        return { mapped_fields: mappedFields, file_blobs: fileBlobs };
    }
}
