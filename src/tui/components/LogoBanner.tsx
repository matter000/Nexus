/**
 * ══════════════════════════════════════════════════════════════════════════
 *  Logo Design Specification v4 — Microchip with glowing N
 * ══════════════════════════════════════════════════════════════════════════
 *
 *  Microchip processor top-down view with glowing "N" core,
 *  chip pins on all four sides, circuit traces radiating outward.
 *  15×15 pixel grid compressed to 8 terminal rows via half-block chars.
 *
 *  Color Legend:
 *    0 = empty (transparent / dark navy background)
 *    1 = chip body border       → electric blue #0088FF
 *    2 = circuit traces         → medium blue   #0066CC
 *    3 = chip pins/legs         → steel blue    #4A90D9
 *    4 = glowing "N" letter     → neon cyan     #00FFFF
 *    5 = corner accent nodes    → bright cyan   #00E5FF
 *
 *  Grid: 15×15 pixels, rendered as 8 terminal rows via ▀/▄/█/space
 * ═══════════════════════════════════════════════════════════════════════════
 */

import React from 'react'
import { Box, Text } from 'ink'
import { theme } from '../theme'

/**
 * 15×15 pixel grid — microchip processor top-down view
 * Symmetric layout: pins(3) → traces(2) → body(1) → N letter(4) → nodes(5)
 * Rendered with half-block chars: ▀(top only) ▄(bottom only) █(both) ' '(neither)
 */
const LOGO_GRID: number[][] = [
  // 0  1  2  3  4  5  6  7  8  9 10 11 12 13 14
  [0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0], // row 0:  top pin tips
  [0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0], // row 1:  top pin mid
  [0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0], // row 2:  top pin base
  [0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0], // row 3:  circuit traces
  [0, 5, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 3, 5, 0], // row 4:  body top + side pins
  [0, 0, 2, 1, 4, 4, 0, 0, 0, 0, 4, 1, 2, 0, 0], // row 5:  N top bar
  [0, 0, 2, 1, 4, 0, 4, 0, 0, 0, 4, 1, 2, 0, 0], // row 6:  N diagonal step 1
  [0, 0, 2, 1, 4, 0, 0, 4, 0, 0, 4, 1, 2, 0, 0], // row 7:  N diagonal step 2
  [0, 0, 2, 1, 4, 0, 0, 0, 4, 0, 4, 1, 2, 0, 0], // row 8:  N diagonal step 3
  [0, 0, 2, 1, 4, 0, 0, 0, 0, 4, 4, 1, 2, 0, 0], // row 9:  N bottom bar
  [0, 5, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 3, 5, 0], // row 10: body bottom + side pins
  [0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0], // row 11: circuit traces
  [0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0], // row 12: bottom pin base
  [0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0], // row 13: bottom pin mid
  [0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0], // row 14: bottom pin tips
]

/** Pixel color map — references theme.logo palette */
const COLORS: Record<number, string> = {
  1: theme.logo.body,      // electric blue — chip body border
  2: theme.logo.trace,     // medium blue — circuit traces
  3: theme.logo.pin,       // steel blue — chip pins/legs
  4: theme.logo.glow,      // neon cyan — glowing "N" core
  5: theme.logo.node,      // bright cyan — corner accent nodes
}

/**
 * Half-block rendering: compress 15 pixel rows → 8 terminal rows
 * Pairs rows (0,1), (2,3), ..., (12,13), then row 14 alone as upper half
 * Uses ▀ (upper half), ▄ (lower half), █ (both filled), ' ' (empty)
 */
function LogoPixelArt() {
  const BLOCK_FULL = '█'
  const BLOCK_UPPER = '▀'
  const BLOCK_LOWER = '▄'
  const EMPTY = ' '

  const ROWS = LOGO_GRID.length
  const terminalRows = Math.ceil(ROWS / 2)

  return (
    <Box flexDirection="column">
      {Array.from({ length: terminalRows }, (_, y) => {
        const topRow = LOGO_GRID[y * 2]
        const botRow = LOGO_GRID[y * 2 + 1] ?? new Array(topRow.length).fill(0)
        return (
          <Box key={y}>
            {topRow.map((topCell, x) => {
              const botCell = botRow[x]
              const topFilled = topCell !== 0
              const botFilled = botCell !== 0
              let char: string
              let color: string | undefined
              if (topFilled && botFilled) {
                char = BLOCK_FULL
                color = COLORS[topCell] ?? COLORS[botCell]
              } else if (topFilled) {
                char = BLOCK_UPPER
                color = COLORS[topCell]
              } else if (botFilled) {
                char = BLOCK_LOWER
                color = COLORS[botCell]
              } else {
                char = EMPTY
                color = undefined
              }
              return (
                <Text key={x} color={color}>
                  {char}
                </Text>
              )
            })}
          </Box>
        )
      })}
    </Box>
  )
}

interface LogoBannerProps {
  version?: string
  model?: string
  projectRoot?: string
}

export function LogoBanner({ version = '0.1.0', model, projectRoot }: LogoBannerProps) {
  const dirName = projectRoot ? projectRoot.split(/[\\/]/).pop() || projectRoot : ''

  return (
    <Box flexDirection="row" paddingX={1} marginBottom={1}>
      {/* 左侧：像素 Logo */}
      <Box>
        <LogoPixelArt />
      </Box>
      {/* 右侧：文字信息 */}
      <Box flexDirection="column" flexGrow={1} paddingLeft={2}>
        <Box gap={2}>
          <Text bold color={theme.colors.primary}>NEXUS</Text>
          <Text color={theme.colors.muted}>v{version}</Text>
        </Box>
        <Text color={theme.colors.muted} dimColor>Terminal Coding Agent</Text>
        {/* 项目信息 */}
        {dirName && (
          <Box marginTop={1}>
            <Text color={theme.colors.muted}>[DIR] {dirName}</Text>
            {model && (
              <>
                <Text color={theme.colors.muted}>  ·  </Text>
                <Text color={theme.colors.muted}>[AI] {model}</Text>
              </>
            )}
          </Box>
        )}
        {/* 使用提示 */}
        <Box marginTop={1}>
          <Text color={theme.colors.muted} dimColor>
            输入任务描述开始，或使用 /help 查看命令
          </Text>
        </Box>
      </Box>
    </Box>
  )
}
