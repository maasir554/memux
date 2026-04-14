/**
 * Main-thread PDF renderer using regular Canvas + DOM font support.
 * PDF.js can use @font-face on the main thread, so embedded fonts render correctly.
 * Used for: Page View rendering, Vision OCR image generation.
 */
import * as pdfjsLib from "pdfjs-dist";

// Use Vite's URL resolution for modern ES Module workers (fixes infinite hang)
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const cMapUrl = "/cmaps/";
const standardFontDataUrl = "/standard_fonts/";

/**
 * Render a single PDF page to a canvas-based Blob image on the main thread.
 * This supports embedded fonts via CSS @font-face (unlike OffscreenCanvas in workers).
 */
export async function renderPdfPageMainThread(
    file: File,
    pageNum: number,
    scale: number = 2.0
): Promise<{ imageBlob: Blob; canvas: HTMLCanvasElement }> {
    const arrayBuffer = await file.arrayBuffer();

    const pdf = await pdfjsLib.getDocument({
        data: arrayBuffer,
        standardFontDataUrl,
        cMapUrl,
        cMapPacked: true,
    }).promise;

    if (pageNum < 1 || pageNum > pdf.numPages) {
        throw new Error(`Invalid page number: ${pageNum}. PDF has ${pdf.numPages} pages.`);
    }

    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale });

    // Create a real DOM canvas — this lets PDF.js use @font-face for embedded fonts
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not create canvas context");

    await page.render({
        canvasContext: context,
        viewport,
    }).promise;

    // Convert to blob for display and Vision OCR
    const imageBlob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((b) => {
            if (b) resolve(b);
            else reject(new Error("Failed to convert canvas to blob"));
        }, "image/png");
    });

    return { imageBlob, canvas };
}

/**
 * Get the total number of pages in a PDF file.
 */
export async function getPdfPageCount(file: File): Promise<number> {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({
        data: new Uint8Array(arrayBuffer),
        standardFontDataUrl,
        cMapUrl,
        cMapPacked: true,
    }).promise;
    return pdf.numPages;
}

/**
 * Extracts raw text from a PDF document sequentially for LLM AI inferences
 */
export async function extractPdfText(file: File): Promise<string> {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({
        data: new Uint8Array(arrayBuffer),
        standardFontDataUrl,
        cMapUrl,
        cMapPacked: true,
    }).promise;
    
    let text = "";
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        // Extract string values
        const pageText = textContent.items.map((item: any) => item.str).join(" ");
        text += `\n--- Page ${i} ---\n${pageText}\n`;
    }
    return text.trim();
}
