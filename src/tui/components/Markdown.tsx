/**
 * 终端 Markdown 渲染组件
 * 轻量级行解析器，支持代码块、标题、粗体、列表、内联代码
 * 流式安全：未闭合的代码块暂时渲染为普通文本（避免闪烁）
 */

import React from 'react'
import { Box, Text } from 'ink'

interface MarkdownProps {
  content: string
  /** 是否处于流式输入中（未闭合代码块不做特殊渲染） */
  streaming?: boolean
}

type Block =
  | { type: 'code'; lang: string; lines: string[] }
  | { type: 'heading'; level: number; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'paragraph'; lines: string[] }
  | { type: 'blank' }

/** 将 Markdown 文本解析为块结构 */
function parseBlocks(content: string, streaming: boolean): Block[] {
  const lines = content.split('\n')
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // 代码块开始
    if (line.trimStart().startsWith('```')) {
      const lang = line.trimStart().slice(3).trim()
      const codeLines: string[] = []
      i++
      let closed = false
      while (i < lines.length) {
        if (lines[i].trimStart().startsWith('```')) {
          closed = true
          i++
          break
        }
        codeLines.push(lines[i])
        i++
      }
      // 流式模式下未闭合的代码块仍渲染为代码块（带提示）
      if (!closed && streaming) {
        blocks.push({ type: 'code', lang: lang || '...', lines: codeLines })
      } else {
        blocks.push({ type: 'code', lang, lines: codeLines })
      }
      continue
    }

    // 标题
    const headingMatch = line.match(/^(#{1,4})\s+(.+)/)
    if (headingMatch) {
      blocks.push({ type: 'heading', level: headingMatch[1].length, text: headingMatch[2] })
      i++
      continue
    }

    // 空行
    if (line.trim() === '') {
      blocks.push({ type: 'blank' })
      i++
      continue
    }

    // 列表（连续的同类型列表项合并）
    const unorderedMatch = line.match(/^(\s*)[-*]\s+(.+)/)
    const orderedMatch = line.match(/^(\s*)\d+\.\s+(.+)/)
    if (unorderedMatch || orderedMatch) {
      const ordered = !!orderedMatch
      const items: string[] = []
      while (i < lines.length) {
        const um = lines[i].match(/^(\s*)[-*]\s+(.+)/)
        const om = lines[i].match(/^(\s*)\d+\.\s+(.+)/)
        if (um && !ordered) {
          items.push(um[2])
          i++
        } else if (om && ordered) {
          items.push(om[2])
          i++
        } else {
          break
        }
      }
      blocks.push({ type: 'list', ordered, items })
      continue
    }

    // 普通段落（连续非空行合并）
    const paraLines: string[] = []
    while (i < lines.length && lines[i].trim() !== '' && !lines[i].trimStart().startsWith('```') && !lines[i].match(/^#{1,4}\s/) && !lines[i].match(/^\s*[-*]\s+/) && !lines[i].match(/^\s*\d+\.\s+/)) {
      paraLines.push(lines[i])
      i++
    }
    if (paraLines.length > 0) {
      blocks.push({ type: 'paragraph', lines: paraLines })
    }
  }

  return blocks
}

/** 渲染内联格式（粗体 + 内联代码） */
function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const parts: React.ReactNode[] = []
  // 匹配 **bold** 和 `code`
  const regex = /(\*\*(.+?)\*\*)|(`([^`]+)`)/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  let key = 0

  while ((match = regex.exec(text)) !== null) {
    // 前面的普通文本
    if (match.index > lastIndex) {
      parts.push(<Text key={`${keyPrefix}-${key++}`}>{text.slice(lastIndex, match.index)}</Text>)
    }

    if (match[2]) {
      // 粗体
      parts.push(<Text key={`${keyPrefix}-${key++}`} bold>{match[2]}</Text>)
    } else if (match[4]) {
      // 内联代码
      parts.push(<Text key={`${keyPrefix}-${key++}`} color="yellow" backgroundColor="#1a1a2e">{match[4]}</Text>)
    }

    lastIndex = match.index + match[0].length
  }

  // 尾部普通文本
  if (lastIndex < text.length) {
    parts.push(<Text key={`${keyPrefix}-${key++}`}>{text.slice(lastIndex)}</Text>)
  }

  return parts.length > 0 ? parts : [<Text key={`${keyPrefix}-full`}>{text}</Text>]
}

export function Markdown({ content, streaming = false }: MarkdownProps) {
  const blocks = parseBlocks(content, streaming)

  return (
    <Box flexDirection="column">
      {blocks.map((block, i) => {
        switch (block.type) {
          case 'code':
            return (
              <Box key={i} flexDirection="column" marginY={0}>
                {block.lang && block.lang !== '...' && (
                  <Text color="gray" dimColor>{`  [${block.lang}]`}</Text>
                )}
                <Box borderStyle="single" borderColor="gray" paddingLeft={1} paddingRight={1}>
                  <Box flexDirection="column">
                    {block.lines.map((line, j) => (
                      <Text key={j} color="green">{line || ' '}</Text>
                    ))}
                  </Box>
                </Box>
              </Box>
            )

          case 'heading':
            return (
              <Box key={i} marginTop={i > 0 ? 1 : 0}>
                <Text bold color="cyan">
                  {'#'.repeat(block.level)} {renderInline(block.text, `h${i}`)}
                </Text>
              </Box>
            )

          case 'list':
            return (
              <Box key={i} flexDirection="column">
                {block.items.map((item, j) => (
                  <Box key={j} paddingLeft={1}>
                    <Text color="gray">{block.ordered ? `${j + 1}.` : '•'}</Text>
                    <Text> {renderInline(item, `li${i}-${j}`)}</Text>
                  </Box>
                ))}
              </Box>
            )

          case 'paragraph':
            return (
              <Box key={i} flexDirection="column">
                {block.lines.map((line, j) => (
                  <Text key={j}>{renderInline(line, `p${i}-${j}`)}</Text>
                ))}
              </Box>
            )

          case 'blank':
            return <Box key={i} height={1} />

          default:
            return null
        }
      })}
    </Box>
  )
}
