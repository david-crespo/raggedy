#! /usr/bin/env -S deno run --allow-read --allow-env --allow-net --allow-run=glow,bun

import { relative, resolve } from '@std/path'
import { walk } from '@std/fs/walk'
import { Command, ValidationError } from '@cliffy/command'
import $ from '@david/dax'
import {
  type PostToolUseHookInput,
  type PreToolUseHookInput,
  query,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk'

export interface Doc {
  relPath: string
  content: string
  head: string
  headings: string
}

// TODO: fill this out, I don't think it's right
interface ToolResponse {
  output?: string
  content?: string
  matches?: unknown[]
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

  Below is an index of all available documents. Use the Read tool to access
  document contents when needed, or use Grep to search across files. Always
  specify path="${targetDir}" when using these tools.

  Guidelines:
  * Say what document you found the answer in.
  * Give a focused answer. The user can look up more detail if necessary.
  * If you cannot find the answer in the documentation, say so. You may speculate, but be clear that you are doing so.
  * Write naturally in prose. Do not overuse markdown headings and bullets.
  * Your answer must be in markdown format.
  * This is a one-time answer, not a chat, so don't prompt for followup questions.
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

function formatToolCall(
  { tool_name: name, tool_input }: PreToolUseHookInput,
  targetDir: string,
): string {
  const toolInput = tool_input as Record<string, unknown>
  if (name === 'Grep') {
    return `${name} pattern="${toolInput.pattern}" glob="${toolInput.glob ?? '*'}"${
      toolInput['-i'] ? ' -i' : ''
    }`
  }
  if (name === 'Read') {
    const filePath = String(toolInput.file_path ?? '')
    const relPath = filePath.startsWith(targetDir)
      ? relative(targetDir, filePath)
      : filePath.split('/').pop() || ''
    return `${name} ${relPath}`
  }
  if (name === 'Glob') return `${name} pattern="${toolInput.pattern}"`
  if (name === 'Bash') {
    return `${name} ${(String(toolInput.command || '').split('\n')[0])}`
  }
  return name
}

function summarizeToolResult(
  { tool_name: name, tool_response }: PostToolUseHookInput,
): string | null {
  if (!tool_response || typeof tool_response !== 'object') return null
  const response = tool_response as ToolResponse
  if (name === 'Bash') {
    return String(response.output ?? '').split('\n')[0]?.slice(0, 60) || '(empty)'
  }
  if (name === 'Read') {
    // don't print anything, the first line isn't useful anyway
    // return String(response.content ?? '').split('\n')[0]?.slice(0, 60) || '(empty)'
  }
  if (name === 'Grep') {
    return Array.isArray(response.matches) ? `matches: ${response.matches.length}` : null
  }
  return null
}

async function runQuery(prompt: string, model: string, targetDir: string): Promise<string> {
  const startTime = performance.now()
  const stream = query({
    prompt,
    options: {
      model: resolveModel(model),
      executable: 'bun',
      additionalDirectories: [targetDir],
      hooks: {
        PreToolUse: [{
          hooks: [(input) => {
            if (input.hook_event_name === 'PreToolUse') {
              const msg = formatToolCall(input, targetDir)
              console.log(msg)
            }
            return Promise.resolve({})
          }],
        }],
        PostToolUse: [{
          hooks: [(input) => {
            if (input.hook_event_name === 'PostToolUse') {
              const line = summarizeToolResult(input)
              if (line) console.log('  ' + line)
            }
            return Promise.resolve({})
          }],
        }],
      },
      // stderr: (data) => Deno.stderr.writeSync(new TextEncoder().encode(data)),
    },
  })

  // Consume the stream to get the final result
  let resultMessage: SDKMessage | undefined
  for await (const message of stream) {
    if (message.type === 'result') {
      resultMessage = message
    }
  }

  // The SDK already computes cumulative usage and cost for the session.
  if (resultMessage?.type === 'result' && resultMessage.subtype === 'success') {
    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1)
    const u = resultMessage.usage
    const cost = resultMessage.total_cost_usd

    const tokenParts = [`I: ${u.input_tokens}`]
    if (u.cache_creation_input_tokens) {
      tokenParts.push(`W: ${u.cache_creation_input_tokens}`)
    }
    if (u.cache_read_input_tokens) tokenParts.push(`R: ${u.cache_read_input_tokens}`)
    const tokens = `${tokenParts.join(', ')} -> ${u.output_tokens}`

    const meta = `\`${model}\` | ${elapsed} s | ${moneyFmt.format(cost)} | ${tokens}`
    return meta + '\n\n' + resultMessage.result
  }

  return ''
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

    await renderMd(answer)
  })
  .parse(Deno.args)
