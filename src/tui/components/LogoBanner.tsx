/**
 * ══════════════════════════════════════════════════════════════════════════
 *  Logo Design — Pixel Node Graph (faithful to the Canvas spec)
 * ══════════════════════════════════════════════════════════════════════════
 *
 *  Same topology as the Canvas mark — four square corner nodes, a larger
 *  center hub, four diagonal links — adapted for the terminal:
 *
 *    • Terminal cells are ~1:2 (width:height) and half-block characters
 *      split each row vertically, so 1 character = 1 pixel already gives
 *      SQUARE pixels (no horizontal doubling — that flattens the mark).
 *    • Links are 2px thick (staircased 2×2 blocks) so they survive
 *      half-block compression as solid, connected diagonals.
 *
 *  Single solid color (#4DA3FF), no gradients, no shadows, no strokes.
 *
 *  Banner composition follows the Canvas welcome screen: centered logo,
 *  spaced wordmark, tagline, version line, capability list, command hints.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { Box, Text } from 'ink'
import React from 'react'
import { theme } from '../theme'

/**
 * 21×19 pixel grid — node graph mark with square pixels.
 * Corner nodes 4×4 · center hub 5×5 · links 2px thick.
 * 1 = mark pixels (single color #4DA3FF), 0 = empty.
 */
const LOGO_GRID: number[][] = [
  [1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1],
  [1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1],
  [1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1],
  [1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1],
  [0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0],
  [0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0],
  [0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0],
  [1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1],
  [1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1],
  [1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1],
  [1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1],
]

/**
 * Half-block rendering, 1 character per pixel:
 * with ~1:2 terminal cells, each pixel is square (1 char wide, ½ row tall).
 */
function LogoMark() {
  const terminalRows = Math.ceil(LOGO_GRID.length / 2)

  return (
    <Box flexDirection="column">
      {Array.from({ length: terminalRows }, (_, y) => {
        const topRow = LOGO_GRID[y * 2]
        const botRow = LOGO_GRID[y * 2 + 1] ?? new Array(topRow.length).fill(0)
        let line = ''
        for (let x = 0; x < topRow.length; x++) {
          const topFilled = topRow[x] !== 0
          const botFilled = botRow[x] !== 0
          line += topFilled && botFilled ? '█' : topFilled ? '▀' : botFilled ? '▄' : ' '
        }
        return (
          <Text key={`logo-${y}`} color={theme.logo.mark}>
            {line}
          </Text>
        )
      })}
    </Box>
  )
}

/** Capability list, matching the Canvas welcome screen copy */
const CAPABILITIES: string[] = [
  'Reads, edits and refactors your codebase',
  'Runs shell commands — always with your approval',
  'Plans multi-step tasks with a visible checklist',
  'Git-aware diffs, commits and code review',
]

/** 欢迎屏示例任务（按 1/2/3 填入输入框，降低新用户启动成本） */
const EXAMPLES: Array<{ key: string; text: string }> = [
  { key: '1', text: '分析项目结构并生成一份 README 文档' },
  { key: '2', text: '运行测试并修复所有失败用例' },
  { key: '3', text: '检查代码质量（lint）并修复发现的问题' },
]

interface LogoBannerProps {
  version?: string
  model?: string
  projectRoot?: string
  /** 示例任务选择回调（App 层填入输入框） */
  onPickExample?: (text: string) => void
  /** 紧凑模式：终端高度不足时隐藏能力清单与示例任务（首帧不溢出视口） */
  compact?: boolean
}

export function LogoBanner({
  version = '0.1.0',
  model,
  projectRoot,
  onPickExample,
  compact = false,
}: LogoBannerProps) {
  const dirName = projectRoot ? projectRoot.split(/[\\/]/).pop() || projectRoot : ''

  return (
    <Box flexDirection="column" alignItems="center" paddingX={1} marginBottom={1}>
      {/* 像素 Logo（居中） */}
      <LogoMark />

      {/* 字标 */}
      <Box marginTop={1}>
        <Text bold color={theme.colors.primary}>
          N E X U S
        </Text>
      </Box>
      <Text color={theme.colors.muted}>the coding agent that lives in your terminal</Text>

      {/* 版本 · 模型 · 目录 */}
      <Box marginTop={1}>
        <Text color={theme.colors.accent}>
          V{version}
          {model ? ` · ${model}` : ''}
          {dirName ? ` · ${dirName}` : ''}
        </Text>
      </Box>

      {/* 能力清单（compact 模式隐藏） */}
      {!compact && (
        <Box flexDirection="column" marginTop={1}>
          {CAPABILITIES.map((cap) => (
            <Box key={cap}>
              <Text color={theme.colors.primary}>▪ </Text>
              <Text color={theme.colors.fg}>{cap}</Text>
            </Box>
          ))}
        </Box>
      )}

      {/* 命令提示 */}
      <Box marginTop={1}>
        <Text color={theme.colors.muted} dimColor>
          /help · /model · /config · /cost · /clear
        </Text>
      </Box>

      {/* 示例任务（按 1/2/3 填入输入框；compact 模式隐藏） */}
      {!compact && (
        <Box flexDirection="column" marginTop={2}>
          <Text color={theme.colors.muted} dimColor>
            ── 试试这些（按 1/2/3 选择）──
          </Text>
          {EXAMPLES.map((ex) => (
            <Box key={ex.key}>
              <Text color={theme.colors.accent} bold>
                {ex.key})
              </Text>
              <Text> {ex.text}</Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  )
}
