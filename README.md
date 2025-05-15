# raggedy

Command-line utility written in TypeScript (Deno) for aggressively simple RAG
on a directory of Markdown or AsciiDoc files. Instead of vector embeddings or
a traditional search index for retrieval, we generate an outline of all the
documents on the fly and simply ask the LLM which documents are relevant to the
question. This works quite well for small corpora.

https://github.com/user-attachments/assets/0f27bd02-7d03-41f0-b3a4-48fe17dd5495

## Setup

### Prerequisites

- [Deno](https://docs.deno.com/runtime/manual) (required)
- [`glow`](https://github.com/charmbracelet/glow) (terminal markdown renderer)
  - If `glow` is not present, the script will just `console.log` raw markdown to the terminal
- Gemini API key in `GEMINI_API_KEY`

### Installation

1. Clone this repo or just download `main.ts` and `llm.ts` next to each other
1. `chmod +x main.ts` so it's executable

At this point you just need some way of executing the script with
`GEMINI_API_KEY` set. The way I do this is a bash script at
`~/.local/bin/rgd` that looks like this, where `.llm-env` contains
lines that look like `export GEMINI_API_KEY=xxxxx`.

```sh
#!/bin/bash

source ~/.llm-env
~/repos/raggedy/main.ts "$@"
```

If you already have your API keys exported all the time, you could make do with
a simple alias `alias rgd='~/repos/raggedy/main.ts'`.

Then I use it like this:

```console
$ rgd ~/repos/jj/docs 'How do I create a merge commit with 4 parents'
```
