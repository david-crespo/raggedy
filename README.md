# raggedy

Command-line utility written in TypeScript (Deno) for aggressively simple RAG on
a directory of Markdown or AsciiDoc files. Instead of vector embeddings or a
traditional search index for retrieval, we generate an outline of all the
documents on the fly and simply ask the LLM which documents are relevant to the
question. This works quite well for small corpora.
