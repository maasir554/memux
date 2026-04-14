import os
import base64
from groq import Groq
from typing import Dict

# Initialize multiple Groq clients for load distribution
clients = []
key_index = 0

for i in range(10):
    cur_key = os.environ.get(f"GROQ_API_KEY_{i+1}")
    clients.append(Groq(api_key=cur_key))

def get_next_client():
    """Get next client using round-robin distribution"""
    global key_index
    client = clients[key_index % 10]
    key_index += 1
    return client

VISION_OCR_PROMPT = """Extract all text content from this image. Pay special attention to:
1. Preserve the exact text as it appears
2. Identify and preserve tabular data structure - clearly mark tables with headers and rows
3. Maintain the reading order and layout structure
4. For tables, use a clear format that distinguishes headers from data rows

Provide the extracted text in a clean, readable format that preserves the document structure."""

def extract_text_from_image(base64_image: str) -> Dict[str, str]:
    """
    Extract text from a base64-encoded image using Groq's vision model.
    
    Args:
        base64_image: Base64-encoded image string (without data:image prefix)
    
    Returns:
        Dict with 'text' key containing extracted text and 'debug_info' for troubleshooting
    """
    try:
        # Construct the image URL for Groq API
        image_url = f"data:image/png;base64,{base64_image}"
        
        completion = get_next_client().chat.completions.create(
            model="meta-llama/llama-4-scout-17b-16e-instruct",
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": VISION_OCR_PROMPT
                        },
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": image_url
                            }
                        }
                    ]
                }
            ],
            temperature=0,
            max_tokens=4096
        )
        
        extracted_text = completion.choices[0].message.content
        
        debug_info = {
            "model": "meta-llama/llama-4-scout-17b-16e-instruct",
            "prompt": VISION_OCR_PROMPT,
            "tokens_used": completion.usage.total_tokens if hasattr(completion, 'usage') else None
        }
        
        return {
            "text": extracted_text,
            "debug_info": debug_info
        }
        
    except Exception as e:
        print(f"Vision OCR error: {e}")
        return {
            "text": "",
            "debug_info": {
                "error": str(e)
            }
        }


BOOKMARK_TITLE_INFER_PROMPT = """You are looking at a screenshot of the first visible section of a bookmarked webpage.
The raw page <title> tag says: "{raw_title}"

Your task: produce a short, human-friendly bookmark title that clearly communicates:
1. The BRAND or PRODUCT name visible in the page (logo text, header, hero text — whatever identifies the site ownership)
2. The SPECIFIC PAGE topic (what this particular page is about)

Format: "Brand · Page Topic"  (use · as separator)
- If the raw title already clearly includes the brand, clean it up and return as-is.
- Keep it under 80 characters.
- Return ONLY the title string, nothing else. No quotes, no explanation."""


def infer_bookmark_title(base64_image: str, raw_title: str) -> str:
    """
    Use the vision model to infer a brand-aware bookmark title from the first screenshot.
    Falls back to raw_title on any failure.
    """
    try:
        image_url = f"data:image/png;base64,{base64_image}"
        prompt = BOOKMARK_TITLE_INFER_PROMPT.format(raw_title=raw_title or "Untitled Bookmark")

        completion = get_next_client().chat.completions.create(
            model="meta-llama/llama-4-scout-17b-16e-instruct",
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {"type": "image_url", "image_url": {"url": image_url}}
                    ]
                }
            ],
            temperature=0,
            max_tokens=60
        )

        inferred = (completion.choices[0].message.content or "").strip().strip('"').strip("'")
        if inferred and 3 < len(inferred) < 160:
            return inferred
        return raw_title or "Untitled Bookmark"

    except Exception as e:
        print(f"Title inference error: {e}")
        return raw_title or "Untitled Bookmark"

