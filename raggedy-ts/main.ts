import { parseArgs } from 'jsr:@std/cli@1.0/parse-args'
import { relative } from 'jsr:@std/path@1.0'
import { walk } from 'jsr:@std/fs@1.0/walk'

interface Doc {
  relPath: string
  content: string
  head: string
  headings: string[]
}

function getIndex(dir: string): Promise<Doc[]> {
  const files = walk(dir, { includeDirs: false, exts: ['md', 'adoc'] })
  return Array.fromAsync(files, async ({ path }) => {
    const content = await Deno.readTextFile(path)
    const relPath = relative(dir, path)
    const headingPattern = path.endsWith('.adoc') ? /^=+\s+.*/gm : /^#+\s+.*/gm
    const headings = content.match(headingPattern)?.map((h) => h.trim()) || []
    const head = content.slice(0, 500)
    return { relPath, content, head, headings }
  })
}

if (import.meta.main) {
  const args = parseArgs(Deno.args)

  const dir = String(args._[0])
  if (!dir) throw new Error('Please provide a directory path')

  const index = await getIndex(dir)
  console.log(JSON.stringify(index, null, 2))
}
