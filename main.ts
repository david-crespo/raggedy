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

const moneyFmt = Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 5,
})

function formatToolCall(name: string, input: Record<string, unknown>): string {
  if (name === 'Grep') {
    return `${name} pattern="${input['pattern']}" glob="${input['glob'] ?? '*'}"${
      input['-i'] ? ' -i' : ''
    }`
  }
  if (name === 'Read') {
    return `${name} ${String(input['file_path'] ?? '').split('/').pop() || ''}`
  }
  if (name === 'Glob') return `${name} pattern="${input['pattern']}"`
  if (name === 'Bash') return `${name} ${(String(input['command'] || '').split('\n')[0])}`
  return name
}

function summarizeToolResult(name: string, out: unknown): string | null {
  if (!out || typeof out !== 'object') return null
  if (name === 'Bash') {
    return String((out as any).output ?? '').split('\n')[0]?.slice(0, 60) || '(empty)'
  }
  if (name === 'Read') {
    return String((out as any).content ?? '').split('\n')[0]?.slice(0, 60) || '(empty)'
  }
  if (name === 'Grep') {
    return Array.isArray((out as any).matches)
      ? `matches: ${(out as any).matches.length}`
      : null
  }
  return null
}

async function runQuery(prompt: string, model: string, targetDir: string): Promise<string> {
  const result = await query({
    prompt,
    options: {
      model: resolveModel(model),
      executable: 'bun',
      additionalDirectories: [targetDir],
      hooks: {
        PreToolUse: [{
          hooks: [async (input) => {
            const name = (input as any).tool_name as string
            const args = (input as any).tool_input as Record<string, unknown>
            console.log(formatToolCall(name, args))
            return { continue: true }
          }],
        }],
        PostToolUse: [{
          hooks: [async (input) => {
            const name = (input as any).tool_name as string
            const out = (input as any).tool_response
            const line = summarizeToolResult(name, out)
            if (line) console.log('  ' + line)
            return { continue: true }
          }],
        }],
      },
      stderr: (data) => Deno.stderr.writeSync(new TextEncoder().encode(data)),
    },
  })

  // The SDK already computes cumulative usage and cost for the session.
  if ((result as any).usage) {
    const u = (result as any).usage as {
      input_tokens: number
      output_tokens: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    }
    const parts = [
      `${u.input_tokens} in`,
      `${u.output_tokens} out`,
      `${u.cache_creation_input_tokens ?? 0} cache write`,
      `${u.cache_read_input_tokens ?? 0} cache read`,
    ]
    const cost = Number((result as any).total_cost_usd ?? 0)
    console.log(`\nTokens: ${parts.join(' + ')}\nCost:   ${moneyFmt.format(cost)}`)
  }
  return (result as any).result ?? ''
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

    const answer = await runQuery(prompt, model, targetDir)

    // TODO: get something more like this and render it with in the `renderMd`
    // `sonnet-4.5`  | 8.6 s | $0.00588 | Tokens: 371 -> 318

    await renderMd('---\n\n' + answer)
  })
  .parse(Deno.args)
