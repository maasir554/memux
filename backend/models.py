from pydantic import BaseModel
from typing import List, Optional, Any, Dict

class FieldSchema(BaseModel):
    name: str
    type: str          # TEXT, NUMERIC, DATE, BOOLEAN
    description: str   # what this field represents

class ChunkData(BaseModel):
    data: Dict[str, Any]   # the raw JSON entry (one row/record)
    text_summary: str      # natural language summary of this chunk

class TableExtraction(BaseModel):
    table_name: str
    summary: str                    # what this table is about
    notes: str                      # extra context or caveats
    schema_fields: List[FieldSchema]  # field definitions with types + descriptions
    chunks: List[ChunkData]         # each row as a separate chunk
    updated_schema_fields: Optional[List[FieldSchema]] = None # if table is continued and schema improved
    updated_notes: Optional[str] = None                       # if table is continued and notes improved

class ExtractionRequest(BaseModel):
    text: str
    previous_tables: Optional[List[Dict[str, Any]]] = None

class ExtractionResponse(BaseModel):
    tables: List[TableExtraction]
    debug_info: Optional[Dict[str, str]] = None

class SqlQueryRequest(BaseModel):
    user_query: str
    table_schema: Dict[str, Any]

class SqlQueryResponse(BaseModel):
    sql: str

class PdfSummaryRequest(BaseModel):
    page_texts: List[str]  # text from first 1-2 pages

class PdfSummaryResponse(BaseModel):
    title: str
    summary: str

class EmbedRequest(BaseModel):
    texts: List[str]

class EmbedResponse(BaseModel):
    embeddings: List[List[float]]

class RagRequest(BaseModel):
    user_query: str
    context_chunks: List[Dict]
    conversation: Optional[List[Dict[str, str]]] = None

class RagResponse(BaseModel):
    response: str
    used_chunk_ids: List[str]
    debug_info: Optional[Dict[str, Any]] = None


class RagQueryTermsRequest(BaseModel):
    user_query: str
    conversation: Optional[List[Dict[str, str]]] = None

class RagQueryTermsResponse(BaseModel):
    search_terms: List[str]
    debug_info: Optional[Dict[str, Any]] = None

class ShortlistChunk(BaseModel):
    id: str
    text_summary: str

class ShortlistRequest(BaseModel):
    user_query: str
    candidates: List[ShortlistChunk]

class ShortlistEvaluation(BaseModel):
    id: str
    to_keep: bool

class ShortlistResponse(BaseModel):
    evaluations: List[ShortlistEvaluation]
    debug_info: Optional[Dict[str, Any]] = None

class BookmarkRestructureChunkRequest(BaseModel):
    current_chunk: Dict[str, Any]
    refined_previous_chunk: Optional[Dict[str, Any]] = None

class BookmarkRestructureChunkResponse(BaseModel):
    refined_chunk: Dict[str, Any]
