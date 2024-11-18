# raggedy

Command-line utility for aggressively simple RAG on a directory of Markdown or
AsciiDoc files. Instead of using vector embeddings or traditional indexing for
retrieval, we generate an outline of all the documents and simply ask a fast LLM
which documents are relevant to the question.
