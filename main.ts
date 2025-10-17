#! /usr/bin/env -S deno run --allow-read --allow-env --allow-net --allow-run=glow,bun

import { relative, resolve } from '@std/path'
import { walk } from '@std/fs/walk'
import { Command, ValidationError } from '@cliffy/command'
import $ from '@david/dax'
import { query } from '@anthropic-ai/claude-agent-sdk'

export interface Doc {
  relPath: string
  content: string
  head: string
  headings: string
}

function getIndex(dir: string): Promise<Doc[]> {
  const files = walk(dir, { includeDirs: false, exts: ['md', 'adoc'] })
  return Array.fromAsync(files, async ({ path }) => {
    const content = await Deno.readTextFile(path)
    const relPath = relative(dir, path)
    const headingPattern = path.endsWith('.adoc') ? /^=+\s+.*/gm : /^#+\s+.*/gm
    const headings = (content.match(headingPattern)?.map((h) => h.trim()) || []).join('\n')
    const head = content.slice(0, 800)
    return { relPath, content, head, headings }
  })
}

const outlineXml = (doc: Doc, baseDir: string) =>
  $.dedent`
    <document>
      <path>${doc.relPath}</path>
      <fullPath>${resolve(baseDir, doc.relPath)}</fullPath>
      <sections>${doc.headings}</sections>
      <head>${doc.head}</head>
    </document>`

const modelMap: Record<string, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-3-5-sonnet-20241022',
}

function resolveModel(modelInput: string): string {
  return modelMap[modelInput.toLowerCase()] || modelInput
}

function makeSystemPrompt(targetDir: string) {
  return $.dedent`
  You are a documentation assistant. Answer the user's question based on the documentation corpus.

  IMPORTANT: All tool operations (Read, Grep, Glob) should use the path parameter set to: ${targetDir}

  Below is an index of all available documents with their structure and
  previews. Use the Read tool to access full document contents when needed, or use
  Grep to search across files. Always specify path="${targetDir}" when using these tools.

  Guidelines:
  * Give a focused answer. The user can look up more detail if necessary.
  * If you cannot find the answer in the documentation, say so. You may speculate, but be clear that you are doing so.
  * Write naturally in prose. Do not overuse markdown headings and bullets.
  * Your answer must be in markdown format.
  * This is a one-time answer, not a chat, so don't prompt for followup questions.
  * Read only the documents you need - avoid reading all documents unless necessary.
`
}

/////////////////////////////
// DISPLAY HELPERS
/////////////////////////////

const RENDERER = 'glow'
async function renderMd(md: string, raw = false) {
  if ($.commandExistsSync(RENDERER) && Deno.stdout.isTerminal() && !raw) {
    await $`${RENDERER}`.stdinText(md)
  } else {
    console.log(md)
  }
}

/////////////////////////////
// QUERY PROCESSING
/////////////////////////////

async function runQuery(prompt: string, model: string, targetDir: string): Promise<string> {
  let finalAnswer = ''

  for await (
    const event of query({
      prompt,
      options: {
        model: resolveModel(model),
        executable: 'bun',
        // without this it doesn't have permissions to read anything
        additionalDirectories: [targetDir],
      },
    })
  ) {
    if (event.type === 'result') {
      // Extract text from result message
      if ('result' in event) {
        finalAnswer = event.result
      }
    }

    if (event.type === 'assistant') {
      // Track assistant responses and log tool calls
      if ('message' in event) {
        const msg = event.message
        if (msg && typeof msg === 'object' && 'content' in msg) {
          const content = msg.content as Array<
            { type: string; name?: string; input?: unknown; text?: string }
          >
          const textContent = content.find((c) => c.type === 'text')
          if (textContent?.text) {
            finalAnswer = textContent.text
          }

          // Log tool calls
          const toolUses = content.filter((c) => c.type === 'tool_use')
          for (const tool of toolUses) {
            if (tool.name) {
              const input = tool.input as Record<string, unknown>
              let details = ''

              if (tool.name === 'Grep') {
                details = ` pattern="${input.pattern}" glob="${input.glob || '*'}"${
                  input['-i'] ? ' case-insensitive' : ''
                }`
              } else if (tool.name === 'Read') {
                const filePath = input.file_path as string
                details = ` ${filePath.split('/').pop()}`
              } else if (tool.name === 'Glob') {
                details = ` pattern="${input.pattern}"`
              } else if (tool.name === 'Bash') {
                const cmd = (input.command as string)?.split('\n')[0]
                details = ` ${cmd}`
              }

              console.log(`${tool.name}${details}`)
            }
          }
        }
      }
    }

    // Log user messages (tool results)
    if (event.type === 'user') {
      if ('message' in event) {
        const msg = event.message
        if (msg && typeof msg === 'object' && 'content' in msg) {
          const content = msg.content as Array<{
            type: string
            content?: string | Array<{ type: string; text?: string }>
            tool_use_id?: string
            is_error?: boolean
          }>
          const toolResults = content.filter((c) => c.type === 'tool_result')
          for (const result of toolResults) {
            let preview = '(empty)'
            if (result.content) {
              if (typeof result.content === 'string') {
                preview = result.content.split('\n')[0]?.substring(0, 60)
              } else if (Array.isArray(result.content)) {
                const textBlock = result.content.find((c) => c.type === 'text')
                preview = textBlock?.text?.split('\n')[0]?.substring(0, 60) || '(empty)'
              }
            }

            // Show full error messages
            if (
              result.is_error || preview.includes('error') || preview.includes('permission')
            ) {
              if (typeof result.content === 'string') {
                console.log(`  ← ERROR: ${result.content}`)
              } else if (Array.isArray(result.content)) {
                const textBlock = result.content.find((c) => c.type === 'text')
                if (textBlock?.text) {
                  console.log(`  ← ERROR: ${textBlock.text}`)
                }
              } else {
                console.log(`  ${preview}`)
              }
            } else {
              console.log(`  ${preview}`)
            }
          }
        }
      }
    }
  }

  return finalAnswer
}

/////////////////////////////
// DO THE THING
/////////////////////////////

await new Command()
  .name('rgd')
  .description(`LLM-only RAG Q&A based on a directory of text files`)
  .example('', "rgd ~/repos/helix/book/src 'turn off automatic bracket insertion'")
  .helpOption('-h, --help', 'Show help')
  .option('-m, --model <model>', 'Model to use (haiku or sonnet)', { default: 'haiku' })
  .arguments('<directory> <...query>')
  .action(async ({ model }, dir, ...qParts) => {
    const userQuery = qParts.join(' ')
    if (!userQuery) throw new ValidationError('query is required')

    // Resolve directory path (handles ~ and makes absolute)
    const targetDir = resolve(dir.replace(/^~/, Deno.env.get('HOME') || '~'))

    const index = await getIndex(targetDir)
    const indexXml = index.map((doc) => outlineXml(doc, targetDir)).join('\n')

    const prompt = `${
      makeSystemPrompt(targetDir)
    }\n\n<document-index>\n${indexXml}\n</document-index>\n\nUser question: ${userQuery}`

    const finalAnswer = await runQuery(prompt, model, targetDir)

    if (finalAnswer) {
      await renderMd(finalAnswer)
    }
  })
  .parse(Deno.args)
