const fs = require('fs');
let code = fs.readFileSync('/Users/maasir/Projects/memux/frontend/src/store/extraction-store.ts', 'utf8');

code = code.replace(
    "const screenshotAssetIdByIndex = new Map<number, string>();",
    "console.log('[DEBUG] try block started');\n            const screenshotAssetIdByIndex = new Map<number, string>();"
);

code = code.replace(
    "const embeddings = embeddingInputs.length > 0 ? await embedBatches(embeddingInputs, 64) : [];",
    "console.log('[DEBUG] calling embedBatches');\n            const embeddings = embeddingInputs.length > 0 ? await embedBatches(embeddingInputs, 64) : [];\n            console.log('[DEBUG] embedBatches returned', embeddings.length);"
);

code = code.replace(
    "await dbService.saveContextSegments({",
    "console.log('[DEBUG] calling saveContextSegments for summary');\n            await dbService.saveContextSegments({"
);

code = code.replace(
    "for (let extraIdx = 0; extraIdx < extraScreenshots.length; extraIdx++) {",
    "console.log('[DEBUG] starting extraScreenshots loop, length:', extraScreenshots.length);\n            for (let extraIdx = 0; extraIdx < extraScreenshots.length; extraIdx++) {"
);

code = code.replace(
    "const sequence = await apiService.processBookmarkScreenshotSequence({",
    "console.log('[DEBUG] calling processBookmarkScreenshotSequence');\n                const sequence = await apiService.processBookmarkScreenshotSequence({"
);

code = code.replace(
    "const paragraphEmbeddings = embeddingInputs.length > 0",
    "console.log('[DEBUG] calling paragraphEmbeddings extraction');\n                    const paragraphEmbeddings = embeddingInputs.length > 0"
);

if (code.includes('[DEBUG] try block started')) {
    fs.writeFileSync('/Users/maasir/Projects/memux/frontend/src/store/extraction-store.ts', code);
    console.log('Patched with logs!');
} else {
    console.log('Failed to patch!');
}
