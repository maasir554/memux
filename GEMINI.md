# MAXCAVATOR

MAXCAVATOR is a local-first legacy PDF data extractor and contextual querying engine. It leverages WebAssembly (PGlite, PDF.js) to perform heavy data processing in the browser while utilizing high-speed AI inference (Groq) for structured data extraction and intelligent chat.

## Project Architecture

### Frontend (Vite + React + TypeScript)
- **State Management:** `zustand` for UI and extraction lifecycle.
- **Database:** `PGlite` (PostgreSQL in WASM) with `pgvector` for hybrid SQL and semantic search.
- **Background Workers:**
  - `db.worker.ts`: Manages the PGlite instance and schema initialization.
  - `extraction.worker.ts`: Handles PDF rendering (via PDF.js) and OCR orchestration.
- **Services:**
  - `db-service.ts`: Abstracted interface for all database operations.
  - `api-service.ts`: Client for the FastAPI backend.
  - `extraction-service.ts`: Interface for the extraction worker.

### Backend (FastAPI + Python)
- **AI Inference:** Powered by Groq (Models: `llama-4-scout-17b`, `kimi-k2`).
- **Vision OCR:** Extracts text and table structures from page images.
- **Extraction Engine:** `extraction.py` contains prompts and logic for table extraction, summary generation, and SQL query synthesis.
- **RAG & Agents:** `agent_orchestrator.py` manages multi-step reasoning for complex user queries.
- **Embeddings:** Vector generation for semantic search.

## Building and Running

### Prerequisites
- Node.js (v20+)
- Python (3.10+)
- Groq API Key (Set `GROQ_API_KEY_1` through `GROQ_API_KEY_7` in `.env`)

### Setup & Run
1. **Root Dependencies:** `npm install`
2. **Backend Setup:**
   ```bash
   cd backend
   python -m venv venv
   source venv/bin/activate
   pip install -r requirements.txt
   python main.py
   ```
3. **Frontend Setup:**
   ```bash
   cd frontend
   npm install
   npm run dev
   ```

## Development Conventions

### Code Style
- **TypeScript:** Strict typing preferred. Avoid `any` where possible (though currently used in some worker interfaces).
- **SQL:** All schema changes must be added to `frontend/src/db/schema.ts`. Use PGlite-compatible PostgreSQL syntax.
- **AI Prompts:** Located in `backend/extraction.py`. Follow the JSON-only response patterns.

### Local-First Data Flow
- PDFs are stored as Blobs in IndexedDB via `pdf-store.ts`.
- Extracted data is stored in PGlite.
- The UI should always reflect the current state of the database via Zustand listeners.

### Testing
- Backend tests: `backend/test_groq.py`, `backend/scratch_test_medium.py`.
- Frontend validation: Use the "Dev" tab in the application for testing OCR and AI extraction on specific pages.

## Key Files
- `frontend/src/db/schema.ts`: Foundational PGlite schema.
- `frontend/src/store/extraction-store.ts`: Core application state and extraction pipeline logic.
- `backend/extraction.py`: AI extraction prompts and processing logic.
- `backend/main.py`: FastAPI route definitions.
- `frontend/src/workers/db.worker.ts`: PGlite worker lifecycle.
- `frontend/src/services/db-service.ts`: Primary DB interaction layer.
