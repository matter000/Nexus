/**
 * ══════════════════════════════════════════════════════════════════════════
 *  Logo Design — Pixel Spider
 * ══════════════════════════════════════════════════════════════════════════
 *
 *  16×16 pixel grid compressed to 8 terminal rows via half-block characters.
 *  Single solid color (#0E76B0), no gradients, no shadows, no strokes.
 *  Pure silhouette — top-down symmetrical spider.
 *
 *  Layout:
 *    • Small cephalothorax at top-center
 *    • Large oval abdomen in the middle
 *    • 8 thick legs with knee bends radiating outward
 *    • Centered composition, sharp pixel edges
 *
 *  Half-block chars: ▀(top only) ▄(bottom only) █(both) ' '(neither)
 * ═══════════════════════════════════════════════════════════════════════════
 */

import React from 'react'
import { Box, Text } from 'ink'
import { theme } from '../theme'

/**
 * 16×16 pixel grid — pixel spider
 * 1 = spider body & legs (single color #0E76B0)
 * 0 = empty (transparent)
 */
const LOGO_GRID: number[][] = [
    [0,0,0,1,1,0,0,0,0,0,0,0,0,1,1,0,0,0,0],
    [0,0,0,1,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0],
    [0,0,0,1,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0],
    [1,1,0,1,0,0,0,0,1,0,1,0,0,0,1,0,1,1,0],
    [0,1,0,1,1,0,0,1,1,1,1,1,0,0,1,0,1,0,0],
    [0,1,0,0,1,0,0,1,1,1,1,1,0,1,0,0,1,0,0],
    [0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0],
    [0,0,0,0,0,0,0,1,1,1,1,1,0,0,0,0,0,0,0],
    [0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0],
    [0,0,1,1,1,0,1,1,1,1,1,1,1,0,1,1,1,0,0],
    [0,1,1,0,0,1,1,1,1,1,1,1,1,1,0,0,1,1,0],
    [1,0,0,0,1,0,1,1,1,1,1,1,1,0,1,0,0,0,1],
    [1,0,0,1,0,0,1,1,1,1,1,1,1,0,0,1,0,0,1],
    [0,0,0,1,0,0,0,0,1,1,1,0,0,0,0,1,0,0,0],
    [0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0],

]

/** Half-block rendering: compress 16 pixel rows → 8 terminal rows */
function LogoPixelArt() {
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
                char = '█'
                color = theme.logo.spider
              } else if (topFilled) {
                char = '▀'
                color = theme.logo.spider
              } else if (botFilled) {
                char = '▄'
                color = theme.logo.spider
              } else {
                char = ' '
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
